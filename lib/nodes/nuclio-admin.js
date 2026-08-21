const { deployFunction } = require('../nuclio-deploy');
const { getStatus, getOrphans, pruneOrphan, summarizeFunction } = require('../nuclio-status');
const { getInvocationUrls } = require('../nuclio-invocation-urls');
const { getClient } = require('../nuclio-client');
const { redactPaths } = require('../util');

const STATUS_SNAPSHOT_MAX_AGE_MS = 10000;

const dashboardError = (err) => {
    if (Number.isInteger(err?.response?.status)) {
        return `Nuclio dashboard returned HTTP ${err.response.status}`;
    }
    return `Nuclio dashboard request failed${err?.code ? ` (${err.code})` : ''}`;
};


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
            else functionNode.warn(`Error ${description || ''}: ${dashboardError(err)}`);
            if (Number.isInteger(err?.statusCode)) return res.status(err.statusCode).send({ error: err.message });
            if (err.response) return res.status(err.response.status).send({ error: dashboardError(err) });
            return res.status(502).send({ error: dashboardError(err) });
        }
    };

    const redactFunctionData = (node, data) => redactPaths(data, node.secretVarPaths);

    // The editor polls this view frequently. Keep it deliberately small: the
    // full spec and build logs are available through their lazy detail views.
    const functionStatusView = (data, view, node) => {
        if (!view || view === 'full') return data;

        const status = data?.status || {};
        if (view === 'summary') {
            const summary = summarizeFunction(data);
            return {
                ...summary,
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
        const view = req.query.view || 'full';
        const cached = view === 'summary'
            && node.statusSnapshot
            && Date.now() - (node.statusSnapshotAt || 0) <= STATUS_SNAPSHOT_MAX_AGE_MS;
        const r = cached
            ? { status: 200, data: node.statusSnapshot }
            : await getStatus(node);
        const data = functionStatusView(r?.data, view, node);
        if (!data) return res.status(400).send({ error: `Unknown function view "${req.query.view}"` });
        return res.status(r.status).send(redactFunctionData(node, data));
    }, 'getting function status'));

    RED.httpAdmin.post('/nuclio/api/functions/deploy', RED.auth.needsPermission('flows.write'), nodeRequest(async (node, req, res) => {
        if (node.server?.deploymentEnabled === false) {
            return res.status(409).send({
                error: 'Function deployment is disabled for this Nuclio server',
            });
        }
        const deployOptions = { force: true, rebuild: req.query.rebuild === 'true', wakeReconcile: false };
        await (node.activateDeployment
            ? node.activateDeployment(deployOptions)
            : deployFunction(node, deployOptions));
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

    RED.httpAdmin.get('/nuclio/api/orphans', RED.auth.needsPermission('flows.read'), nodeRequest(async (node, req, res) => {
        return res.status(200).send(await getOrphans(node));
    }, 'discovering orphaned functions'));

    RED.httpAdmin.post('/nuclio/api/orphans/prune', RED.auth.needsPermission('flows.write'), nodeRequest(async (node, req, res) => {
        return res.status(200).send(await pruneOrphan(node, req.query.name));
    }, 'pruning an orphaned function'));
};
