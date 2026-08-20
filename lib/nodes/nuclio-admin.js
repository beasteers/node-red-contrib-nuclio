const { deployFunction } = require('../nuclio-deploy');
const { getStatus } = require('../nuclio-reconcile');
const { getInvocationUrls } = require('../nuclio-invocation-urls');
const { getClient } = require('../nuclio-client');
const { redactPaths } = require('../util');


// Admin routes for the Node-RED editor. The route wiring stays separate from
// node construction; operational dependencies are injected by the entrypoint.
module.exports = function(RED) {
    const resolveFunctionNode = (node) => {
        if (!node) return null;
        if (node.type === 'nuclio-function') return node;
        if (node.type === 'nuclio') return node.function || null;
        return node;
    };

    const nodeRequest = (func, description) => async (req, res) => {
        const { id } = req.query;
        const node = RED.nodes.getNode(id);
        const functionNode = resolveFunctionNode(node);
        if (!functionNode) return res.status(404).send(`Node "${id}" not found`);
        if (functionNode.configError) {
            return res.status(400).send({ error: functionNode.configErrorReason || 'Configuration error' });
        }

        try {
            return await func(functionNode, req, res);
        } catch (err) {
            if (err?.code === 'ENOTFOUND') functionNode.warn(`Error ${description || ''}: ${err.code} ${err.hostname}`);
            else functionNode.warn(`Error ${description || ''}: ${err?.code || ''} ${err.message || err}`);
            if (err.response) return res.status(err.response?.status).send(err.response?.data);
            return res.status(500).send(err.message || err);
        }
    };

    const redactFunctionData = (node, data) => redactPaths(data, node.secretVarPaths);

    const pick = (source, keys) => Object.fromEntries(
        keys.filter(key => source && source[key] !== undefined)
            .map(key => [key, source[key]])
    );

    // The editor polls this view frequently. Keep it deliberately small: the
    // full spec and build logs are available through their lazy detail views.
    const functionStatusView = (data, view, node) => {
        if (!view || view === 'full') return data;

        const status = data?.status || {};
        if (view === 'summary') {
            return {
                status: pick(status, [
                    'state', 'internalInvocationUrls', 'externalInvocationUrls',
                    'replicas', 'availableReplicas', 'readyReplicas',
                    'desiredReplicas', 'error', 'message', 'reason',
                ]),
                metadata: pick(data?.metadata, ['name', 'namespace', 'labels']),
                spec: pick(data?.spec, ['runtime', 'handler', 'minReplicas', 'maxReplicas']),
                invocation: {
                    preference: node?.server?.invocationUrlPreference || 'service',
                    urls: getInvocationUrls(data, node),
                },
            };
        }
        if (view === 'logs') return { logs: status.logs || [] };
        if (view === 'spec') return { metadata: data?.metadata, spec: data?.spec };
        return null;
    };

    RED.httpAdmin.get('/nuclio/api/functions', RED.auth.needsPermission('flows.read'), nodeRequest(async (node, req, res) => {
        const r = await getStatus(node);
        const data = functionStatusView(r?.data, req.query.view || 'full', node);
        if (!data) return res.status(400).send({ error: `Unknown function view "${req.query.view}"` });
        return res.status(r.status).send(redactFunctionData(node, data));
    }, 'getting function status'));

    RED.httpAdmin.post('/nuclio/api/functions/deploy', RED.auth.needsPermission('flows.write'), nodeRequest(async (node, req, res) => {
        if (node.server?.deploymentEnabled === false) {
            return res.status(409).send({
                error: 'Function deployment is disabled for this Nuclio server',
            });
        }
        await deployFunction(node, { force: true, rebuild: req.query.rebuild === 'true' });
        try {
            const r = await getClient(node).getFunction(node.name);
            return res.status(r.status).send(redactFunctionData(node, r.data));
        } catch (err) {
            // Nuclio may accept the deploy before the function becomes
            // readable. Treat that window as an accepted asynchronous deploy;
            // the existing status poller will surface the eventual state.
            if (err.response?.status !== 404) throw err;
            return res.status(202).send({
                accepted: true,
                metadata: { name: node.name },
                status: { state: 'building' },
            });
        }
    }, 'during manually-triggered redeploy'));

    RED.httpAdmin.get('/nuclio/api/functions/logs', RED.auth.needsPermission('flows.read'), nodeRequest(async (node, req, res) => {
        const client = getClient(node);
        const r = await client.getReplicas(node.name);
        const replicas = r.data?.names;
        const results = await Promise.allSettled((replicas || []).map(replica => client.getLogs(node.name, replica)));
        const logs = results.reduce((acc, result, index) => {
            const log = result.status === 'fulfilled' ? result.value?.data : (result.reason?.message || `${result.reason}`);
            if (log) acc[replicas[index]] = log;
            return acc;
        }, {});
        return res.status(200).send(logs);
    }, 'getting function logs'));
};
