const axios = require('axios');
const { deployFunction, WAITING, STATUSES } = require('./nuclio-api');
const { parseIntFallback } = require('./util');

const REQUEST_TIMEOUT_MS = parseIntFallback(process.env.NUCLIO_REQUEST_TIMEOUT_MS, 10000);

// How often to re-check each function state - fast while transitioning, slow at rest.
const POLL_MS = {
    default:      parseIntFallback(process.env.NUCLIO_POLL_MS, 1000),  // building / transitioning
    ready:        parseIntFallback(process.env.NUCLIO_READY_POLL_MS, 5000),
    deploying:    3000,  // a deploy we just kicked off
    error:        5000,
    scaledToZero: 5000,
    ...Object.fromEntries(WAITING.map(s => [s, 3000])),
};

// Error backoff: starts here, doubles each consecutive failure up to the cap, and
// resets the moment the dashboard answers again. Jitter (applied at the sleep site)
// desynchronizes functions so a recovering server isn't hit by all of them at once.
const BACKOFF_MS     = parseIntFallback(process.env.NUCLIO_BACKOFF_MS, 5000);
const BACKOFF_MAX_MS = parseIntFallback(process.env.NUCLIO_BACKOFF_MAX_MS, 60000);

// Spread first-deploy across this window so N functions don't hammer the builder on restart.
const START_STAGGER_MS = parseIntFallback(process.env.NUCLIO_START_STAGGER_MS, 2000);

// Self-healing: how many times to auto-redeploy a recoverable bad state before
// giving up and waiting for a manual redeploy. `error` is treated as terminal by
// default (Nuclio's semantics) unless opted in.
const MAX_SELF_HEAL = parseIntFallback(process.env.NUCLIO_MAX_SELF_HEAL_ATTEMPTS, 5);
const AUTO_REDEPLOY_ON_ERROR = process.env.NUCLIO_AUTO_REDEPLOY_ON_ERROR === 'true';

const jitter = (ms) => Math.round(ms * (0.85 + Math.random() * 0.3));  // +/-15%

// Escalating per-node backoff, stored on the node so each function tracks its own.
const backoff = (node) => {
    node.backoffMs = node.backoffMs ? Math.min(node.backoffMs * 2, BACKOFF_MAX_MS) : BACKOFF_MS;
    return node.backoffMs;
};

// Log a transient error at most once until it changes or the server recovers, so a
// sustained outage doesn't spam the log every backoff tick.
const warnOnce = (node, msg) => {
    if (node.lastWarn === msg) return;
    node.lastWarn = msg;
    node.warn(msg);
};


/* -------------------------------------------------------------------------- */
/*                               Reconcile Loop                               */
/* -------------------------------------------------------------------------- */

// A close()-interruptible sleep: the node's close handler calls reconcileWake().
const sleep = (node, ms) => new Promise(resolve => {
    node.reconcileWake = resolve;
    node.reconcileTimer = setTimeout(() => {
        node.reconcileTimer = null;
        resolve();
    }, ms);
});

const reconcileLoop = async (node) => {
    // Stagger startup so a restart with many functions doesn't hammer the dashboard.
    if (START_STAGGER_MS > 0) await sleep(node, Math.random() * START_STAGGER_MS);
    if (node.closed) return;

    // Push the current config once at startup so editor changes actually deploy -
    // this no-ops (and releases invoke nodes immediately) when already up to date.
    await deployFunction(node);

    while (!node.closed) {
        const next = await reconcileStep(node);
        if (node.closed) break;
        await sleep(node, jitter(next || POLL_MS.default));
        node.reconcileWake = null;
    }
};

