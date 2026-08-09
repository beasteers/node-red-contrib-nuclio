// Fast, deterministic cadence (read at module load; node --test isolates files per process)
process.env.NUCLIO_START_STAGGER_MS = '0';
process.env.NUCLIO_BACKOFF_MS = '150';
process.env.NUCLIO_BACKOFF_MAX_MS = '400';

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const helper = require('node-red-node-test-helper');
const nuclioNodes = require('../lib/nuclio.js');
const { HASH_ANNOTATION, BUILD_HASH_ANNOTATION } = require('../lib/nuclio-api.js');
const { startMockNuclio } = require('./helpers/mock-nuclio');

helper.init(require.resolve('node-red'), { logging: { console: { level: 'off' } } });

/* -------------------------------------------------------------------------- */
/*                                Test Plumbing                               */
/* -------------------------------------------------------------------------- */

before(() => new Promise(resolve => helper.startServer(resolve)));
after(() => new Promise(resolve => helper.stopServer(resolve)));

let mock;
afterEach(async () => {
    await helper.unload();
    if (mock) { await mock.close(); mock = null; }
});

const FN = 'test-fn';

// default flow: server config + function config + invoke node + output helpers
const baseFlow = (mock, fn = {}, inv = {}) => [
    { id: 'srv', type: 'nuclio-config', address: mock.url, addressType: 'str', publicAddress: '', publicAddressType: 'str' },
    { id: 'fn', type: 'nuclio-function', server: 'srv', name: FN, runtime: 'python:3.12', code: 'x = 1', configCode: '', env_vars: [], secret_vars: [], ...fn },
    { id: 'inv', type: 'nuclio', function: 'fn', timeoutMs: '', maxInFlight: '', headers: [], wires: [['out1'], ['out2']], ...inv },
    { id: 'out1', type: 'helper' },
    { id: 'out2', type: 'helper' },
];

const load = (flow, credentials) => new Promise((resolve, reject) => {
    helper.load(nuclioNodes, flow, credentials, (err) => err ? reject(err) : resolve());
});

const waitUntil = async (fn, { timeout = 5000, interval = 25, msg = 'condition' } = {}) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const v = await fn();
        if (v) return v;
        await new Promise(r => setTimeout(r, interval));
    }
    throw new Error(`timed out waiting for ${msg}`);
};

const nextMsg = (node, { timeout = 5000 } = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeout);
    node.once('input', (msg) => { clearTimeout(timer); resolve(msg); });
});

// wait until the function is deployed, observed ready, and invocable
const waitReady = (fnNode, opts = {}) => waitUntil(
    () => fnNode.invocationUrl && !fnNode.redeploying,
    { msg: 'function ready', ...opts },
);

const isDeployWrite = (r) => ['POST', 'PUT', 'PATCH'].includes(r.method) && r.url.startsWith('/api/functions');

/* -------------------------------------------------------------------------- */
/*                              Deploy / Reconcile                            */
/* -------------------------------------------------------------------------- */

test('deploys a new function: project + full spec', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, { env_vars: [{ name: 'MY_VAR', type: 'str', value: 'hello' }] }));

    const req = await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    assert.equal(req.body.metadata.name, FN);
    assert.equal(req.body.spec.runtime, 'python:3.12');
    assert.equal(req.body.spec.handler, 'main:handler');
    assert.equal(Buffer.from(req.body.spec.build.functionSourceCode, 'base64').toString(), 'x = 1');
    assert.equal(req.body.metadata.labels['nuclio.io/project-name'], 'default');
    assert.equal(req.body.metadata.annotations['nuclio.io/generated-by'], 'node-red');
    assert.equal(req.body.metadata.annotations['nuclio.io/node-red-node-id'], 'fn');
    assert.deepEqual(req.body.spec.env, [{ name: 'MY_VAR', value: 'hello' }]);
    // the default project pre-exists in the mock (real nuclio always has one)
    assert.ok(!mock.requests.some(r => r.method === 'POST' && r.url === '/api/projects'));
    // and the function settles to ready
    await waitReady(helper.getNode('fn'));
});

test('a trailing slash on the server address is normalized', async () => {
    mock = await startMockNuclio();
    const flow = baseFlow(mock);
    flow[0].address = `${mock.url}/`;
    await load(flow);
    const req = await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    assert.equal(req.body.metadata.name, FN);
    await waitReady(helper.getNode('fn'));
});

