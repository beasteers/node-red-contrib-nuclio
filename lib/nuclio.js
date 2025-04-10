const axios = require('axios');
const yaml = require('js-yaml');
const { deployWatchFunction, refreshFunctionStatus, NonDuplicateAsyncFunction, Poller } = require('./nuclio-api');


function getField(node, kind, value) {
    switch (kind) {
        case 'flow':	// Legacy
            return node.context().flow.get(value);
        case 'global':
            return node.context().global.get(value);
        case 'num':
            return parseInt(value);
        case 'bool':
        case 'json':
            return JSON.parse(value);
        case 'env':
            return process.env[value];
        default:
            return value;
    }
}




module.exports = function(RED) {


    /* -------------------------------------------------------------------------- */
    /*                                  Endpoints                                 */
    /* -------------------------------------------------------------------------- */

    const nodeRequest = (func) => async (req, res) => {
        // Get node from id in query param
        const { id } = req.query;
        const node = RED.nodes.getNode(id);//id ? RED.nodes.getNode(id) : RED.nodes.getNode(name);
        if (!node) return res.status(404).send(`Node "${id}" not found`);
        // Call the function with the node
        return await func(node, req, res);
    }

    /* --------------------------- Get Function Status -------------------------- */

    RED.httpAdmin.get(`/nuclio/api/functions`, RED.auth.needsPermission('flows.read'), nodeRequest(async (node, req, res) => {
        try {
            // Get function data
            const [_, func] = await refreshFunctionStatus(node);
            return res.status(200).send(func);
        } catch (err) {
            // Function not found
            if (err.response?.status === 404) {
                // Redeploy function
                node.deployFn.run({force: true, endInterval: 10000});
                return res.status(404).send(`Function "${node.name}" not found. Redeploying...`);
            }

            // Other error
            if(err.code === 'ENOTFOUND') console.error("NUCLIO Error getting function status:", err.code, err.hostname)
            else console.error("NUCLIO Error getting function status:", err.code, err);
            return res.status(err.response?.status || 500).send(err.response?.data || err.message || err);
        }
    }));

    /* ----------------------- Manually Redeploy Function ----------------------- */

    RED.httpAdmin.post(`/nuclio/api/functions/deploy`, RED.auth.needsPermission('flows.write'), nodeRequest(async (node, req, res) => {
        try {
            // Redeploy function
            let r = await node.deployFn.run({force: true});
            if(!r) {
                // Deployed. Get function data
                r = await axios.get(`${node.server.address}/api/functions/${node.name}`, { headers: { 'Content-Type': 'application/json' } });
            }
            return res.status(r.status).send(r.data);
        } catch (err) {
            // Error while deploying
            console.error("Error during manually-triggered redeploy:", err);
            return res.status(err.response?.status || 500).send(err.response?.data || err.message || err);
        }
    }));

    /* ------------------------------ Get Function Logs ------------------------- */

    RED.httpAdmin.get(`/nuclio/api/functions/logs`, RED.auth.needsPermission('flows.read'), nodeRequest(async (node, req, res) => {
        let replicas;
        try {
            // Get function replica names
            let r = await axios.get(`${node.server.address}/api/functions/${node.name}/replicas`, { headers: { 'Content-Type': 'application/json' } });
            replicas = r.data?.names;
            
            // Get logs for each replica
            let logs = await Promise.allSettled((replicas||[]).map(async (replica) => {
                let r = await axios.get(`${node.server.address}/api/functions/${node.name}/logs/${replica}?follow=false&tailLines=70`);
                return { replica, logs: r.data };
            }));
            logs = logs.reduce((acc, r) => {
                if (r.status === 'fulfilled') r = r.value;
                if (r.status === 'rejected') r = { error: r.reason, replica: r.reason?.config?.url.split('/').slice(-2, -1)[0] };
                if (r.logs) acc[r.replica] = r.logs;
                return acc;
            }, {});
            return res.status(200).send(logs);

        } catch (err) {
            // Error while getting logs
            if(err.code === 'ENOTFOUND') console.error("NUCLIO", err.code, err.hostname)
            else console.error("Error getting logs:", err);
            return res.status(err.response?.status || 500).send(err.response?.data || err.message || err);
        }

    }));



    /* -------------------------------------------------------------------------- */
    /*                                    Nodes                                   */
    /* -------------------------------------------------------------------------- */


    /* ----------------------------- Nuclio Function ---------------------------- */

    function NuclioFunctionNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // nuclio config
        node.server = RED.nodes.getNode(config.server) || {
			address: process.env.NUCLIO_ADDRESS || "http://localhost:8070",
		};
        node.project = RED.nodes.getNode(config.project) || {
            name: process.env.NUCLIO_PROJECT_NAME || "default",
        };

        // function config
        const name = config.name;
        const runtime = config.runtime || 'python:3.11';
        const [runtimeBase, runtimeVersion] = runtime.split(':');
        const configCode = config.configCode || '';
        const configData = configCode ? yaml.load(configCode) : {};
        const moduleName = (
            runtimeBase === 'nodejs' ? 'handler' : 'main'
        );
        const funcName = (
            runtimeBase === 'golang' ? 'Handler' : 'handler'
        );
        const handler = `${moduleName}:${funcName}`;
        node.fnConfigSpec = {
            name,
            runtime,
            code: config.code,
            config: configData,
            project: node.project?.name,
            address: node.server?.address,
            handler,
            annotations: {
                'nuclio.io/node-red': 'true',
                'nuclio.io/node-red-version': RED.settings.version,
                'nuclio.io/node-red-node-id': node.id,
            },
        }

        node.deployFn = new NonDuplicateAsyncFunction((p) => deployWatchFunction(node, {...node.fnConfigSpec, ...p}));
        node.deployFn.run();
        node.counter = 0;

        node.statusPoller = new Poller(async () => {
            try {
                return await refreshFunctionStatus(node);
            } catch (err) {
                if(err.code === 'ENOTFOUND') console.error("NUCLIO Error status poller:", err.code, err.hostname)
                else console.error("NUCLIO Error status poller:", err.code, err);
            }
        }, 15000);
        node.statusPoller.start();

        node.on("input", async function(msg, send, done) {
            if (!node.urls?.invocation) {
                return send([null, msg]);
            }
            try {
                node.counter++;
                const result = await axios.post(node.urls.invocation, msg.payload, { headers: { 'Content-Type': 'application/json' } });
                node.counter--;

                msg.payload = result.data;
                msg.statusCode = result.status;
                msg.statusText = result.statusText;
                msg.headers = result.headers;
                msg.response = result;

                node.status({ fill: "green", shape: "dot", text: node.counter > 10 ? `${node.counter}` : '' });
                return send([msg, null]);
            } catch (err) {
                node.counter--;
                msg.error = err;

                if(node.fnState === "ready") {
                    node.error(err);
                    console.error("Function invocation error:", err?.code);
                    console.log(node.urls)

                    // // Function not found
                    // node.status({ fill: "red", shape: "dot", text: node.counter > 10 ? `${node.counter}` : '' });
                    // if(err?.code === 'ECONNREFUSED' || err?.code === 'EHOSTUNREACH' || err?.code === 'ECONNRESET') { // REVIEW
                    //     node.deployFn.run({force: true, endInterval: 10000});
                    // }
                    // else {}
                } else {
                    // if(node.fnState === null) {  // REVIEW
                    //     node.deployFn.run({force: true, endInterval: 10000});
                    // }
                }
            }
            
            return send([null, msg]);
        });

        node.on("close", function() {
            if (node.statusPoller) {
                node.statusPoller.stop();
            }
        });
    }
    RED.nodes.registerType("nuclio", NuclioFunctionNode);



    /* -------------------------------------------------------------------------- */
    /*                                Config Nodes                                */
    /* -------------------------------------------------------------------------- */

    /* ------------------------------ Nuclio Server ----------------------------- */

    function NuclioConfig(config) {
        RED.nodes.createNode(this, config);
        this.address = getField(this, config.addressType, config.address);
        this.publicAddress = getField(this, config.publicAddressType, config.publicAddress) || this.address;
    }
    RED.nodes.registerType("nuclio-config", NuclioConfig);

    /* ----------------------------- Nuclio Project ----------------------------- */

    function NuclioProject(config) {
        RED.nodes.createNode(this, config);
        this.name = getField(this, config.nameType, config.name) || 'default';
    }
    RED.nodes.registerType("nuclio-project", NuclioProject);

};
