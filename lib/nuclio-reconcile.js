const axios = require('axios');
const { deployFunction, BUILDING, WAITING, STATUSES } = require('./nuclio-api');
const { parseIntFallback } = require('./util');

const REQUEST_TIMEOUT_MS = parseIntFallback(process.env.NUCLIO_REQUEST_TIMEOUT_MS, 10000);

const reconcileLoop = async (node) => {
    while (!node.closed) {
        let sleep = await reconcileStep(node);
        if (node.closed) break;
        if (sleep) {
            await new Promise(resolve => {
                node.reconcileTimer = setTimeout(() => {
                    node.reconcileTimer = null;
                    resolve();
                }, sleep);
            });
        }
    }
};

const getStatus = async (node) => {
    const headers = {
        'Content-Type': 'application/json',
        'x-nuclio-project-name': node.project?.name || 'default',
    };
    return await axios.get(`${node.server.address}/api/functions/${node.name}`, { headers, timeout: REQUEST_TIMEOUT_MS });
}

const refreshStatus = async (node) => {
    const r = await getStatus(node);
    node.fnData = r.data;
    node.fnState = r.data?.status?.state;
    node.urls = getUrls(r.data, node);
    return r;
};


const reconcileStep = async (node) => {

    const name = node.name;
    const address = node.server.address;
    
    if (!name || !address) {
        // Node is closed or not configured
        return 5000;
    }

    /* ------------------ If last invocation was successful, skip ----------------- */

    if (node.fnInvocationStatus === 200) {
        // Wait for next check
        // node.status(STATUSES.ready);
        // node.status({ ...STATUSES.ready, text: node.counter > 1 ? `${node.counter}` : '' });
        return 1000;
    }

    /* -------------- Get the function status. If not found, deploy ------------- */

    let r;
    try {
        // Check function status
        r = await getStatus(node);
    } catch (err) {
        // Error while checking function status
        r = err.response;
        if (r && r.status === 404 && r.headers['content-type'] === 'application/json') { //  && r.data?.error === 'Function not found'
            // Function not found, deploy it (or back off if already deploying)
            await deployFunction(node);
            return node.redeploying ? 3000 : 1000;
        }

        // Wait for next check
        return 1000;
    }

    /* -------------------------------------------------------------------------- */
    /*                     Handle different function statuses.                    */
    /* -------------------------------------------------------------------------- */

    try {
        const func = r.data;
        const state = func?.status?.state;
        node.fnData = func;
        node.fnState = state;
        node.urls = getUrls(func, node);
        // if (state!=='ready' || node.fnInvocationStatus!==200 && node.fnInvocationStatus!==-1) console.log("Reconciling", name, state, node.fnInvocationStatus, node.counter);

        /* ---------------------------- Check each state ---------------------------- */

        if (state === 'ready') {
            // Function is ready
            node.redeploying = false;

            if (node.fnInvocationStatus === 200) {
                // Wait for next check
                node.status({ ...STATUSES.ready, text: node.counter > 1 ? `${node.counter}` : '' });
                return 5000;
            } 
            else if (node.fnInvocationStatus === -1) {
                // Wait for next check
                node.status({ fill: "blue", shape: "dot", text: "" });
                return 5000;
            } 
            else {
                // Wait for next check
                return 1000;
            }
        }
        else if (state === 'error') {
            // Function is in error state
            node.redeploying = false;

            // Wait for next check
            node.status(STATUSES[state]);
            return 5000;
        } 
        else if (state === 'unhealthy') {
            // Function is unhealthy
            node.status(STATUSES.unhealthy);
            if (!node.redeploying && node.fnInvocationStatus !== 200) {
                await deployFunction(node);
            }

            // Wait for next check
            return 1000;
        }
        else if (state === null) {
            // Function is unhealthy

            // But requests are still 200
            if (node.fnInvocationStatus === 200) {
                node.status(STATUSES.unhealthyOk);
            }
            // unhealthy and not currently redeploying
            else if (!node.redeploying) {
                await deployFunction(node);
            } else {
                node.status(STATUSES[state]);
            }

            // Wait for next check
            return 1000;
        }
        else if (state === 'scaledToZero') {  // Wait for next check
            node.status(STATUSES[state]);
            return 5000;
        }
        else if (BUILDING.includes(state)) {  // Wait for next check
            node.status(STATUSES[state]);
            return 1000;
        }
        else if (WAITING.includes(state)) {  // Wait for next check
            node.status(STATUSES[state]);
            return 3000;
        }
        else {  // Wait for next check
            node.status(STATUSES[state] || { fill: "yellow", shape: "dot", text: state });
            return 1000;
        }
    } catch (err) {  // Wait for next check
        node.status({ fill: "red", shape: "ring", text: err.message });
        console.error("Error while checking function status:", err);
        return 1000;
    }
};

const getUrls = (func, node) => {
    const name = func?.metadata?.name || node.name;
    const namespace = func?.metadata?.namespace || node.fnConfigSpec?.metadata?.namespace;
    const internalUrls = func?.status?.internalInvocationUrls || [];
    const externalUrls = func?.status?.externalInvocationUrls || [];
    const internal = internalUrls.length > 0 ? `http://${internalUrls[0]}` : undefined;
    const external = externalUrls.length > 0 ? `https://${externalUrls[0]}` : undefined;
    const kubernetes = `http://${name + (namespace ? '.'+namespace : '')}.svc.cluster.local:8080`;
    const docker = `http://nuclio-${namespace || 'nuclio'}-${name}:8080`;  // REF: https://github.com/nuclio/nuclio/blob/37f777a642b2176835e00e44921ed204df1dd908/pkg/platform/local/platform.go#L911
    const invocation = internal || external || node.urls?.invocation;  // REF: https://github.com/nuclio/nuclio/blob/37f777a642b2176835e00e44921ed204df1dd908/pkg/platform/kube/resourcescaler/resourcescaler.go#L353
    const healthPath = '/__internal/health';
    return {
        internal,
        external,
        kubernetes,
        docker,
        invocation,
        healthcheck: getHealthcheckUrl(internal, healthPath),
        healthPath,
    };
};

const getHealthcheckUrl = (url, internalHealthPath) => {
    if (!url) return undefined;
    // replace port with 8082
    let u = new URL(url);
    u.port = 8082;
    u.pathname = internalHealthPath || '/';
    return u.toString();
};


module.exports = {
    reconcileLoop,
    reconcileStep,
    refreshStatus,
    getStatus,
};