test('redeploying an unchanged function is a no-op', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    await helper.unload();

    mock.requests.length = 0;
    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));
    assert.deepEqual(mock.requests.filter(isDeployWrite), []);
});

test('changed code deploys via PUT with a rebuild', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    await helper.unload();

    mock.requests.length = 0;
    await load(baseFlow(mock, { code: 'x = 2' }));
    const put = await mock.waitFor(r => r.method === 'PUT');
    assert.equal(Buffer.from(put.body.spec.build.functionSourceCode, 'base64').toString(), 'x = 2');
    // source changed: must NOT skip the build
    assert.equal(put.body.metadata.annotations['skip-build'], undefined);
});

test('numeric-only config change deploys via PUT, skipping the build', async () => {
    // regression: diff() used to swallow numeric/boolean changes entirely
    mock = await startMockNuclio();
    await load(baseFlow(mock, { configCode: 'spec:\n  minReplicas: 1\n' }));
    await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    await helper.unload();

    mock.requests.length = 0;
    await load(baseFlow(mock, { configCode: 'spec:\n  minReplicas: 2\n' }));
    const put = await mock.waitFor(r => r.method === 'PUT');
    assert.equal(put.body.spec.minReplicas, 2);
    // no build inputs changed: rebuild is skipped
    assert.equal(put.body.metadata.annotations['skip-build'], 'true');
});

test('deploys stamp config + build hash annotations', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    const req = await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    assert.match(req.body.metadata.annotations[HASH_ANNOTATION], /^[0-9a-f]{64}$/);
    assert.match(req.body.metadata.annotations[BUILD_HASH_ANNOTATION], /^[0-9a-f]{64}$/);
    await waitReady(helper.getNode('fn'));
});

test('matching config hash is a no-op even if the live spec drifted', async () => {
    // hash-based detection trusts the fingerprint over a deep-diff of server
    // state, so out-of-band edits are not churned back on every reconcile
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    await waitReady(helper.getNode('fn'));
    await helper.unload();

    // someone edits the function out-of-band (hash annotation stays)
    mock.functions[FN].spec.minReplicas = 9;
    mock.requests.length = 0;

    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));
    assert.deepEqual(mock.requests.filter(isDeployWrite), []);
});

test('a legacy function (no hash) is migrated via one PUT that stamps the hashes', async () => {
    const legacy = {
        apiVersion: 'nuclio.io/v1',
        kind: 'Function',
        metadata: {
            name: FN,
            labels: { 'nuclio.io/project-name': 'default' },
            annotations: { 'nuclio.io/generated-by': 'node-red' },
        },
        spec: {
            runtime: 'python:3.12',
            handler: 'main:handler',
            build: { functionSourceCode: Buffer.from('x = 1').toString('base64') },
            env: [],
        },
    };
    mock = await startMockNuclio({ functions: { [FN]: legacy } });
    await load(baseFlow(mock));

    // unchanged build inputs -> migration PUT skips the rebuild...
    const put = await mock.waitFor(r => r.method === 'PUT');
    assert.equal(put.body.metadata.annotations['skip-build'], 'true');
    // ...and stamps the hashes so future deploys are hash-based
    assert.match(put.body.metadata.annotations[HASH_ANNOTATION], /^[0-9a-f]{64}$/);
    assert.match(put.body.metadata.annotations[BUILD_HASH_ANNOTATION], /^[0-9a-f]{64}$/);
    await waitReady(helper.getNode('fn'));
    await helper.unload();

    // second deploy is now a hash-based no-op
    mock.requests.length = 0;
    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));
    assert.deepEqual(mock.requests.filter(isDeployWrite), []);
});

test('build-hash change rebuilds; non-build change after migration skips build', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    await helper.unload();

    // code change -> build hash differs -> no skip-build
    mock.requests.length = 0;
    await load(baseFlow(mock, { code: 'x = 2' }));
    let put = await mock.waitFor(r => r.method === 'PUT');
    assert.equal(put.body.metadata.annotations['skip-build'], undefined);
    await waitReady(helper.getNode('fn'));
    await helper.unload();

    // env-only change -> build hash matches -> skip-build
    mock.requests.length = 0;
    await load(baseFlow(mock, { code: 'x = 2', env_vars: [{ name: 'NEW_VAR', type: 'str', value: 'v' }] }));
    put = await mock.waitFor(r => r.method === 'PUT');
    assert.equal(put.body.metadata.annotations['skip-build'], 'true');
    assert.deepEqual(put.body.spec.env.find(e => e.name === 'NEW_VAR'), { name: 'NEW_VAR', value: 'v' });
});

