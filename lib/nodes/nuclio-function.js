const yaml = require('js-yaml');
const { reconcileLoop } = require('../nuclio-reconcile');
const { asString, boolSetting, nestedAssign, normalizeConfigPath, numSetting } = require('../util');
const SOURCE_TYPES = new Set(['sourceCode', 'image', 'git', 'archive', 'advanced']);

const normalizeSourceType = sourceType => sourceType === 'github' ? 'git' : sourceType;

const inferSourceType = (configData) => {
    if (configData?.spec?.image) return 'image';
    const codeEntryType = normalizeSourceType(configData?.spec?.build?.codeEntryType);
    if (codeEntryType) return SOURCE_TYPES.has(codeEntryType) ? codeEntryType : 'advanced';
    if (configData?.spec?.build?.path) return 'advanced';
    return 'sourceCode';
};

const applySourceConfig = (configData, config, credentials = {}) => {
    const spec = configData.spec = { ...(configData.spec || {}) };
    const build = spec.build = { ...(spec.build || {}) };
    const existingBuild = { ...build };
    const existingAttributes = { ...(existingBuild.codeEntryAttributes || {}) };
    const normalizedSourceType = normalizeSourceType(config.sourceType);
    const sourceType = SOURCE_TYPES.has(normalizedSourceType) ? normalizedSourceType : inferSourceType(configData);
    const hasExplicitSourceType = Object.prototype.hasOwnProperty.call(config, 'sourceType');
    const sourcePath = Object.prototype.hasOwnProperty.call(config, 'codeEntryPath')
        ? config.codeEntryPath || ''
        : existingBuild.path || '';
    const sourceBranch = Object.prototype.hasOwnProperty.call(config, 'codeEntryBranch')
        ? config.codeEntryBranch || ''
        : existingAttributes.branch || '';
    const sourceTag = Object.prototype.hasOwnProperty.call(config, 'codeEntryTag')
        ? config.codeEntryTag || ''
        : existingAttributes.tag || '';
    const sourceReference = Object.prototype.hasOwnProperty.call(config, 'codeEntryReference')
        ? config.codeEntryReference || ''
        : existingAttributes.reference || '';
    const sourceUsername = Object.prototype.hasOwnProperty.call(config, 'codeEntryUsername')
        ? config.codeEntryUsername || ''
        : existingAttributes.username || '';
    const sourceWorkDir = Object.prototype.hasOwnProperty.call(config, 'codeEntryWorkDir')
        ? config.codeEntryWorkDir || ''
        : existingAttributes.workDir || '';

    // Legacy flows have no source selector fields. Preserve their raw YAML
    // exactly, including source types that this editor does not expose yet.
    if ((sourceType === 'sourceCode' || sourceType === 'advanced') && !hasExplicitSourceType) return sourceType;

    // Advanced source configurations are owned entirely by the YAML editor.
    // Do not clear fields belonging to a newer or unsupported Nuclio source.
    if (sourceType === 'advanced') return sourceType;

    // The source selector owns these mutually exclusive fields. Removing stale
    // fields is important when a function changes from inline code/image to a
    // repository source, because Nuclio gives them precedence over one another.
    delete spec.image;
    delete build.functionSourceCode;
    delete build.codeEntryType;
    delete build.path;
    delete build.codeEntryAttributes;

    if (sourceType === 'image') {
        spec.image = sourcePath;
        return sourceType;
    }

    if (sourceType === 'git' || sourceType === 'archive') {
        build.codeEntryType = sourceType;
        build.path = sourcePath;
        const attributes = {};
        if (sourceType === 'git' && sourceBranch) attributes.branch = sourceBranch;
        if (sourceType === 'git' && sourceTag) attributes.tag = sourceTag;
        if (sourceType === 'git' && sourceReference) attributes.reference = sourceReference;
        if (sourceType === 'git' && sourceUsername) attributes.username = sourceUsername;
        if (sourceWorkDir) attributes.workDir = sourceWorkDir;
        const password = credentials.password || existingAttributes.password || '';
        if (sourceType === 'git' && password) attributes.password = password;
        if (Object.keys(attributes).length) build.codeEntryAttributes = attributes;
        return sourceType;
    }

    return sourceType;
};

module.exports = function(RED) {
    // Secrets live in Node-RED's encrypted credential store as a JSON list of
    // { name, type, value }. Flows saved before 1.2 stored them as a plain node
    // property - fall back so existing flows keep working until re-saved.
    const getSecretVars = (node, config) => {
        try {
            if (node.credentials?.secret_vars) {
                const parsed = JSON.parse(node.credentials.secret_vars);
                return Array.isArray(parsed) ? parsed : [];
            }
        } catch (err) {
            node.warn(`Could not parse stored secrets, ignoring them: ${err.message}`);
        }
        return Array.isArray(config.secret_vars) ? config.secret_vars : [];
    };

    const getConfig = (node, config, secretVars = getSecretVars(node, config)) => {
        const configData = yaml.load(config.configCode || '{}') || {};
        if (typeof configData !== 'object' || Array.isArray(configData)) {
            throw new Error('Function config YAML must contain an object at its root');
        }

        for (const entry of secretVars) {
            if (!entry || typeof entry !== 'object') continue;
            const { name, value, type } = entry;
            if (!name) continue;
            nestedAssign(configData, name, RED.util.evaluateNodeProperty(value, type, node));
        }

        const sourceType = applySourceConfig(configData, config, {
            password: node.credentials?.codeEntryPassword || node.credentials?.codeEntryToken || '',
        });

        return {
            name: config.name,
            runtime: config.runtime || 'python:3.12',
            // External sources and images must never carry the online editor's
            // code, otherwise Nuclio will select functionSourceCode first.
            code: sourceType === 'sourceCode' ? config.code || '' : '',
            config: configData,
            project: node.project?.name,
            address: node.server?.address,
            env: (Array.isArray(config.env_vars) ? config.env_vars : [])
                .filter(entry => entry && typeof entry === 'object' && entry.name)
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
            name: 'default',
        };

        node.configError = false;
        node.configErrorReason = '';
        let secretVars = [];
        const fixedSecretPaths = [
            'spec.build.codeEntryAttributes.password',
            'spec.build.codeEntryAttributes.headers.Authorization',
        ];
        try {
            secretVars = getSecretVars(node, config);
            // Keep only paths, never duplicate secret values on the node. These
            // paths are used to redact admin responses before they leave Node-RED.
            node.secretVarPaths = [
                ...secretVars
                    .filter(entry => entry && typeof entry === 'object' && entry.name)
                    .map(({ name }) => normalizeConfigPath(name)),
                ...fixedSecretPaths,
            ];
        } catch {
            node.secretVarPaths = fixedSecretPaths;
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

        node.maxSelfHealAttempts = numSetting(RED, node, config, 'maxSelfHealAttempts', 5);
        node.redeployDeadlineMs  = numSetting(RED, node, config, 'redeployDeadlineMs', 120000);
        node.autoRedeployOnError = boolSetting(RED, node, config, 'autoRedeployOnError', false);

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
            codeEntryPassword: { type: 'password' },
            // Legacy credential retained so old flows can be loaded and migrated.
            codeEntryToken: { type: 'password' },
        },
    });
};
