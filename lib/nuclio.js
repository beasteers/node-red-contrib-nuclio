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


    /* ----------------------------- Nuclio Function ---------------------------- */

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

    function NuclioFunctionNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.statusDebounced = debounced((status) => { node.status(status) }, 100, 500);

        /* ------------------------------ Config Nodes ------------------------------ */

        // nuclio config
        node.server = RED.nodes.getNode(config.server) || {
            publicAddress: process.env.NUCLIO_PUBLIC_ADDRESS || "http://localhost:8070",
			address: process.env.NUCLIO_ADDRESS || "http://localhost:8070",
		};
        node.project = RED.nodes.getNode(config.project) || {
            name: process.env.NUCLIO_PROJECT_NAME || "default",
        };

        /* ----------------------------- Function Config ---------------------------- */

        node.configError = false;
        try {
            node.fnConfigSpec = getConfig(node, config);
        } catch (err) {
            node.error(`Invalid Nuclio config YAML: ${err.message}`);
            node.status({ fill: "red", shape: "ring", text: "Invalid config YAML" });
            node.configError = true;
        }
        

        /* ------------------------------- Node State ------------------------------- */

        node.closed = false;
        node.redeploying = false;

        node.counter = 0;
        node.fnInvocationStatus = null;
        node.fnData = null;

        /* ------------------------------- Node Events ------------------------------ */

        node.on("input", async function(msg, send, done) {
            let error;
            if (node.urls?.invocation) {
                const startTime = Date.now();
                let response;
                node.counter++;
                try {
                    response = await axios.post(node.urls.invocation, msg.payload, { headers: { 'Content-Type': 'application/json' }, timeout: INVOCATION_TIMEOUT_MS });
                    node.counter--;

                    msg.payload = response.data;

                    node.fnInvocationStatus = response.status;
                    node.statusDebounced({ fill: "green", shape: "dot", text: node.counter > 1 ? `${node.counter}` : '' });
                } catch (err) {
                    error = err;
                    response = err?.response;
                    node.counter--;

                    node.fnInvocationStatus = response?.status || err?.code;
                    if (!node.redeploying) {
                        node.error(`${response?.data || err?.message || 'Invocation error'}`, err);
                        node.statusDebounced({ fill: "red", shape: "dot", text: `${node.fnInvocationStatus} ${node.counter > 1 ? `${node.counter}` : ''}` });
                    }
                }

                msg.requestTime = Date.now() - startTime;
                if (response) {
                    msg.statusCode = response?.status;
                    msg.statusText = response?.statusText;
                    msg.headers = response?.headers;
                    msg.response = response;
                }
            } else {
                node.fnInvocationStatus = null;
                if (!node.redeploying) {
                    node.statusDebounced({ fill: "yellow", shape: "ring", text: `No Endpoint` });
                }
            }

            if (done) done();
            if (error) {
                return send([null, msg]);
            }
            else {
                return send([msg, null]);
            }
        });

        node.on("close", function() {
            node.closed = true;
            if (node.reconcileTimer) {
                clearTimeout(node.reconcileTimer);
                node.reconcileTimer = null;
            }
        });

        /* ---------------------------- Start Reconcile ----------------------------- */

        (async () => {
            await deployFunction(node);
            await reconcileLoop(node);
        })();
    }
    RED.nodes.registerType("nuclio", NuclioFunctionNode);





















    /* -------------------------------------------------------------------------- */
    /*                                  Endpoints                                 */
    /* -------------------------------------------------------------------------- */

    const nodeRequest = (func, description) => async (req, res) => {
        // Get node from id in query param
        const { id } = req.query;
        const node = RED.nodes.getNode(id);//id ? RED.nodes.getNode(id) : RED.nodes.getNode(name);
        if (!node) return res.status(404).send(`Node "${id}" not found`);
        // Call the function with the node
        try {
            return await func(node, req, res);
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
        if (node.configError) return res.status(400).send({ error: 'Invalid config YAML' });
        // Get function data
        let r = await getStatus(node);
        return res.status(r.status).send(r?.data);
    }, 'getting function status'));

    /* ----------------------- Manually Redeploy Function ----------------------- */

    RED.httpAdmin.post(`/nuclio/api/functions/deploy`, RED.auth.needsPermission('flows.write'), nodeRequest(async (node, req, res) => {
        if (node.configError) return res.status(400).send({ error: 'Invalid config YAML' });
        // Redeploy function
        await deployFunction(node, { force: true });
        let r = await nuclioGet(node, `/api/functions/${node.name}`);
        return res.status(r.status).send(r.data);
    }, 'during manually-triggered redeploy'));

    /* ------------------------------ Get Function Logs ------------------------- */

    RED.httpAdmin.get(`/nuclio/api/functions/logs`, RED.auth.needsPermission('flows.read'), nodeRequest(async (node, req, res) => {
        if (node.configError) return res.status(400).send({ error: 'Invalid config YAML' });
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