test('secrets from the encrypted credential store land in the deployed spec', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock), {
        fn: { secret_vars: JSON.stringify([{ name: 'spec.build.codeEntryAttributes.s3SecretAccessKey', type: 'cred', value: 'shh-cred' }]) },
    });
    const req = await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    assert.equal(req.body.spec.build.codeEntryAttributes.s3SecretAccessKey, 'shh-cred');
});

test('legacy plaintext secret_vars still deploy (pre-1.2 flows)', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, {
        secret_vars: [{ name: 'spec.build.codeEntryAttributes.s3SecretAccessKey', type: 'cred', value: 'shh-legacy' }],
    }));
    const req = await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    assert.equal(req.body.spec.build.codeEntryAttributes.s3SecretAccessKey, 'shh-legacy');
});

test('failed deploy does not wedge the node (redeploying clears, retries continue)', async () => {
    // regression: a 5xx during deploy used to leave `redeploying` stuck forever
    mock = await startMockNuclio();
    mock.failDeploys = true;
    await load(baseFlow(mock));

    await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    const fn = helper.getNode('fn');
    await waitUntil(() => fn.redeploying === false, { msg: 'redeploying cleared' });

    // the reconcile loop schedules another attempt (5s backoff)
    const attempts = () => mock.requests.filter(r => r.method === 'POST' && r.url === '/api/functions').length;
    await waitUntil(() => attempts() >= 2, { timeout: 8000, msg: 'deploy retry' });

    // and once the server recovers, the function deploys (after the 5s backoff)
    mock.failDeploys = false;
    await waitReady(fn, { timeout: 10000 });
});

test('unhealthy function is redeployed automatically', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    const fn = helper.getNode('fn');
    await waitReady(fn);

    mock.requests.length = 0;
    mock.state = 'unhealthy';
    // config is unchanged, so recovery is a desiredState PATCH
    const patch = await mock.waitFor(r => r.method === 'PATCH', { timeout: 10000 });
    assert.deepEqual(patch.body, { desiredState: 'ready' });
});

/* -------------------------------------------------------------------------- */
/*                                   Invoke                                   */
/* -------------------------------------------------------------------------- */

test('invokes the function and returns the response on output 1', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));

    const reply = nextMsg(helper.getNode('out1'));
    helper.getNode('inv').receive({ payload: { a: 1 } });
    const msg = await reply;

    assert.deepEqual(msg.payload, { echo: { a: 1 } });
    assert.equal(msg.statusCode, 200);
    assert.equal(typeof msg.requestDurationMs, 'number');
    const call = mock.requests.find(r => r.method === 'POST' && r.url === '/');
    assert.deepEqual(call.body, { a: 1 });
    assert.equal(call.headers['content-type'], 'application/json');
});

test('function errors route to the fallback output with response details', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));

    mock.invoke = () => ({ status: 500, body: { error: 'boom' } });
    const reply = nextMsg(helper.getNode('out2'));
    helper.getNode('inv').receive({ payload: 'hi' });
    const msg = await reply;
    assert.equal(msg.statusCode, 500);
    assert.equal(msg.error.message, 'Request failed with status code 500');
});

test('non-transient invoke errors are reported exactly once (Catch fires once)', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));

    mock.invoke = () => ({ status: 500, body: { error: 'boom' } });
    const inv = helper.getNode('inv');
    inv.error.resetHistory();

    const reply = nextMsg(helper.getNode('out2'));
    inv.receive({ payload: 'hi' });
    const msg = await reply;
    assert.equal(msg.statusCode, 500);
    assert.equal(inv.error.callCount, 1);  // node.error triggers Catch nodes
    assert.match(`${inv.error.firstCall.args[0]}`, /boom/);
});

