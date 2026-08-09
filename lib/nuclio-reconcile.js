const { deployFunction, STATUSES } = require('./nuclio-api');
const { createClient, WAITING } = require('./nuclio-client');

// Division of labor with Nuclio: the dashboard is the *sensor* (it watches
// container health and reports state) but does not auto-redeploy; node-red is
// the *actuator* (the only thing that redeploys, via self-heal below). So the
// two loops can't fight - the real risk is reacting to a flaky verdict, which
// the invocation-freshness and unhealthy-debounce guards absorb.

// Poll intervals for transient states that aren't worth exposing as config. The
// tunable ones (default/ready) live on the server config node (node.server.pollMs /
// readyPollMs); backoff/stagger come from there too.
const POLL_MS = {
    deploying:    3000,  // a deploy we just kicked off
    error:        5000,
    scaledToZero: 5000,
    ...Object.fromEntries(WAITING.map(s => [s, 3000])),
};

// "Invocations are succeeding" only counts a *fresh* 200. Without the bound a
// single success would count forever - leaving idle functions unwatched and
// suppressing self-heal based on long-stale evidence.
const INVOCATION_FRESH_MS = 30000;
const invocationsOk = (node) =>
    node.fnInvocationStatus === 200 && Date.now() - (node.lastInvocationAt || 0) < INVOCATION_FRESH_MS;

// Consecutive unhealthy readings required before self-healing, so one flaky
// health verdict doesn't churn a redeploy.
const UNHEALTHY_DEBOUNCE = 2;

const jitter = (ms) => Math.round(ms * (0.85 + Math.random() * 0.3));  // +/-15%

// Error backoff: starts at the server's backoffMs, doubles each consecutive failure
// up to backoffMaxMs, and resets the moment the dashboard answers again. The current
// value is tracked per-function on node._backoff. Jitter (applied at the sleep site)
// desynchronizes functions so a recovering server isn't hit by all of them at once.
const backoff = (node) => {
    node._backoff = node._backoff
        ? Math.min(node._backoff * 2, node.server.backoffMaxMs)
        : node.server.backoffMs;
    return node._backoff;
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
    if (node.server.startStaggerMs > 0) await sleep(node, Math.random() * node.server.startStaggerMs);
    if (node.closed) return;

    // Push the current config once at startup so editor changes actually deploy -
    // this no-ops (and releases invoke nodes immediately) when already up to date.
    await deployFunction(node);

    while (!node.closed) {
        const next = await reconcileStep(node);
        if (node.closed) break;
        await sleep(node, jitter(next || node.server.pollMs));
        node.reconcileWake = null;
    }
};

