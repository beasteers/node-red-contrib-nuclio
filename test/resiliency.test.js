const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { reconcileStep } = require('../lib/nuclio-reconcile');
const { deployFunction, ensureProject } = require('../lib/nuclio-deploy');
const { startMockNuclio } = require('./helpers/mock-nuclio');

const createClock = (value = 0) => ({
    now: () => value,
    advance: (ms) => { value += ms; },
});

// Deterministic, fast tuning - now read off the node (server cadence + function
// recovery policy) rather than module-load env, so set them on the stub directly.
const SERVER = {
    requestTimeoutMs: 10000, deployTimeoutMs: 60000,
    pollMs: 1000, readyPollMs: 5000,
    backoffMs: 100, backoffMaxMs: 400, startStaggerMs: 0,
};

// Minimal node stand-in - reconcileStep/deployFunction only need these.
const makeNode = (address, overrides = {}) => ({
    name: 'fn',
    closed: false,
    redeploying: false,
    selfHealAttempts: 0,
    maxSelfHealAttempts: 3,
    redeployDeadlineMs: 50,
    autoRedeployOnError: false,
    fnInvocationStatus: -1,
    counter: 0,
    server: { address, ...SERVER },
    project: { name: 'default' },
    fnConfigSpec: { name: 'fn', runtime: 'python:3.12', code: 'x = 1', config: {}, address },
    statuses: [],
    status(s) { this.statuses.push(s); this.lastStatus = s; },
    warn() {}, log() {}, debug() {}, error() {},
    ...overrides,
});

const deployWrites = (mock) => mock.requests.filter(
    r => ['POST', 'PUT', 'PATCH'].includes(r.method) && r.url.startsWith('/api/functions'),
);

let mock;
afterEach(async () => { if (mock) { await mock.close(); mock = null; } });

const UNREACHABLE = 'http://127.0.0.1:1';  // port 1 -> immediate ECONNREFUSED

test('project discovery is coalesced and cached per server', async () => {
    const node = makeNode('http://example.test');
    let listCalls = 0;
    let createCalls = 0;
    const client = {
        listProjects: async () => {
            listCalls++;
            await new Promise(resolve => setImmediate(resolve));
            return { data: { default: { metadata: { name: 'default' } } } };
        },
        createProject: async () => {
            createCalls++;
            return { status: 201, statusText: 'Created', config: { url: '/api/projects' } };
        },
    };

    await Promise.all([
        ensureProject(node, client, 'default'),
        ensureProject(node, client, 'default'),
    ]);
    await ensureProject(node, client, 'default');

    assert.equal(listCalls, 1);
    assert.equal(createCalls, 0);
});


/* -------------------------------- Idle poll -------------------------------- */

test('a freshly-succeeding function still polls status, at the ready interval', async () => {
    // regression: invocations succeeding used to skip status checks entirely,
    // leaving state drift invisible; now they only slow the poll down
    mock = await startMockNuclio({ functions: { fn: { metadata: { name: 'fn' }, spec: {} } }, state: 'ready' });
    const node = makeNode(mock.url, { fnInvocationStatus: 200, lastInvocationAt: Date.now() });
    const ms = await reconcileStep(node);
    assert.equal(ms, 5000);  // ready + fresh success -> slow poll
    assert.ok(mock.requests.some(r => r.method === 'GET' && r.url === '/api/functions/fn'));
});

test('a stale success does not suppress observation or self-heal evidence', async () => {
    mock = await startMockNuclio({ functions: { fn: { metadata: { name: 'fn' }, spec: {} } }, state: 'ready' });
    const node = makeNode(mock.url, { fnInvocationStatus: 200, lastInvocationAt: Date.now() - 60000 });
    const ms = await reconcileStep(node);
    assert.equal(ms, 5000);  // idle (stale result) -> slow poll, but the GET happened
    assert.ok(mock.requests.some(r => r.method === 'GET' && r.url === '/api/functions/fn'));
});

test('a recent invocation failure on a ready function polls fast', async () => {
    mock = await startMockNuclio({ functions: { fn: { metadata: { name: 'fn' }, spec: {} } }, state: 'ready' });
    const node = makeNode(mock.url, { fnInvocationStatus: 500, lastInvocationAt: Date.now() });
    const ms = await reconcileStep(node);
    assert.equal(ms, 1000);  // fresh failure -> watch closely
});


/* ------------------------------ Backoff / jitter --------------------------- */