test('transient connectivity errors warn only - no Catch trigger', async () => {
    mock = await startMockNuclio();
    mock.invokeAddress = '127.0.0.1:1';  // closed port -> ECONNREFUSED
    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));

    const inv = helper.getNode('inv');
    inv.error.resetHistory();
    inv.warn.resetHistory();

    const reply = nextMsg(helper.getNode('out2'));
    inv.receive({ payload: 'hi' });
    const msg = await reply;
    assert.equal(msg.error.code, 'ECONNREFUSED');
    assert.equal(inv.error.callCount, 0);  // Catch nodes don't fire
    assert.equal(inv.warn.callCount, 1);
});

test('transient HTTP failures are retried until success', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, {}, { retries: '3', retryDelayMs: '10' }));
    await waitReady(helper.getNode('fn'));

    let calls = 0;
    mock.invoke = () => (++calls < 3 ? { status: 503, body: { error: 'waking' } } : { status: 200, body: { ok: true } });

    const reply = nextMsg(helper.getNode('out1'));
    helper.getNode('inv').receive({ payload: 'hi' });
    const msg = await reply;
    assert.deepEqual(msg.payload, { ok: true });
    assert.equal(msg.statusCode, 200);
    assert.equal(calls, 3);  // two 503s, then success
});

test('exhausted retries fall back with the last transient error, no Catch', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, {}, { retries: '2', retryDelayMs: '10' }));
    await waitReady(helper.getNode('fn'));

    mock.invoke = () => ({ status: 503, body: { error: 'down' } });
    const inv = helper.getNode('inv');
    inv.error.resetHistory();
    inv.warn.resetHistory();

    const reply = nextMsg(helper.getNode('out2'));
    inv.receive({ payload: 'hi' });
    const msg = await reply;
    assert.equal(msg.statusCode, 503);
    assert.equal(msg.error.message, 'Request failed with status code 503');
    // 1 initial attempt + 2 retries
    assert.equal(mock.requests.filter(r => r.method === 'POST' && r.url === '/').length, 3);
    // transient: warns only (retry notices + final), never Catch
    assert.equal(inv.error.callCount, 0);
    assert.equal(inv.warn.callCount, 3);
});

test('non-transient errors are not retried', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, {}, { retries: '3', retryDelayMs: '10' }));
    await waitReady(helper.getNode('fn'));

    mock.invoke = () => ({ status: 500, body: { error: 'boom' } });
    const reply = nextMsg(helper.getNode('out2'));
    helper.getNode('inv').receive({ payload: 'hi' });
    const msg = await reply;
    assert.equal(msg.statusCode, 500);
    // a 500 is a real answer from the function - exactly one attempt
    assert.equal(mock.requests.filter(r => r.method === 'POST' && r.url === '/').length, 1);
});

test('retries default to 0 - transient failure falls back immediately', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));

    mock.invoke = () => ({ status: 503, body: {} });
    const reply = nextMsg(helper.getNode('out2'));
    helper.getNode('inv').receive({ payload: 'hi' });
    const msg = await reply;
    assert.equal(msg.statusCode, 503);
    assert.equal(mock.requests.filter(r => r.method === 'POST' && r.url === '/').length, 1);
});

test('invoke shows a Redeploying status while the function is redeploying', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    const fn = helper.getNode('fn');
    await waitReady(fn);

    fn.redeploying = true;  // simulate a redeploy in flight
    const inv = helper.getNode('inv');
    const reply = nextMsg(helper.getNode('out2'));
    inv.receive({ payload: 'hi' });
    await reply;  // message drops to fallback...
    await waitUntil(
        () => inv.status.getCalls().some(c => c.args[0]?.text === 'Redeploying'),
        { msg: 'Redeploying status on invoke node' },
    );
});

test('custom request headers are sent with invocations', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, {}, { headers: [{ name: 'X-Test', type: 'str', value: 'abc' }] }));
    await waitReady(helper.getNode('fn'));

    const reply = nextMsg(helper.getNode('out1'));
    helper.getNode('inv').receive({ payload: 'hi' });
    await reply;
    const call = mock.requests.find(r => r.method === 'POST' && r.url === '/');
    assert.equal(call.headers['x-test'], 'abc');
});

