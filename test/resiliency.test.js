const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { reconcileStep } = require('../lib/nuclio-reconcile');
const { deployFunction } = require('../lib/nuclio-api');
const { startMockNuclio } = require('./helpers/mock-nuclio');

const delay = (ms) => new Promise(r => setTimeout(r, ms));

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


/* -------------------------------- Idle poll -------------------------------- */

test('a steadily-succeeding function polls at the ready interval, not the fast default', async () => {
    // regression: once invocations succeed, reconcile used to spin at 1Hz doing nothing
    const node = makeNode(UNREACHABLE, { fnInvocationStatus: 200 });
    const ms = await reconcileStep(node);  // short-circuits before any network call
    assert.equal(ms, 5000);  // POLL_MS.ready, not POLL_MS.default (1000)
});


/* ------------------------------ Backoff / jitter --------------------------- */

test('connectivity failures back off exponentially and cap', async () => {
    const node = makeNode(UNREACHABLE);
    const seq = [];
    for (let i = 0; i < 4; i++) seq.push(await reconcileStep(node));
    assert.deepEqual(seq, [100, 200, 400, 400]);  // 100 -> 200 -> 400(cap) -> 400
    assert.match(node.lastStatus.text, /not responding/i);
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
    const node = makeNode(mock.url);

    // drive ticks, waiting out the (tiny) redeploy deadline between attempts
    for (let i = 0; i < 12; i++) { await reconcileStep(node); await delay(70); }

    assert.equal(deployWrites(mock).length, 3);  // MAX_SELF_HEAL_ATTEMPTS, then stops
    assert.match(node.lastStatus.text, /gave up/i);
    assert.equal(node.redeploying, false);
});

test('a redeploy that never restores health cannot pin "Redeploying" forever', async () => {
    // the deadline lets a stuck redeploy lapse so the next attempt (or give-up) proceeds
    mock = await startMockNuclio({ functions: { fn: { metadata: { name: 'fn' }, spec: {} } }, state: 'unhealthy' });
    const node = makeNode(mock.url);

    await reconcileStep(node);                 // attempt 1 -> redeploying = true
    assert.equal(node.redeploying, true);
    await reconcileStep(node);                 // still within deadline -> holds "Redeploying"
    assert.equal(node.lastStatus.text, 'Redeploying...');
    await delay(70);                           // deadline lapses
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