test('connectivity failures back off exponentially and cap', async () => {
    const node = makeNode(UNREACHABLE);
    const seq = [];
    for (let i = 0; i < 4; i++) seq.push(await reconcileStep(node));
    assert.deepEqual(seq.slice(0, 3), [100, 200, 400]);  // per-function backoff
    assert.ok(seq[3] >= 4990 && seq[3] <= 5000, `unexpected circuit cooldown: ${seq[3]}`);
    assert.match(node.lastStatus.text, /not responding|unavailable/i);
});

test('backoff resets the moment the dashboard answers again', async () => {
    mock = await startMockNuclio({ functions: { fn: { metadata: { name: 'fn' }, spec: {} } }, state: 'ready' });
    const node = makeNode(mock.url, { _backoff: 400 });  // pretend mid-backoff
    const ms = await reconcileStep(node);
    assert.equal(node._backoff, null);
    assert.equal(ms, 5000);  // ready + never-invoked -> POLL_MS.ready
});


/* ------------------------------- Self-healing ------------------------------ */

test('unhealthy self-heal is bounded, then gives up with an honest status', async () => {
    mock = await startMockNuclio({ functions: { fn: { metadata: { name: 'fn' }, spec: {} } }, state: 'unhealthy' });
    const clock = createClock();
    const node = makeNode(mock.url, { clock });

    // Advance the injected clock instead of waiting for each redeploy deadline.
    await reconcileStep(node); // first unhealthy reading: debounce holds
    for (let attempt = 0; attempt < 3; attempt++) {
        await reconcileStep(node);
        clock.advance(node.redeployDeadlineMs + 1);
    }
    await reconcileStep(node); // max attempts reached: give up

    assert.equal(deployWrites(mock).length, 3);  // MAX_SELF_HEAL_ATTEMPTS, then stops
    assert.match(node.lastStatus.text, /gave up/i);
    assert.equal(node.redeploying, false);
});

test('self-heal waits for two consecutive unhealthy readings', async () => {
    // debounce: one flaky health verdict must not churn a redeploy
    mock = await startMockNuclio({ functions: { fn: { metadata: { name: 'fn' }, spec: {} } }, state: 'unhealthy' });
    const node = makeNode(mock.url);

    await reconcileStep(node);  // reading 1: debounce holds
    assert.equal(deployWrites(mock).length, 0);
    assert.equal(node.lastStatus.text, 'Unhealthy');

    await reconcileStep(node);  // reading 2: self-heal kicks in
    assert.equal(deployWrites(mock).length, 1);
    assert.equal(node.selfHealAttempts, 1);
});

test('fresh succeeding invocations suppress self-heal despite unhealthy state', async () => {
    mock = await startMockNuclio({ functions: { fn: { metadata: { name: 'fn' }, spec: {} } }, state: 'unhealthy' });
    const node = makeNode(mock.url, { fnInvocationStatus: 200, lastInvocationAt: Date.now() });

    await reconcileStep(node);
    await reconcileStep(node);
    assert.equal(deployWrites(mock).length, 0);  // still serving traffic -> no redeploy
    assert.equal(node.lastStatus.text, 'Unhealthy');
});

test('a redeploy that never restores health cannot pin "Redeploying" forever', async () => {
    // the deadline lets a stuck redeploy lapse so the next attempt (or give-up) proceeds
    mock = await startMockNuclio({ functions: { fn: { metadata: { name: 'fn' }, spec: {} } }, state: 'unhealthy' });
    const clock = createClock();
    const node = makeNode(mock.url, { clock });

    await reconcileStep(node);                 // reading 1: debounce, no deploy yet
    assert.equal(node.redeploying, false);
    await reconcileStep(node);                 // reading 2 -> attempt 1 -> redeploying = true
    assert.equal(node.redeploying, true);
    await reconcileStep(node);                 // still within deadline -> holds "Redeploying"
    assert.equal(node.lastStatus.text, 'Redeploying...');
    clock.advance(node.redeployDeadlineMs + 1); // deadline lapses
    await reconcileStep(node);                 // attempt 2 proceeds
    assert.equal(node.selfHealAttempts, 2);
});

test('a manual (forced) redeploy un-gives-up the self-healer', async () => {
    mock = await startMockNuclio({ functions: { fn: { metadata: { name: 'fn' }, spec: {} } }, state: 'unhealthy' });
    const node = makeNode(mock.url, { selfHealAttempts: 3 });  // already gave up
    await deployFunction(node, { force: true });
    assert.equal(node.selfHealAttempts, 0);
    assert.ok(deployWrites(mock).length >= 1);
});

test('error state does not self-heal by default', async () => {
    mock = await startMockNuclio({ functions: { fn: { metadata: { name: 'fn' }, spec: {} } }, state: 'error' });
    const node = makeNode(mock.url);
    const ms = await reconcileStep(node);
    assert.equal(deployWrites(mock).length, 0);
    assert.equal(node.lastStatus.text, 'Error');
    assert.equal(ms, 5000);  // POLL_MS.error
});