test('maxInFlight backpressure routes excess messages to the fallback output', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, {}, { maxInFlight: '1' }));
    await waitReady(helper.getNode('fn'));

    mock.invoke = (body) => new Promise(resolve => setTimeout(() => resolve({ status: 200, body: { echo: body } }), 250));

    const results = [];
    const fallbacks = [];
    helper.getNode('out1').on('input', msg => results.push(msg));
    helper.getNode('out2').on('input', msg => fallbacks.push(msg));

    const inv = helper.getNode('inv');
    inv.receive({ payload: 1 });
    inv.receive({ payload: 2 });
    inv.receive({ payload: 3 });

    await waitUntil(() => results.length + fallbacks.length === 3, { msg: 'all messages routed' });
    assert.equal(results.length, 1);
    assert.equal(fallbacks.length, 2);
});

test('messages with no function configured fall back', async () => {
    const flow = [
        { id: 'inv', type: 'nuclio', function: 'missing', timeoutMs: '', maxInFlight: '', headers: [], wires: [['out1'], ['out2']] },
        { id: 'out1', type: 'helper' },
        { id: 'out2', type: 'helper' },
    ];
    await load(flow);
    const reply = nextMsg(helper.getNode('out2'));
    helper.getNode('inv').receive({ payload: 'hi' });
    const msg = await reply;
    assert.equal(msg.payload, 'hi');
});

test('invoke nodes mirror function config errors as status', async () => {
    // no server configured: the config node errors before any invoke node
    // exists - the invoke node must still receive the status on registration
    const flow = [
        { id: 'fn', type: 'nuclio-function', name: FN, runtime: 'python:3.12', code: 'x = 1', configCode: '', env_vars: [], secret_vars: [] },
        { id: 'inv', type: 'nuclio', function: 'fn', timeoutMs: '', maxInFlight: '', headers: [], wires: [['out1'], ['out2']] },
        { id: 'out1', type: 'helper' },
        { id: 'out2', type: 'helper' },
    ];
    await load(flow);
    const inv = helper.getNode('inv');
    await waitUntil(
        () => inv.status.getCalls().some(c => c.args[0]?.text === 'No server'),
        { msg: 'No server status on invoke node' },
    );
});

/* -------------------------------------------------------------------------- */
/*                               Admin Endpoints                              */
/* -------------------------------------------------------------------------- */

test('GET /nuclio/api/functions resolves invoke nodes to their function', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));

    const res = await helper.request().get('/nuclio/api/functions?id=inv').expect(200);
    assert.equal(res.body.metadata.name, FN);
    assert.equal(res.body.status.state, 'ready');
});

test('GET /nuclio/api/functions/logs aggregates per-replica logs', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));

    const res = await helper.request().get('/nuclio/api/functions/logs?id=fn').expect(200);
    assert.deepEqual(res.body, {
        'replica-1': 'logs for replica-1',
        'replica-2': 'logs for replica-2',
    });
});

test('POST /nuclio/api/functions/deploy forces a redeploy', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));

    mock.requests.length = 0;
    await helper.request().post('/nuclio/api/functions/deploy?id=fn').expect(200);
    // unchanged config + force -> desiredState PATCH
    assert.ok(mock.requests.some(r => r.method === 'PATCH'));
});

test('POST /nuclio/api/functions/deploy?rebuild=true forces a rebuild PUT', async () => {
    // unchanged config, but rebuild must PUT without skip-build so Nuclio
    // re-fetches the source (e.g. new commits behind an unchanged git URL)
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));

    mock.requests.length = 0;
    await helper.request().post('/nuclio/api/functions/deploy?id=fn&rebuild=true').expect(200);
    const put = mock.requests.find(r => r.method === 'PUT');
    assert.ok(put, 'expected a PUT');
    assert.equal(put.body.metadata.annotations['skip-build'], undefined);
    assert.ok(!mock.requests.some(r => r.method === 'PATCH'), 'no desiredState PATCH on rebuild');
});

test('unknown node ids return 404', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    await helper.request().get('/nuclio/api/functions?id=nope').expect(404);
});

/* -------------------------------------------------------------------------- */
/*                             Tuning via Config                              */
/* -------------------------------------------------------------------------- */

