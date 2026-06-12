const axios = require('axios');
const yaml = require('js-yaml');
const { deployFunction } = require('./nuclio-api');
const { reconcileLoop, getStatus } = require('./nuclio-reconcile');
const { debounced, parseIntFallback, asString, nestedAssign } = require('./util');

const INVOCATION_TIMEOUT_MS = parseIntFallback(process.env.NUCLIO_INVOCATION_TIMEOUT_MS, 30000);


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

    /* -------------------------------------------------------------------------- */
    /*                                Config Nodes                                */
    /* -------------------------------------------------------------------------- */

    /* ------------------------------ Nuclio Server ----------------------------- */

    function NuclioServer(config) {
        RED.nodes.createNode(this, config);
        this.address = RED.util.evaluateNodeProperty(config.address, config.addressType, this);
        this.publicAddress = RED.util.evaluateNodeProperty(config.publicAddress, config.publicAddressType, this);

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

    const getConfig = (node, config) => {
        // source code
        let configData = yaml.load(config.configCode || '{}') || {};

        // get secret variables from env/credentials
        for (const { name, value, type } of getSecretVars(node, config)) {
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
        node.statusDebounced = debounced((status) => { node.status(status) }, 100, 500);

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
        if (!node.server?.address) {
            node.configError = true;
            node.configErrorReason = 'No server configured';
            node.status({ fill: "yellow", shape: "ring", text: "No server" });
        }
        try {
            node.fnConfigSpec = getConfig(node, config);
            node.debug(`Nuclio function config loaded: ${node.fnConfigSpec.name} (${node.fnConfigSpec.runtime})`);
        } catch (err) {
            node.error(`Invalid Nuclio config YAML: ${err.message}`);
            node.status({ fill: "red", shape: "ring", text: "Invalid config YAML" });
            node.configError = true;
            node.configErrorReason = 'Invalid config YAML';
        }
        

        /* ------------------------------- Node State ------------------------------- */

        // Recovery policy for this function (node config -> NUCLIO_* env -> default).
        node.maxSelfHealAttempts = numSetting(node, config, 'maxSelfHealAttempts', 'NUCLIO_MAX_SELF_HEAL_ATTEMPTS', 5);
        node.redeployDeadlineMs  = numSetting(node, config, 'redeployDeadlineMs',  'NUCLIO_REDEPLOY_DEADLINE_MS', 120000);
        node.autoRedeployOnError = boolSetting(node, config, 'autoRedeployOnError', process.env.NUCLIO_AUTO_REDEPLOY_ON_ERROR === 'true');

        node.closed = false;
        node.redeploying = false;
        node.selfHealAttempts = 0;

        node.counter = 0;
        node.fnInvocationStatus = -1;
        node.fnData = null;

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

        if (!node.configError) {
            reconcileLoop(node).catch(err => node.error(`Reconcile loop stopped: ${err.message}`));
        }
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
            // deregister - with partial deploys the config node can outlive us
            const fn = node.function;
            if (fn?.childNodes) fn.childNodes = fn.childNodes.filter(cn => cn !== node);
        });
        node.headers = config.headers || [];
        node.maxInFlight = parseIntFallback(config.maxInFlight, 0);
        node.timeoutMs = parseIntFallback(config.timeoutMs, INVOCATION_TIMEOUT_MS);

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

        node.on("input", async function(msg, send, done) {
            const fnNode = node.function;

            /* ---------------- Check if Function is Ready to be Invoked ---------------- */

            if (!fnNode) {
                node.statusDebounced({ fill: "yellow", shape: "ring", text: "No function" });
                if (done) done();
                return send([null, msg]);
            }

            if (fnNode.configErrorReason === 'No server configured') {
                node.statusDebounced({ fill: "yellow", shape: "ring", text: "No server" });
                if (done) done();
                return send([null, msg]);
            }

            if (fnNode.redeploying) {
                node.statusDebounced({ fill: "yellow", shape: "ring", text: "Redeploying" });
                if (done) done();
                return send([null, msg]);
            }

            if (fnNode.fnState === 'error') {
                node.statusDebounced({ fill: "yellow", shape: "ring", text: fnNode.fnState || 'Not ready' });
                if (done) done();
                return send([null, msg]);
            }

            if (!fnNode.urls?.invocation) {
                if (done) done();
                return send([null, msg]);
            }

            let error;
            if (node.maxInFlight > 0 && node.counter >= node.maxInFlight) {
                node.statusDebounced({ fill: "yellow", shape: "ring", text: "Backpressure" });
                if (done) done();
                return send([null, msg]);
            }

            /* ----------------------------- Invoke Function ---------------------------- */

            const startTime = Date.now();
            let response;
            node.counter++;
            try {
                const headers = buildHeaders(msg);
                response = await axios.post(fnNode.urls.invocation, msg.payload, { headers, timeout: node.timeoutMs });
                msg.payload = response.data;
                fnNode.fnInvocationStatus = response.status;  // always numeric (HTTP status)
            } catch (err) {
                error = err;
                response = err?.response;
                const detail = response?.data || response?.body;
                if (err?.code === 'ECONNREFUSED' || err?.code === 'ECONNABORTED' || err?.code === 'ENOTFOUND') {
                    // connectivity errors are transient (function scaling/redeploying) - don't trigger Catch nodes
                    node.warn(`Function invocation error[${err?.code}]: ${fnNode.urls?.invocation} ${fnNode.fnConfigSpec?.name} ${fnNode.fnState} - ${err.message}`);
                } else {
                    node.error(`Function invocation error[${err?.code}]: ${detail ? JSON.stringify(detail) : err.message}`, msg);
                }
                fnNode.fnInvocationStatus = response?.status || 0;  // 0 = errored with no HTTP status
            } finally {
                // decrement in finally so the in-flight counter can never leak and jam backpressure
                node.counter--;
                if (!fnNode.redeploying) {
                    const queued = node.counter > 1 ? `${node.counter}` : '';
                    node.statusDebounced(error
                        ? { fill: "red", shape: "dot", text: `${error.code || fnNode.fnInvocationStatus || 'error'} ${queued} ${fnNode.fnConfigSpec?.name}`.trim() }
                        : { fill: "green", shape: "dot", text: queued });
                }
            }

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

            // Send response to output 1, errors to output 2
            if (done) done(error);
            if (error) return send([null, msg]);
            return send([msg, null]);
        });
    }
    RED.nodes.registerType("nuclio", NuclioInvokeNode);


    /* -------------------------------------------------------------------------- */
    /*                                  Endpoints                                 */
    /* ----------------- For use by admin UI - Node Status Page ----------------- */
    /* -------------------------------------------------------------------------- */

    const resolveFunctionNode = (node) => {
        if (!node) return null;
        if (node.type === 'nuclio-function') return node;
        if (node.type === 'nuclio') return node.function || null;
        return node;
    };

    const nodeRequest = (func, description) => async (req, res) => {
        // Get node from id in query param
        const { id } = req.query;
        const node = RED.nodes.getNode(id);
        const functionNode = resolveFunctionNode(node);
        if (!functionNode) return res.status(404).send(`Node "${id}" not found`);
        // Call the function with the node
        try {
            return await func(functionNode, req, res);
        } catch (err) {
            // Handle errors
            if (err?.code === 'ENOTFOUND') functionNode.warn(`Error ${description || ''}: ${err.code} ${err.hostname}`);
            else functionNode.warn(`Error ${description || ''}: ${err?.code || ''} ${err.message || err}`);
            if (err.response) {
                return res.status(err.response?.status).send(err.response?.data);
            } else {
                return res.status(500).send(err.message || err);
            }
        }
    }

    const nuclioGet = (node, path) => {
        return axios.get(`${node.server.address}${path}`, {
            headers: {
                'Content-Type': 'application/json',
                'x-nuclio-project-name': node.project?.name || 'default',
            },
            timeout: node.server.requestTimeoutMs,
        });
    }

    /* --------------------------- Get Function Status -------------------------- */

    RED.httpAdmin.get(`/nuclio/api/functions`, RED.auth.needsPermission('flows.read'), nodeRequest(async (node, req, res) => {
        if (node.configError) return res.status(400).send({ error: node.configErrorReason || 'Configuration error' });
        // Get function data
        let r = await getStatus(node);
        return res.status(r.status).send(r?.data);
    }, 'getting function status'));

    /* ----------------------- Manually Redeploy Function ----------------------- */

    RED.httpAdmin.post(`/nuclio/api/functions/deploy`, RED.auth.needsPermission('flows.write'), nodeRequest(async (node, req, res) => {
        if (node.configError) return res.status(400).send({ error: node.configErrorReason || 'Configuration error' });
        // Redeploy function
        await deployFunction(node, { force: true });
        let r = await nuclioGet(node, `/api/functions/${node.name}`);
        return res.status(r.status).send(r.data);
    }, 'during manually-triggered redeploy'));

    /* ------------------------------ Get Function Logs ------------------------- */

    RED.httpAdmin.get(`/nuclio/api/functions/logs`, RED.auth.needsPermission('flows.read'), nodeRequest(async (node, req, res) => {
        if (node.configError) return res.status(400).send({ error: node.configErrorReason || 'Configuration error' });
        let r = await nuclioGet(node, `/api/functions/${node.name}/replicas`);
        const replicas = r.data?.names;

        let logs = await Promise.allSettled((replicas||[]).map(async (replica) => await nuclioGet(node, `/api/functions/${node.name}/logs/${replica}?follow=false&tailLines=70`)));
        logs = logs.reduce((acc, r, i) => {
            // allSettled wraps results: { status, value } / { status, reason }
            const log = r.status === 'fulfilled' ? r.value?.data : (r.reason?.message || `${r.reason}`);
            if (log) acc[replicas[i]] = log;
            return acc;
        }, {});
        return res.status(200).send(logs);
    }, "getting function logs"));


};
