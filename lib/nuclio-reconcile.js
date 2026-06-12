const axios = require('axios');
const { deployFunction, WAITING, STATUSES } = require('./nuclio-api');
const { parseIntFallback } = require('./util');

const REQUEST_TIMEOUT_MS = parseIntFallback(process.env.NUCLIO_REQUEST_TIMEOUT_MS, 10000);

// How often to re-check each function state - fast while transitioning, slow at rest.
const POLL_MS = {
    default:      1000,  // building / transitioning / unknown states
    backoff:      5000,  // server or deploy errors
    deploying:    3000,  // a deploy we just kicked off
    ready:        5000,
    error:        5000,
    scaledToZero: 5000,
    ...Object.fromEntries(WAITING.map(s => [s, 3000])),
};


/* -------------------------------------------------------------------------- */
/*                               Reconcile Loop                               */
/* -------------------------------------------------------------------------- */

const reconcileLoop = async (node) => {
    // Push the current config once at startup so editor changes actually
    // deploy - this no-ops (and releases invoke nodes immediately) when the
    // deployed function is already up to date.
    await deployFunction(node);
    while (!node.closed) {
        let sleep = await reconcileStep(node);
        if (node.closed) break;
        await new Promise(resolve => {
            // node close calls reconcileWake() so the loop exits promptly
            node.reconcileWake = resolve;
            node.reconcileTimer = setTimeout(() => {
                node.reconcileTimer = null;
                resolve();
            }, sleep || POLL_MS.default);
        });
        node.reconcileWake = null;
    }
};

const reconcileStep = async (node) => {

    const name = node.name;
    const address = node.server.address;

    if (!name || !address) {
        // Node is not configured
        return POLL_MS.backoff;
    }

    /* -------------- While invocations succeed, skip status checks ------------- */
    // The invoke nodes report their own (green) status; if the function breaks,
    // invocations stop returning 200 and polling resumes on the next tick.

    if (node.fnInvocationStatus === 200) {
        return POLL_MS.default;
    }

    /* -------------- Get the function status. If not found, deploy ------------- */

    let r;
    try {
        // Check function status
        r = await getStatus(node);
    } catch (err) {
        r = err.response;
        if (r && r.status === 404 && r.headers['content-type'] === 'application/json') {
            // Function not found, deploy it (or back off if already deploying)
            const ok = await deployFunction(node);
            if (ok === false) return POLL_MS.backoff;
            return node.redeploying ? POLL_MS.deploying : POLL_MS.default;
        }
        if (r && (r.status === 404 || r.status === 502 || r.status === 503)) {
            // Server error, back off and retry
            node.status({ fill: "red", shape: "ring", text: `Error ${r.status}` });
            return POLL_MS.backoff;
        }
        if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
            // Server is not responding, back off and retry
            node.status({ fill: "red", shape: "ring", text: "Server not responding" });
            return POLL_MS.backoff;
        }
        // Other error, show it and retry
        node.status({ fill: "red", shape: "ring", text: err.message });
        node.warn(`Error while checking function status: ${err.message}`);
        return POLL_MS.backoff;
    }

    /* ----------------------- Handle each function state ----------------------- */

    try {
        const func = r.data;
        const state = func?.status?.state ?? null;
        node.fnData = func;
        node.fnState = state;
        node.urls = getUrls(func, node);

        if (state === 'ready') {
            // Function is ready - the invoke nodes report invocation health
            node.redeploying = false;
            if (node.fnInvocationStatus === -1) {
                // Deployed, but not invoked yet
                node.status({ fill: "blue", shape: "dot", text: "" });
                return POLL_MS.ready;
            }
            // Invocations are failing - poll faster (succeeding ones skip the check above)
            return POLL_MS.default;
        }

        if (state === 'error') {
            // Unrecoverable without a config change - wait for a manual redeploy
            node.redeploying = false;
            node.status(STATUSES.error);
            return POLL_MS.error;
        }

        if (state === 'unhealthy' || state === null) {
            // Unhealthy (null = no state reported at all) - redeploy, unless
            // invocations still succeed or a redeploy is already in flight
            if (node.fnInvocationStatus === 200) {
                node.status(state === null ? STATUSES.unhealthyOk : STATUSES.unhealthy);
            } else if (!node.redeploying) {
                node.status(STATUSES.unhealthy);
                const ok = await deployFunction(node);
                if (ok === false) return POLL_MS.backoff;
            } else {
                node.status(STATUSES.redeploying);
            }
            return POLL_MS.default;
        }

        // Remaining states (building / waiting / scaledToZero / unknown) just
        // show progress and wait
        node.status(STATUSES[state] || { fill: "yellow", shape: "dot", text: state });
        return POLL_MS[state] || POLL_MS.default;
    } catch (err) {
        node.status({ fill: "red", shape: "ring", text: err.message });
        node.warn(`Error while reconciling function status: ${err.message}`);
        return POLL_MS.backoff;
    }
};


/* -------------------------------------------------------------------------- */
/*                              Function Status                               */
/* -------------------------------------------------------------------------- */

const getStatus = async (node) => {
    const headers = {
        'Content-Type': 'application/json',
        'x-nuclio-project-name': node.project?.name || 'default',
    };
    return await axios.get(`${node.server.address}/api/functions/${node.name}`, { headers, timeout: REQUEST_TIMEOUT_MS });
}


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
    getStatus,
    getUrls,
};