test('server cadence + function recovery resolve from node config', async () => {
    mock = await startMockNuclio();
    const flow = baseFlow(mock);
    Object.assign(flow[0], { pollMs: '250', backoffMs: '750', requestTimeoutMs: '4000' });  // server node
    Object.assign(flow[1], { maxSelfHealAttempts: '9', redeployDeadlineMs: '30000', autoRedeployOnError: 'true', autoRedeployOnErrorType: 'bool' });  // function node
    await load(flow);

    const srv = helper.getNode('srv');
    assert.equal(srv.pollMs, 250);
    assert.equal(srv.backoffMs, 750);
    assert.equal(srv.requestTimeoutMs, 4000);

    const fn = helper.getNode('fn');
    assert.equal(fn.maxSelfHealAttempts, 9);
    assert.equal(fn.redeployDeadlineMs, 30000);
    assert.equal(fn.autoRedeployOnError, true);
});

test('blank config fields fall back to NUCLIO_* env, then default', async () => {
    process.env.NUCLIO_POLL_MS = '1234';  // env fallback for a blank field
    try {
        mock = await startMockNuclio();
        await load(baseFlow(mock));  // no tuning fields set on the flow
        const srv = helper.getNode('srv');
        assert.equal(srv.pollMs, 1234);        // from env
        assert.equal(srv.readyPollMs, 5000);   // hardcoded default (no env, no config)
    } finally {
        delete process.env.NUCLIO_POLL_MS;
    }
});

test('an env-typed config field reads the named env var at deploy time', async () => {
    process.env.MY_BACKOFF = '4321';
    try {
        mock = await startMockNuclio();
        const flow = baseFlow(mock);
        Object.assign(flow[0], { backoffMs: 'MY_BACKOFF', backoffMsType: 'env' });
        await load(flow);
        assert.equal(helper.getNode('srv').backoffMs, 4321);
    } finally {
        delete process.env.MY_BACKOFF;
    }
});

/* -------------------------------------------------------------------------- */
/*                           State-Machine Scenarios                          */
/* -------------------------------------------------------------------------- */

test('full lifecycle: new function transitions through building → ready', async () => {
    mock = await startMockNuclio();
    mock.nextFnStates[FN] = ['building', 'configuringResources', 'waitingForResourceConfiguration', 'ready'];
    await load(baseFlow(mock));

    const post = await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    assert.equal(post.body.metadata.name, FN);
    assert.equal(post.body.spec.runtime, 'python:3.12');

    const fn = helper.getNode('fn');
    // poll through the transition chain; once ready, invocationUrl is populated
    await waitReady(fn, { timeout: 10000 });
    assert.equal(fn.fnState, 'ready');
    assert.ok(fn.invocationUrl);
    assert.equal(fn.redeploying, false);

    // building/transition requests hit the mock
    assert.ok(mock.requests.some(r => r.method === 'GET' && r.url === `/api/functions/${FN}`));
    assert.equal(mock.functionStates[FN], 'ready');
});

test('building function blocks deploy update', async () => {
    mock = await startMockNuclio();
    mock.nextFnStates[FN] = ['building'];  // stay building forever
    await load(baseFlow(mock));

    await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    // reconcile polls once, consuming the only queue entry; state sticks at building
    await waitUntil(() => mock.requests.some(r => r.method === 'GET' && r.url === `/api/functions/${FN}`));

    await helper.unload();

    // change code and reload while the function is still building
    mock.requests.length = 0;
    await load(baseFlow(mock, { code: 'x = 2' }));

    // the redeploy should see building state and skip the PUT; redeploying clears
    const fn = helper.getNode('fn');
    await waitUntil(() => fn.redeploying === false, { timeout: 8000, msg: 'redeploying cleared' });
    assert.ok(!mock.requests.some(r => r.method === 'PUT'));
    assert.ok(!mock.requests.some(r => r.method === 'PATCH'));
});

test('building → ready transition allows subsequent update', async () => {
    mock = await startMockNuclio();
    mock.nextFnStates[FN] = ['building', 'configuringResources', 'ready'];
    await load(baseFlow(mock));

    await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    await waitReady(helper.getNode('fn'), { timeout: 10000 });

    await helper.unload();

    mock.requests.length = 0;
    await load(baseFlow(mock, { code: 'x = 2' }));

    const put = await mock.waitFor(r => r.method === 'PUT');
    assert.equal(Buffer.from(put.body.spec.build.functionSourceCode, 'base64').toString(), 'x = 2');
});

