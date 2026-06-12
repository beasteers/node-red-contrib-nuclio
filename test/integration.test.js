const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const helper = require('node-red-node-test-helper');
const nuclioNodes = require('../lib/nuclio.js');
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
    () => fnNode.urls?.invocation && !fnNode.redeploying,
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
    // project was created first
    assert.ok(mock.requests.some(r => r.method === 'POST' && r.url === '/api/projects'));
    // and the function settles to ready
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

test('unknown node ids return 404', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    await helper.request().get('/nuclio/api/functions?id=nope').expect(404);
});
