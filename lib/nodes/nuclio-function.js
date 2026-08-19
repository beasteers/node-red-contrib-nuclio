const yaml = require('js-yaml');
const { reconcileLoop } = require('../nuclio-reconcile');
const { asString, boolSetting, nestedAssign, numSetting } = require('../util');

module.exports = function(RED) {
    // Secrets live in Node-RED's encrypted credential store as a JSON list of
    // { name, type, value }. Flows saved before 1.2 stored them as a plain node
    // property - fall back so existing flows keep working until re-saved.
    const getSecretVars = (node, config) => {
        try {
            if (node.credentials?.secret_vars) return JSON.parse(node.credentials.secret_vars) || [];
        } catch (err) {
            node.warn(`Could not parse stored secrets, ignoring them: ${err.message}`);
        }
        return config.secret_vars || [];
    };

    const getConfig = (node, config, secretVars = getSecretVars(node, config)) => {
        const configData = yaml.load(config.configCode || '{}') || {};

        for (const { name, value, type } of secretVars) {
            if (!name) continue;
            nestedAssign(configData, name, RED.util.evaluateNodeProperty(value, type, node));
        }

        return {
            name: config.name,
            runtime: config.runtime || 'python:3.12',
            code: config.code || '',
            config: configData,
            project: node.project?.name,
            address: node.server?.address,
            env: (config.env_vars || [])
                .filter(({ name }) => name)
                .map(({ name, value, type }) => ({
                    name,
                    value: asString(RED.util.evaluateNodeProperty(value, type, node)),
                })),
            annotations: {
                'nuclio.io/node-red': 'true',
                'nuclio.io/node-red-node-id': node.id,
                'nuclio.io/node-red-version': `${RED.settings.version}`,
            },
        };
    };

    function NuclioFunctionConfig(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Config nodes have no editor presence - mirror status onto the invoke
        // nodes that use this function and retain the latest status for nodes
        // that register later.
        node.childNodes = [];
        node.lastStatus = null;
        node.status = status => {
            node.lastStatus = status;
            node.childNodes.forEach(child => child.status(status));
        };

        node.server = RED.nodes.getNode(config.server) || null;
        node.project = RED.nodes.getNode(config.project) || {
            name: process.env.NUCLIO_PROJECT_NAME || 'default',
        };

        node.configError = false;
        node.configErrorReason = '';
        let secretVars = [];
        try {
            secretVars = getSecretVars(node, config);
            // Keep only paths, never duplicate secret values on the node. These
            // paths are used to redact admin responses before they leave Node-RED.
            node.secretVarPaths = secretVars.filter(({ name }) => name).map(({ name }) => name);
        } catch {
            node.secretVarPaths = [];
        }
        if (!node.server?.address) {
            node.configError = true;
            node.configErrorReason = 'No server configured';
            node.status({ fill: 'yellow', shape: 'ring', text: 'No server' });
        }
        if (!node.configError) {
            try {
                node.fnConfigSpec = getConfig(node, config, secretVars);
                node.debug(`Nuclio function config loaded: ${node.fnConfigSpec.name} (${node.fnConfigSpec.runtime})`);
            } catch (err) {
                node.error(`Invalid Nuclio config YAML: ${err.message}`);
                node.status({ fill: 'red', shape: 'ring', text: 'Invalid config YAML' });
                node.configError = true;
                node.configErrorReason = 'Invalid config YAML';
            }
        }

        node.maxSelfHealAttempts = numSetting(RED, node, config, 'maxSelfHealAttempts', 'NUCLIO_MAX_SELF_HEAL_ATTEMPTS', 5);
        node.redeployDeadlineMs  = numSetting(RED, node, config, 'redeployDeadlineMs',  'NUCLIO_REDEPLOY_DEADLINE_MS', 120000);
        node.autoRedeployOnError = boolSetting(RED, node, config, 'autoRedeployOnError', process.env.NUCLIO_AUTO_REDEPLOY_ON_ERROR === 'true');

        node.closed = false;
        node.redeploying = false;
        node.selfHealAttempts = 0;
        node.fnInvocationStatus = -1;
        node.lastInvocationAt = 0;
        node.unhealthyStreak = 0;

        node.on('close', function() {
            node.closed = true;
            if (node.reconcileTimer) {
                clearTimeout(node.reconcileTimer);
                node.reconcileTimer = null;
            }
            node.reconcileWake?.();
        });

        const startReconcile = () => {
            if (node.closed || node.configError) return;
            reconcileLoop(node).catch(err => {
                node.error(`Reconcile loop stopped: ${err.message}`);
                if (node.closed) return;
                node.reconcileTimer = setTimeout(startReconcile, node.server.backoffMs);
            });
        };
        startReconcile();
    }

    RED.nodes.registerType('nuclio-function', NuclioFunctionConfig, {
        credentials: {
            secret_vars: { type: 'text' },
        },
    });
};