test('hash survives server-side enrichment (enriched config is a no-op)', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    await waitReady(helper.getNode('fn'));

    // the stored function was enriched with default triggers/resources/minReplicas etc.
    // (see storeFunction deepMergeDefaults). redeploying the same code must be a no-op
    // because the hash annotations survive enrichment.
    await helper.unload();

    mock.requests.length = 0;
    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));

    assert.deepEqual(mock.requests.filter(r => ['POST', 'PUT', 'PATCH'].includes(r.method) && r.url.startsWith('/api/functions')), []);
});

test('project creation happens only when project does not exist', async () => {
    mock = await startMockNuclio();
    const CUSTOM = 'custom-proj';
    const flow = baseFlow(mock);
    flow[1].project = 'proj-node';
    flow[2] = { id: 'proj-node', type: 'nuclio-project', name: CUSTOM, nameType: 'str' };
    await load(flow);

    // the custom project doesn't exist yet -> POST /api/projects
    const post = await mock.waitFor(r => r.method === 'POST' && r.url === '/api/projects');
    assert.equal(post.body.metadata.name, CUSTOM);
    await waitReady(helper.getNode('fn'));
});

test('scaledToZero polls at the scaledToZero interval without self-healing', async () => {
    mock = await startMockNuclio({ functions: { [FN]: { metadata: { name: FN }, spec: {} } }, state: 'scaledToZero' });
    await load(baseFlow(mock));

    // initial startup deploy migrates the pre-seeded (no-hash) function; let it
    // finish, then clear the slate to check no self-heal deploys follow
    const fn = helper.getNode('fn');
    await waitUntil(() => fn.fnState === 'scaledToZero', { timeout: 5000 });
    assert.equal(fn.fnState, 'scaledToZero');

    mock.requests.length = 0;
    // let a few reconcile polls pass
    await new Promise(r => setTimeout(r, 200));
    assert.equal(mock.requests.filter(isDeployWrite).length, 0);
});

test('state null is treated as unhealthy-unknown with debounce', async () => {
    mock = await startMockNuclio({ functions: { [FN]: { metadata: { name: FN }, spec: {} } }, state: null });
    await load(baseFlow(mock));

    const fn = helper.getNode('fn');
    await waitUntil(() => fn.fnState === null, { timeout: 5000 });
    // first poll: unhealthyStreak=1, debounce holds (no deploy)
    await waitUntil(() => fn.lastStatus?.text === 'Unhealthy?', { timeout: 5000 });
});

test('legacy migration works against server-enriched config', async () => {
    // seed a realistic Nuclio-enriched legacy function (pre-hash, with server
    // defaults) and verify the migration PUT correctly identifies no meaningful
    // changes, stamps hashes, and skips the build.
    const enrichedLegacy = {
        apiVersion: 'nuclio.io/v1',
        kind: 'Function',
        metadata: {
            name: FN,
            labels: { 'nuclio.io/project-name': 'default' },
            annotations: { 'nuclio.io/generated-by': 'node-red' },
        },
        spec: {
            runtime: 'python:3.12',
            handler: 'main:handler',
            build: { functionSourceCode: Buffer.from('x = 1').toString('base64') },
            env: [],
            resources: { requests: { cpu: '25m', memory: '1M' }, limits: { cpu: '1', memory: '512M' } },
            triggers: { 'default-http': { kind: 'http', maxWorkers: 1 } },
            minReplicas: 1,
            maxReplicas: 1,
            version: 5,
        },
    };
    mock = await startMockNuclio({ functions: { [FN]: enrichedLegacy }, state: 'ready' });
    await load(baseFlow(mock));

    const put = await mock.waitFor(r => r.method === 'PUT');
    assert.equal(put.body.metadata.annotations['skip-build'], 'true');
    assert.match(put.body.metadata.annotations[HASH_ANNOTATION], /^[0-9a-f]{64}$/);
    assert.match(put.body.metadata.annotations[BUILD_HASH_ANNOTATION], /^[0-9a-f]{64}$/);
    await waitReady(helper.getNode('fn'));

    await helper.unload();

    // second deploy is a hash-based no-op
    mock.requests.length = 0;
    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));
    assert.deepEqual(mock.requests.filter(r => ['POST', 'PUT', 'PATCH'].includes(r.method) && r.url.startsWith('/api/functions')), []);
});