const reconcileStep = async (node) => {

    const name = node.name;
    const address = node.server.address;

    if (!name || !address) {
        // Node is not configured (won't recover without a redeploy of the node)
        return BACKOFF_MS;
    }

    /* -------------- While invocations succeed, skip status checks ------------- */
    // The invoke nodes report their own (green) status; if the function breaks,
    // invocations stop returning 200 and full polling resumes on the next tick.

    if (node.fnInvocationStatus === 200) {
        return POLL_MS.ready;
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
            if (ok === false) return backoff(node);
            return node.redeploying ? POLL_MS.deploying : POLL_MS.default;
        }
        if (r && (r.status === 502 || r.status === 503)) {
            // Transient gateway error, back off and retry
            node.status({ fill: "red", shape: "ring", text: `Error ${r.status}` });
            return backoff(node);
        }
        if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') {
            // Server is not responding, back off and retry (quietly - this is expected)
            node.status({ fill: "red", shape: "ring", text: "Server not responding" });
            return backoff(node);
        }
        // Other error, show it and retry
        node.status({ fill: "red", shape: "ring", text: err.message });
        warnOnce(node, `Error while checking function status: ${err.message}`);
        return backoff(node);
    }

    /* ----------------------- Handle each function state ----------------------- */

    try {
        // The dashboard answered, so reset transient-failure tracking.
        node.backoffMs = null;
        node.lastWarn = null;

        const func = r.data;
        const state = func?.status?.state ?? null;
        node.fnData = func;
        node.fnState = state;
        node.urls = getUrls(func, node);

        if (state === 'ready') {
            // Function is ready - the invoke nodes report invocation health
            node.redeploying = false;
            node.selfHealAttempts = 0;
            if (node.fnInvocationStatus === -1) {
                // Deployed, but not invoked yet
                node.status({ fill: "blue", shape: "dot", text: "" });
                return POLL_MS.ready;
            }
            // Invocations are failing - poll faster (succeeding ones skip the check above)
            return POLL_MS.default;
        }

        if (state === 'error') {
            // Nuclio's `error` is "unrecoverable without redeployment". Opt-in self-heal.
            if (AUTO_REDEPLOY_ON_ERROR && node.fnInvocationStatus !== 200) {
                return await attemptSelfHeal(node, 'Error');
            }
            node.redeploying = false;
            node.status(STATUSES.error);
            return POLL_MS.error;
        }

        if (state === 'unhealthy' || state === null) {
            // Recoverable: redeploy (bounded), unless invocations still succeed.
            if (node.fnInvocationStatus === 200) {
                node.status(state === null ? STATUSES.unhealthyOk : STATUSES.unhealthy);
                return POLL_MS.default;
            }
            return await attemptSelfHeal(node, 'Unhealthy');
        }

        // Remaining states (building / waiting / scaledToZero / unknown) just
        // show progress and wait
        node.status(STATUSES[state] || { fill: "yellow", shape: "dot", text: state });
        return POLL_MS[state] || POLL_MS.default;
    } catch (err) {
        node.status({ fill: "red", shape: "ring", text: err.message });
        warnOnce(node, `Error while reconciling function status: ${err.message}`);
        return backoff(node);
    }
};


/* -------------------------------------------------------------------------- */
/*                                Self-Healing                                */
/* -------------------------------------------------------------------------- */

// Bounded auto-redeploy for recoverable bad states. Keeps an honest status the
// whole way ("Unhealthy 2/5", then "gave up") and treats a redeploy that hasn't
// restored health by its deadline as failed, so the node can never pin a stale
// "Redeploying..." forever. Returns the poll interval.
const attemptSelfHeal = async (node, label) => {
    // A redeploy still within its deadline: let it finish.
    if (node.redeploying && node.redeployDeadline && Date.now() < node.redeployDeadline) {
        node.status(STATUSES.redeploying);
        return POLL_MS.default;
    }
    // Past the deadline (or never started) - the last attempt didn't take.
    node.redeploying = false;

    if ((node.selfHealAttempts || 0) >= MAX_SELF_HEAL) {
        // Give up auto-healing: honest status, slow poll, wait for a manual redeploy.
        node.status({ fill: "red", shape: "ring", text: `${label} - gave up (${node.selfHealAttempts}x)` });
        return POLL_MS.error;
    }

    node.selfHealAttempts = (node.selfHealAttempts || 0) + 1;
    node.status({ fill: "red", shape: "ring", text: `${label} - redeploy ${node.selfHealAttempts}/${MAX_SELF_HEAL}` });
    const ok = await deployFunction(node);
    return ok === false ? backoff(node) : POLL_MS.default;
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