test('autoRedeployOnError: true triggers self-heal from error state', async () => {
    mock = await startMockNuclio({ functions: { fn: { metadata: { name: 'fn' }, spec: {} } }, state: 'error' });
    const node = makeNode(mock.url, { autoRedeployOnError: true });

    // error self-heal has no debounce — deploys on the first poll.
    // deployFunction sets status to 'Redeploying...' after the attemptSelfHeal label
    await reconcileStep(node);
    assert.equal(deployWrites(mock).length, 1);
    assert.equal(node.selfHealAttempts, 1);
    assert.ok(node.lastStatus.text.includes('Redeploying'));
});

test('autoRedeployOnError skips self-heal when invocations are succeeding', async () => {
    // if invocations are still ok, we should observe the error state
    // but not trigger a redeploy (same guard as unhealthy)
    mock = await startMockNuclio({ functions: { fn: { metadata: { name: 'fn' }, spec: {} } }, state: 'error' });
    const node = makeNode(mock.url, { autoRedeployOnError: true, fnInvocationStatus: 200, lastInvocationAt: Date.now() });

    await reconcileStep(node);
    assert.equal(deployWrites(mock).length, 0);
    assert.equal(node.lastStatus.text, 'Error');
});

test('dashboard 502 during status GET backs off and shows error', async () => {
    mock = await startMockNuclio({ functions: { fn: { metadata: { name: 'fn' }, spec: {} } }, state: 'ready' });
    mock.failStatus = 502;
    const node = makeNode(mock.url);

    const ms = await reconcileStep(node);
    assert.equal(ms, 100);  // first backoff (SERVER.backoffMs)
    assert.equal(node.lastStatus.text, 'Error 502');
    assert.equal(deployWrites(mock).length, 0);
});

test('dashboard 503 during status GET backs off and shows error', async () => {
    mock = await startMockNuclio({ functions: { fn: { metadata: { name: 'fn' }, spec: {} } }, state: 'ready' });
    mock.failStatus = 503;
    const node = makeNode(mock.url);

    const ms = await reconcileStep(node);
    assert.equal(ms, 100);  // first backoff
    assert.equal(node.lastStatus.text, 'Error 503');
});

test('waitingForScaleResourceFromZero polls at 3s and blocks updates', async () => {
    mock = await startMockNuclio({ functions: { fn: { metadata: { name: 'fn' }, spec: {} } }, state: 'waitingForScaleResourceFromZero' });
    const node = makeNode(mock.url);

    const ms = await reconcileStep(node);
    assert.equal(ms, 3000);  // POLL_MS via WAITING spread
    assert.match(node.lastStatus.text, /Scale Resource From Zero/i);
    // no deploy writes — the function is in a WAITING state
    assert.equal(deployWrites(mock).length, 0);
});

test('waitingForBuild blocks deploy and shows correct status', async () => {
    mock = await startMockNuclio({ functions: { fn: { metadata: { name: 'fn' }, spec: {} } }, state: 'waitingForBuild' });
    const node = makeNode(mock.url);

    const ms = await reconcileStep(node);
    assert.equal(ms, 3000);
    assert.match(node.lastStatus.text, /Waiting For Build/i);
    assert.equal(deployWrites(mock).length, 0);
});

test('waitingForScaleResourceToZero polls at 3s and blocks updates', async () => {
    mock = await startMockNuclio({ functions: { fn: { metadata: { name: 'fn' }, spec: {} } }, state: 'waitingForScaleResourceToZero' });
    const node = makeNode(mock.url);

    const ms = await reconcileStep(node);
    assert.equal(ms, 3000);  // POLL_MS via WAITING spread
    assert.match(node.lastStatus.text, /Scale Resource To Zero/i);
    assert.equal(deployWrites(mock).length, 0);
});

/* ----------------------- deployFunction error paths ----------------------- */

test('deployFunction warns on connectivity failure, does not trigger Catch nodes', async () => {
    const errors = [];
    const warns = [];
    const node = makeNode(UNREACHABLE, {
        error(msg) { errors.push(msg); },
        warn(msg) { warns.push(msg); },
    });

    const ok = await deployFunction(node);
    assert.equal(ok, false);
    assert.equal(node.redeploying, false);
    assert.equal(errors.length, 0, 'Catch nodes must not fire for server-outage deploy failures');
    assert.ok(warns.length >= 1);
    assert.match(warns[0], /not reachable/);
});
