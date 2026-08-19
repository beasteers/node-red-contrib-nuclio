const yaml = require('js-yaml');
const { deployFunction } = require('./nuclio-api');
const { reconcileLoop, getStatus } = require('./nuclio-reconcile');
const { getInvocationUrls } = require('./nuclio-invocation-urls');
const { getClient } = require('./nuclio-client');
const { invokeWithRetry } = require('./nuclio-invoke');
const { registerAdminRoutes } = require('./nuclio-admin');
const { debounced, parseIntFallback, asString, nestedAssign, redactPaths } = require('./util');

const INVOCATION_TIMEOUT_MS = parseIntFallback(process.env.NUCLIO_INVOCATION_TIMEOUT_MS, 30000);
const INVOKE_RETRIES = parseIntFallback(process.env.NUCLIO_INVOKE_RETRIES, 0);
const INVOKE_RETRY_DELAY_MS = parseIntFallback(process.env.NUCLIO_INVOKE_RETRY_DELAY_MS, 500);

module.exports = function(RED) {

    /* -------------------------------------------------------------------------- */
    /*                              Tuning Resolvers                              */
    /* -------------------------------------------------------------------------- */
    // Each tuning field resolves: node config (literal or env-typed, re-read on every
    // deploy) -> NUCLIO_* process env -> hardcoded default. So a tweak is a Deploy, not
    // a Node-RED restart, and existing env-based setups keep working untouched.

    const numSetting = (node, config, field, envVar, fallback) => {
        const raw = config[field];
        if (raw !== undefined && raw !== null && raw !== '') {
            const v = Number.parseInt(RED.util.evaluateNodeProperty(raw, config[`${field}Type`] || 'num', node), 10);
            if (Number.isFinite(v)) return v;
        }
        return parseIntFallback(process.env[envVar], fallback);
    };

    const boolSetting = (node, config, field, fallback) => {
        const raw = config[field];
        if (raw === undefined || raw === null || raw === '') return fallback;
        const v = RED.util.evaluateNodeProperty(raw, config[`${field}Type`] || 'bool', node);
        return v === true || v === 'true';
    };

    // strip trailing slashes so `${address}/api/...` never builds a double slash
    const stripTrailingSlash = (url) => typeof url === 'string' ? url.replace(/\/+$/, '') : url;

    /* -------------------------------------------------------------------------- */
    /*                                Config Nodes                                */
    /* -------------------------------------------------------------------------- */

    /* ------------------------------ Nuclio Server ----------------------------- */

    function NuclioServer(config) {
        RED.nodes.createNode(this, config);
        this.address = stripTrailingSlash(RED.util.evaluateNodeProperty(config.address, config.addressType, this));
        this.publicAddress = stripTrailingSlash(RED.util.evaluateNodeProperty(config.publicAddress, config.publicAddressType, this));
        const configuredInvocationPreference = config.invocationUrlPreference
            || process.env.NUCLIO_INVOCATION_URL_PREFERENCE;
        this.invocationUrlPreference = ['service', 'internal', 'external'].includes(configuredInvocationPreference)
            ? configuredInvocationPreference
            : 'service';
        this.externalInvocationProtocol = config.externalInvocationProtocol === 'http' ? 'http' : 'https';
        const configuredServiceHost = config.internalInvocationServiceHost
            ? RED.util.evaluateNodeProperty(
                config.internalInvocationServiceHost,
                config.internalInvocationServiceHostType || 'str',
                this,
            )
            : '';
        this.internalInvocationServiceHost = configuredServiceHost
            || process.env.NUCLIO_INTERNAL_INVOCATION_SERVICE_HOST
            || 'nuclio-{function}';

        // Connection + polling cadence shared by every function on this dashboard.
        this.requestTimeoutMs = numSetting(this, config, 'requestTimeoutMs', 'NUCLIO_REQUEST_TIMEOUT_MS', 10000);
        this.deployTimeoutMs  = numSetting(this, config, 'deployTimeoutMs',  'NUCLIO_DEPLOY_TIMEOUT_MS',  60000);
        this.pollMs           = numSetting(this, config, 'pollMs',           'NUCLIO_POLL_MS',             1000);
        this.readyPollMs      = numSetting(this, config, 'readyPollMs',      'NUCLIO_READY_POLL_MS',       5000);
        this.backoffMs        = numSetting(this, config, 'backoffMs',        'NUCLIO_BACKOFF_MS',          5000);
        this.backoffMaxMs     = numSetting(this, config, 'backoffMaxMs',     'NUCLIO_BACKOFF_MAX_MS',     60000);
        this.startStaggerMs   = numSetting(this, config, 'startStaggerMs',   'NUCLIO_START_STAGGER_MS',    2000);
    }
    RED.nodes.registerType("nuclio-config", NuclioServer);

    /* ----------------------------- Nuclio Project ----------------------------- */

    function NuclioProject(config) {
        RED.nodes.createNode(this, config);
        this.name = RED.util.evaluateNodeProperty(config.name, config.nameType, this) || 'default';
    }
    RED.nodes.registerType("nuclio-project", NuclioProject);


    /* -------------------------------------------------------------------------- */
    /*                                    Nodes                                   */
    /* -------------------------------------------------------------------------- */


    /* ------------------------- Nuclio Function Config ------------------------- */

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
        // source code
        let configData = yaml.load(config.configCode || '{}') || {};

        // get secret variables from env/credentials
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
            env: (
                (config.env_vars || [])
                    .filter(({ name }) => name)
                    .map(({ name, value, type }) => ({ name, value: asString(RED.util.evaluateNodeProperty(value, type, node)) }))
            ),
            annotations: {
                'nuclio.io/node-red': 'true',
                'nuclio.io/node-red-node-id': node.id,
                'nuclio.io/node-red-version': `${RED.settings.version}`,
            },
        }
    }

    function NuclioFunctionConfig(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Config nodes have no editor presence - mirror status onto the invoke
        // nodes that use this function. Keep the last status so invoke nodes
        // registering later (they construct after config nodes) still get it.
        node.childNodes = [];
        node.lastStatus = null;
        node.status = s => {
            node.lastStatus = s;
            node.childNodes.forEach(cn => cn.status(s));
        };

        /* ------------------------------ Config Nodes ------------------------------ */

        // nuclio config
        node.server = RED.nodes.getNode(config.server) || null;
        node.project = RED.nodes.getNode(config.project) || {
            name: process.env.NUCLIO_PROJECT_NAME || "default",
        };

        /* ----------------------------- Function Config ---------------------------- */

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
            node.status({ fill: "yellow", shape: "ring", text: "No server" });
        }
        if (!node.configError) {
            try {
                node.fnConfigSpec = getConfig(node, config, secretVars);
                node.debug(`Nuclio function config loaded: ${node.fnConfigSpec.name} (${node.fnConfigSpec.runtime})`);
            } catch (err) {
                node.error(`Invalid Nuclio config YAML: ${err.message}`);
                node.status({ fill: "red", shape: "ring", text: "Invalid config YAML" });
                node.configError = true;
                node.configErrorReason = 'Invalid config YAML';
            }
        }
        

        /* ------------------------------- Node State ------------------------------- */

        // Recovery policy for this function (node config -> NUCLIO_* env -> default).
        node.maxSelfHealAttempts = numSetting(node, config, 'maxSelfHealAttempts', 'NUCLIO_MAX_SELF_HEAL_ATTEMPTS', 5);
        node.redeployDeadlineMs  = numSetting(node, config, 'redeployDeadlineMs',  'NUCLIO_REDEPLOY_DEADLINE_MS', 120000);
        node.autoRedeployOnError = boolSetting(node, config, 'autoRedeployOnError', process.env.NUCLIO_AUTO_REDEPLOY_ON_ERROR === 'true');

        node.closed = false;
        node.redeploying = false;
        node.selfHealAttempts = 0;
        node.fnInvocationStatus = -1;
        node.lastInvocationAt = 0;
        node.unhealthyStreak = 0;

        node.on("close", function() {
            node.closed = true;
            if (node.reconcileTimer) {
                clearTimeout(node.reconcileTimer);
                node.reconcileTimer = null;
            }
            // wake the reconcile loop so it sees `closed` and exits
            node.reconcileWake?.();
        });

        /* ---------------------------- Start Reconcile ----------------------------- */

        // Restart the loop if it ever rejects, so a single unexpected error can't
        // permanently stop reconciliation for this function.
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
    RED.nodes.registerType("nuclio-function", NuclioFunctionConfig, {
        credentials: {
            secret_vars: { type: "text" },  // JSON list of { name, type, value }
        },
    });

    /* ----------------------------- Nuclio Invoke ----------------------------- */

    function NuclioInvokeNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        /* ----------------------------- Node Parameters ---------------------------- */

        node.function = RED.nodes.getNode(config.function);
        if (node.function) {
            node.function.childNodes.push(node);
            // catch up on the function's current status (config nodes construct first)
            if (node.function.lastStatus) node.status(node.function.lastStatus);
        }
        node.on("close", function() {
            node.closed = true;
            // deregister - with partial deploys the config node can outlive us
            const fn = node.function;
            if (fn?.childNodes) fn.childNodes = fn.childNodes.filter(cn => cn !== node);
        });
        node.headers = config.headers || [];
        node.maxInFlight = parseIntFallback(config.maxInFlight, 0);
        node.timeoutMs = parseIntFallback(config.timeoutMs, INVOCATION_TIMEOUT_MS);
        node.retries = parseIntFallback(config.retries, INVOKE_RETRIES);
        node.retryDelayMs = parseIntFallback(config.retryDelayMs, INVOKE_RETRY_DELAY_MS);

        node.statusDebounced = debounced((status) => { node.status(status) }, 100, 500);
        node.counter = 0;

        /* ---------------------------- Request Headers ----------------------------- */

        const buildHeaders = (msg) => {
            const headers = { 'Content-Type': 'application/json' };
            for (const { name, value, type } of (node.headers || [])) {
                if (!name) continue;
                const resolved = RED.util.evaluateNodeProperty(value, type || 'str', node, msg);
                headers[name] = asString(resolved);
            }
            return headers;
        };

        /* ------------------------------- Node Events ------------------------------ */

        const ring = (text) => ({ fill: "yellow", shape: "ring", text });

        node.on("input", async function(msg, send, done) {
            const fnNode = node.function;

            /* ---------------- Check if Function is Ready to be Invoked ---------------- */
            // Not ready? Pass the message through unchanged to the fallback output.

            const drop = (status) => {
                if (status) node.statusDebounced(status);
                if (done) done();
                return send([null, msg]);
            };

            if (!fnNode) return drop(ring("No function"));
            if (fnNode.configErrorReason === 'No server configured') return drop(ring("No server"));
            if (fnNode.redeploying) return drop(ring("Redeploying"));
            if (fnNode.fnState === 'error') return drop(ring(fnNode.fnState || 'Not ready'));
            if (!fnNode.invocationUrl) return drop();
            if (node.maxInFlight > 0 && node.counter >= node.maxInFlight) return drop(ring("Backpressure"));

            /* ----------------------------- Invoke Function ---------------------------- */

            const startTime = Date.now();
            const result = await invokeWithRetry({ node, fnNode, msg, getHeaders: () => buildHeaders(msg) });
            const { error, transientError, response } = result;

            // A close can happen while axios or the retry delay is in flight.
            // Do not emit a message or call done on a node that is shutting down.
            if (node.closed) return;

            // Add response details to message
            msg.requestDurationMs = Date.now() - startTime;
            if (response) {
                msg.response = response;
                msg.headers = response?.headers;
                msg.statusCode = response?.status;
                msg.statusText = response?.statusText;
            }
            // Fallback output carries the error so downstream flows can branch on it
            if (error) {
                msg.error = { message: error.message, code: error.code };
                if (msg.statusCode === undefined) msg.statusCode = error.code;
            }

            // Non-transient errors go to Catch nodes exactly once (transient ones
            // only warned above). Reported after msg is populated so Catch sees
            // the same details the fallback output carries.
            if (error && !transientError) {
                const detail = response?.data || response?.body;
                node.error(`Function invocation error[${error.code}]: ${detail ? JSON.stringify(detail) : error.message}`, msg);
            }

            // Send response to output 1, errors to output 2
            if (error) send([null, msg]);
            else send([msg, null]);
            if (done) done();
        });
    }
    RED.nodes.registerType("nuclio", NuclioInvokeNode);


    registerAdminRoutes(RED, { deployFunction, getStatus, getClient, getInvocationUrls, redactPaths });
};
