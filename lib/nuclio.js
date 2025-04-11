const axios = require('axios');
const yaml = require('js-yaml');
const { deployFunction, reconcileLoop, reconcileStep } = require('./nuclio-api');
const { debounced } = require('./util');

const asString = (value) => {
    if (typeof value === 'string') return value;
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function splitByDotWithEscape(str) {
    return str.split(/(?<!\\)\./).map(part => part.replace(/\\\./g, '.'));
}

module.exports = function(RED) {


    /* -------------------------------------------------------------------------- */
    /*                                Config Nodes                                */
    /* -------------------------------------------------------------------------- */

    /* ------------------------------ Nuclio Server ----------------------------- */

    function NuclioServer(config) {
        RED.nodes.createNode(this, config);
        this.address = RED.util.evaluateNodeProperty(config.address, config.addressType, this);
        this.publicAddress = RED.util.evaluateNodeProperty(config.publicAddress, config.publicAddressType, this) || this.address;
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

    function NuclioFunctionNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

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

        // function config
        const name = config.name;
        const runtime = config.runtime || 'python:3.11';

        // source code
        const code = config.code || '';
        const configCode = config.configCode || '';
        const configData = configCode ? yaml.load(configCode) : {};

        // get environment variables
        const env = (config.env_vars || []).map(({ name, value, type }) => ({ name, value: asString(RED.util.evaluateNodeProperty(value, type, node)) })).filter(({ name }) => name);        

        // get secret variables from env/credentials
        for (const { name, value, type } of (config.secret_vars || [])) {
            if (!name) continue;
            const keys = splitByDotWithEscape(name);
            const lastKey = keys.pop();
            let c = configData;
            for (const key of keys) {
                if (!c[key]) c[key] = {};
                c = c[key];
            }
            c[lastKey] = RED.util.evaluateNodeProperty(value, type, node);
        }

        
        node.fnConfigSpec = {
            name,
            runtime,
            code,
            config: configData,
            project: node.project?.name,
            address: node.server?.address,
            env,
            annotations: {
                'nuclio.io/node-red': 'true',
                'nuclio.io/node-red-node-id': node.id,
                'nuclio.io/node-red-version': `${RED.settings.version}`,
            },
        }

        /* ------------------------------- Node State ------------------------------- */

        node.closed = false;
        node.statusDebounced = debounced((status) => { node.status(status) }, 100, 500);
        node.counter = 0;

        reconcileLoop(node);

        /* ------------------------------- Node Events ------------------------------ */

        node.on("input", async function(msg, send, done) {
            if (node.urls?.invocation) {
                const startTime = Date.now();
                try {
                    node.counter++;
                    const result = await axios.post(node.urls.invocation, msg.payload, { headers: { 'Content-Type': 'application/json' } });
                    node.counter--;
                    node.fnInvocationStatus = result.status;
    
                    msg.requestTime = Date.now() - startTime;
                    msg.payload = result.data;
                    msg.statusCode = result.status;
                    msg.statusText = result.statusText;
                    msg.headers = result.headers;
                    msg.response = result;
    
                    node.statusDebounced({ fill: "green", shape: "dot", text: node.counter > 1 ? `${node.counter}` : '' });
                    return send([msg, null]);
                } catch (err) {
                    const result = err?.response || {
                        status: err?.code || 500,
                        statusText: err?.message || 'Unknown error',
                        headers: err?.headers || {},
                        data: err?.response?.data || err?.message,
                    };
                    node.counter--;
                    node.fnInvocationStatus = err?.response?.status || err?.code;

                    msg.requestTime = Date.now() - startTime;
                    msg.payload = result.data;
                    msg.statusCode = result.status;
                    msg.statusText = result.statusText;
                    msg.headers = result.headers;
                    msg.response = result;
                    msg.error = err;

                    if (!node.redeploying) {
                        node.error(err);
                        // console.error("Function invocation error:", node.name, err?.code, err?.response?.status);//, err?.response?.data
                        // console.error("Function invocation error:", node.name, err?.code, err?.response?.status, err?.response?.data);
                        node.statusDebounced({ fill: "red", shape: "dot", text: `${node.fnInvocationStatus} ${node.counter > 1 ? `${node.counter}` : ''}` });
                    }
                }
            } else {
                // console.error(`NUCLIO Error: Function "${node.name}" has no url.`);
                // node.statusDebounced({ fill: "yellow", shape: "ring", text: `No URL yet.` });
            }
            return send([null, msg]);
        });

        node.on("close", function() {
            node.closed = true;
        });
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

    /* --------------------------- Get Function Status -------------------------- */

    RED.httpAdmin.get(`/nuclio/api/functions`, RED.auth.needsPermission('flows.read'), nodeRequest(async (node, req, res) => {
        // Get function data
        reconcileStep(node);
        return res.status(200).send(node.fnData);
    }, 'getting function status'));

    /* ----------------------- Manually Redeploy Function ----------------------- */

    RED.httpAdmin.post(`/nuclio/api/functions/deploy`, RED.auth.needsPermission('flows.write'), nodeRequest(async (node, req, res) => {
        // Redeploy function
        await deployFunction(node, { force: true });
        let r = await axios.get(`${node.server.address}/api/functions/${node.name}`, { headers: { 'Content-Type': 'application/json' } });
        return res.status(r.status).send(r.data);
    }, 'during manually-triggered redeploy'));

    /* ------------------------------ Get Function Logs ------------------------- */

    RED.httpAdmin.get(`/nuclio/api/functions/logs`, RED.auth.needsPermission('flows.read'), nodeRequest(async (node, req, res) => {
        // Get function replica names
        let r = await axios.get(`${node.server.address}/api/functions/${node.name}/replicas`, { headers: { 'Content-Type': 'application/json' } });
        const replicas = r.data?.names;

        // Get logs for each replica
        let logs = await Promise.allSettled((replicas||[]).map(async (replica) => {
            return await axios.get(`${node.server.address}/api/functions/${node.name}/logs/${replica}?follow=false&tailLines=70`);
        }));
        logs = logs.reduce((acc, r, i) => {
            if (r.status === 'fulfilled') r = { replica: replicas[i], logs: r.data };
            if (r.status === 'rejected') r = { replica: replicas[i], logs: r.reason };
            if (r.logs) acc[r.replica] = r.logs;
            return acc;
        }, {});
        return res.status(200).send(logs);
    }, "getting function logs"));


};
