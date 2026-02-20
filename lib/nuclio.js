const axios = require('axios');
const yaml = require('js-yaml');
const { deployFunction } = require('./nuclio-api');
const { reconcileLoop, reconcileStep, refreshStatus, getStatus } = require('./nuclio-reconcile');
const { debounced, parseIntFallback, asString, splitByDotWithEscape, nestedAssign } = require('./util');

const REQUEST_TIMEOUT_MS = parseIntFallback(process.env.NUCLIO_REQUEST_TIMEOUT_MS, 10000);
const INVOCATION_TIMEOUT_MS = parseIntFallback(process.env.NUCLIO_INVOCATION_TIMEOUT_MS, 30000);


module.exports = function(RED) {

    /* -------------------------------------------------------------------------- */
    /*                                Config Nodes                                */
    /* -------------------------------------------------------------------------- */

    /* ------------------------------ Nuclio Server ----------------------------- */

    function NuclioServer(config) {
        RED.nodes.createNode(this, config);
        this.address = RED.util.evaluateNodeProperty(config.address, config.addressType, this);
        this.publicAddress = RED.util.evaluateNodeProperty(config.publicAddress, config.publicAddressType, this);// || this.address
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

    const getConfig = (node, config) => {
        // source code
        let configData = yaml.load(config.configCode || '{}') || {};

        // get secret variables from env/credentials
        for (const { name, value, type } of (config.secret_vars || [])) {
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

        node.childNodes = [];
        node.status = s => node.childNodes.forEach(cn => cn.status(s));

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
            console.log(`Nuclio function config loaded: ${node.fnConfigSpec.name} (${node.fnConfigSpec.runtime})`);
        } catch (err) {
            node.error(`Invalid Nuclio config YAML: ${err.message}`);
            node.status({ fill: "red", shape: "ring", text: "Invalid config YAML" });
            node.configError = true;
            node.configErrorReason = 'Invalid config YAML';
        }
        

        /* ------------------------------- Node State ------------------------------- */

        node.closed = false;
        node.redeploying = false;

        node.counter = 0;
        node.fnInvocationStatus = -1;
        node.fnData = null;

        node.on("close", function() {
            node.closed = true;
            if (node.reconcileTimer) {
                clearTimeout(node.reconcileTimer);
                node.reconcileTimer = null;
            }
        });

        /* ---------------------------- Start Reconcile ----------------------------- */

        if (!node.configError) {
            (async () => {
                // await deployFunction(node);
                await reconcileLoop(node);
            })();
        }
    }
    RED.nodes.registerType("nuclio-function", NuclioFunctionConfig);

    /* ----------------------------- Nuclio Invoke ----------------------------- */

    function NuclioInvokeNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        /* ----------------------------- Node Parameters ---------------------------- */

        node.function = RED.nodes.getNode(config.function);
        node.function && node.function.childNodes.push(node);
        node.headers = config.headers || [];
        node.maxInFlight = Number.parseInt(config.maxInFlight, 10);
        node.timeoutMs = Number.parseInt(config.timeoutMs, 10);
        if (!Number.isFinite(node.maxInFlight)) node.maxInFlight = 0;
        if (!Number.isFinite(node.timeoutMs)) node.timeoutMs = INVOCATION_TIMEOUT_MS;

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
            fnNode.counter++;
            try {
                const headers = buildHeaders(msg);
                response = await axios.post(fnNode.urls.invocation, msg.payload, { headers, timeout: node.timeoutMs });
                msg.payload = response.data;
                
                // Successful invocation, update status
                node.counter--;
                fnNode.counter--;
                fnNode.fnInvocationStatus = response.status;
                if (!fnNode.redeploying) node.statusDebounced({ fill: "green", shape: "dot", text: node.counter > 1 ? `${node.counter}` : '' });
            } catch (err) {
                error = err;
                response = err?.response;
                if (err?.code === 'ECONNREFUSED' || err?.code === 'ECONNABORTED' || err?.code === 'ENOTFOUND') {
                    // console.error(err?.status, err?.code, err);
                    console.error(`Function invocation error[${err?.code}]: ${fnNode.urls?.invocation} ${msg.payload} ${fnNode.fnConfigSpec?.name} ${fnNode.fnState} - ${err.message}`);
                } else {
                    if (!(response?.data || response?.body)) console.error("Function invocation error:", err);
                    node.error(`Function invocation error[${err?.code}]: ${JSON.stringify(response?.data || response?.body)}`, msg);
                }

                // Invocation error, update status
                node.counter--;
                fnNode.counter--;
                fnNode.fnInvocationStatus = response?.status || err?.code;
                if (!fnNode.redeploying) node.statusDebounced({ fill: "red", shape: "dot", text: `${fnNode.fnInvocationStatus || 'error'} ${node.counter > 1 ? `${node.counter}` : ''} ${fnNode.fnConfigSpec?.name}` });
            }

            // Add response details to message
            msg.requestDurationMs = Date.now() - startTime;
            if (response) {
                msg.response = response;
                msg.headers = response?.headers;
                msg.statusCode = response?.status;
                msg.statusText = response?.statusText;
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
        const node = RED.nodes.getNode(id);//id ? RED.nodes.getNode(id) : RED.nodes.getNode(name);
        const functionNode = resolveFunctionNode(node);
        if (!functionNode) return res.status(404).send(`Node "${id}" not found`);
        // Call the function with the node
        try {
            return await func(functionNode, req, res);
        } catch (err) {
            // Handle errors
            if(err?.code === 'ENOTFOUND') console.error(`NUCLIO Error ${description || ''}:`, err.code, err.hostname)
            else console.error(`NUCLIO Error ${description || ''}:`, err?.code, err);
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
            timeout: REQUEST_TIMEOUT_MS 
        });
    }

    /* --------------------------- Get Function Status -------------------------- */

    RED.httpAdmin.get(`/nuclio/api/functions`, RED.auth.needsPermission('flows.read'), nodeRequest(async (node, req, res) => {
        if (node.configError) return res.status(400).send({ error: node.configErrorReason || 'Configuration error' });
        // Get function data
        let r = await getStatus(node);
        return res.status(r.status).send(r?.data);
    }, 'getting function status'));

    // /* ------------------------------ Proxy Dashboard ----------------------------- */

    // RED.httpAdmin.get(`/nuclio/dashboard/*`, RED.auth.needsPermission('flows.read'), nodeRequest(async (node, req, res) => {
    //     const address = node.server?.address;
    //     if (!address) return res.status(400).send('No Nuclio server configured');

    //     const targetUrl = new URL(address);
    //     const path = req.params[0] || '';
    //     const queryIndex = req.url.indexOf('?');
    //     const query = queryIndex >= 0 ? req.url.slice(queryIndex) : '';
    //     targetUrl.pathname = `/${path}`;
    //     targetUrl.search = query;

    //     const headers = { ...req.headers };
    //     delete headers.host;
    //     delete headers.authorization;
    //     delete headers['content-length'];

    //     try {
    //         const response = await axios.get(targetUrl.toString(), {
    //             headers,
    //             responseType: 'stream',
    //             timeout: REQUEST_TIMEOUT_MS,
    //         });
    //         res.status(response.status);
    //         Object.entries(response.headers || {}).forEach(([key, value]) => {
    //             if (key.toLowerCase() === 'transfer-encoding') return;
    //             res.setHeader(key, value);
    //         });
    //         response.data.pipe(res);
    //     } catch (err) {
    //         const status = err.response?.status || 502;
    //         res.status(status).send(err.response?.statusText || err.message);
    //     }
    // }, 'proxying nuclio dashboard'));

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
            if (r.status === 'fulfilled') r = { replica: replicas[i], logs: r.data };
            if (r.status === 'rejected') r = { replica: replicas[i], logs: r.reason };
            if (r.logs) acc[r.replica] = r.logs;
            return acc;
        }, {});
        return res.status(200).send(logs);
    }, "getting function logs"));


};