const reconcileStep = async (node) => {

    const name = node.name;
    const address = node.server.address;

    if (!name || !address) {
        // Node is not configured (won't recover without a redeploy of the node)
        return node.server.backoffMs;
    }

    /* -------------- Get the function status. If not found, deploy ------------- */
    // Status is always polled (at the slow ready cadence when healthy). Fresh,
    // succeeding invocations only suppress *self-healing* - they never skip
    // observation, so state drift is still seen on idle-but-running functions.

    let r;
    try {
        // Check function status
        r = await getStatus(node);
    } catch (err) {
        r = err.response;
        // content-type check distinguishes a dashboard 404 (function missing ->
        // deploy it) from an intermediary/proxy 404 page; tolerate charset params
        if (r && r.status === 404 && `${r.headers?.['content-type'] || ''}`.includes('application/json')) {
            // Function not found, deploy it (or back off if already deploying)
            const ok = await deployFunction(node);
            if (ok === false) return backoff(node);
            return node.redeploying ? POLL_MS.deploying : node.server.pollMs;
        }
        // Any other failure: show why, then back off and retry.
        if (r && (r.status === 502 || r.status === 503)) {
            node.status({ fill: "red", shape: "ring", text: `Error ${r.status}` });
        } else if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') {
            node.status({ fill: "red", shape: "ring", text: "Server not responding" });  // expected - stay quiet
        } else {
            node.status({ fill: "red", shape: "ring", text: err.message });
            warnOnce(node, `Error while checking function status: ${err.message}`);  // unexpected - log once
        }
        return backoff(node);
    }

    /* ----------------------- Handle each function state ----------------------- */

    try {
        // The dashboard answered, so reset transient-failure tracking.
        node._backoff = null;
        node.lastWarn = null;

        const func = r.data;
        const state = func?.status?.state ?? null;
        node.fnState = state;
        node.invocationUrl = getInvocationUrl(func, node);

        if (state === 'ready') {
            // Function is ready - invoke nodes report invocation health. A fresh
            // success polls slowly; a recent failure polls fast to watch it.
            node.redeploying = false;
            node.selfHealAttempts = 0;
            node.unhealthyStreak = 0;
            if (node.fnInvocationStatus === -1) {
                // Deployed, but not invoked yet
                node.status({ fill: "blue", shape: "dot", text: "" });
                return node.server.readyPollMs;
            }
            if (invocationsOk(node)) {
                // Serving traffic - the invoke nodes show green; poll slowly
                return node.server.readyPollMs;
            }
            if (Date.now() - (node.lastInvocationAt || 0) < INVOCATION_FRESH_MS) {
                // A recent invocation failed - watch it closely
                return node.server.pollMs;
            }
            // Last invocation result is stale (idle function) - poll slowly
            return node.server.readyPollMs;
        }

        if (state === 'error') {
            // Nuclio's `error` is "unrecoverable without redeployment". Opt-in self-heal.
            node.unhealthyStreak = 0;
            if (node.autoRedeployOnError && !invocationsOk(node)) {
                return await attemptSelfHeal(node, 'Error');
            }
            node.redeploying = false;
            node.status(STATUSES.error);
            return POLL_MS.error;
        }

        if (state === 'unhealthy' || state === null) {
            // Recoverable: redeploy (bounded), unless invocations still succeed.
            if (invocationsOk(node)) {
                node.redeploying = false;
                node.unhealthyStreak = 0;
                node.status(state === null ? STATUSES.unhealthyOk : STATUSES.unhealthy);
                return node.server.pollMs;
            }
            // Debounce: only redeploy after consecutive unhealthy readings, so a
            // single flaky health verdict doesn't churn a redeploy.
            node.unhealthyStreak = (node.unhealthyStreak || 0) + 1;
            if (node.unhealthyStreak < UNHEALTHY_DEBOUNCE) {
                node.redeploying = false;
                node.status(state === null ? STATUSES.unhealthyOk : STATUSES.unhealthy);
                return node.server.pollMs;
            }
            // attemptSelfHeal manages redeploying internally (deadline guard)
            return await attemptSelfHeal(node, 'Unhealthy');
        }

        // Remaining states (building / waiting / scaledToZero / imported / unknown)
        // just show progress and wait. redeploying must be cleared here so
        // invoke nodes don't stay permanently blocked — a function in these states
        // may still serve traffic (old version during rolling update, or waking
        // from scaledToZero).
        node.redeploying = false;
        node.status(STATUSES[state] || { fill: "yellow", shape: "dot", text: state });
        return POLL_MS[state] || node.server.pollMs;
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
    const max = node.maxSelfHealAttempts;
    // A redeploy still within its deadline: let it finish.
    if (node.redeploying && node.redeployDeadline && Date.now() < node.redeployDeadline) {
        node.status(STATUSES.redeploying);
        return node.server.pollMs;
    }
    // Past the deadline (or never started) - the last attempt didn't take.
    node.redeploying = false;

    if ((node.selfHealAttempts || 0) >= max) {
        // Give up auto-healing: honest status, slow poll, wait for a manual redeploy.
        node.status({ fill: "red", shape: "ring", text: `${label} - gave up (${node.selfHealAttempts}x)` });
        return POLL_MS.error;
    }

    node.selfHealAttempts = (node.selfHealAttempts || 0) + 1;
    node.status({ fill: "red", shape: "ring", text: `${label} - redeploy ${node.selfHealAttempts}/${max}` });
    const ok = await deployFunction(node);
    return ok === false ? backoff(node) : node.server.pollMs;
};


/* -------------------------------------------------------------------------- */
/*                              Function Status                               */
/* -------------------------------------------------------------------------- */

const getStatus = async (node) => {
    return await createClient(node.server, node.project?.name || 'default').getFunction(node.name);
}


// The URL Node-RED POSTs invocations to. Nuclio reports internal (cluster) and
// external URLs once ready; prefer internal, fall back to external, then to the
// last-known URL so brief status blips don't drop the endpoint.
// REF: https://github.com/nuclio/nuclio/blob/37f777a642b2176835e00e44921ed204df1dd908/pkg/platform/kube/resourcescaler/resourcescaler.go#L353
//
// Nuclio also exposes these internal service URLs (unused here, kept for reference):
//   kubernetes: http://<name>[.<namespace>].svc.cluster.local:8080
//   docker:     http://nuclio-<namespace|nuclio>-<name>:8080   // REF: .../pkg/platform/local/platform.go#L911
//   healthcheck: <internal-url with port 8082>/__internal/health
const getInvocationUrl = (func, node) => {
    const internal = func?.status?.internalInvocationUrls?.[0];
    const external = func?.status?.externalInvocationUrls?.[0];
    return internal ? `http://${internal}`
        : external ? `https://${external}`
        : node.invocationUrl;
};


module.exports = {
    reconcileLoop,
    reconcileStep,
    getStatus,
    getInvocationUrl,
    invocationsOk,
    INVOCATION_FRESH_MS,
    UNHEALTHY_DEBOUNCE,
};
