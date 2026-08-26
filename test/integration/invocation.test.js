const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    FN,
    baseFlow,
    helper,
    load,
    nextMsg,
    startMockNuclio,
    waitReady,
    waitUntil,
} = require('../helpers/node-red');

let mock;

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

test('lazy functions wait for a deploy command before accepting invocations', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, { deploymentMode: 'lazy' }));

    assert.deepEqual(mock.requests, []);
    const statusReply = nextMsg(helper.getNode('out1'));
    helper.getNode('inv').receive({ nuclio: { command: 'status' }, payload: 'control' });
    const status = await statusReply;
    assert.deepEqual(status.nuclio.result, {
        state: null,
        ready: false,
        deploying: false,
        deploymentMode: 'lazy',
        activated: false,
    });
    assert.deepEqual(mock.requests, []);

    const fallback = nextMsg(helper.getNode('out2'));
    helper.getNode('inv').receive({ payload: 'before-deploy' });
    const blocked = await fallback;
    assert.equal(blocked.payload, 'before-deploy');
    assert.deepEqual(mock.requests, []);

    const deployReply = nextMsg(helper.getNode('out1'));
    helper.getNode('inv').receive({ nuclio: { command: 'deploy' }, payload: 'control' });
    const deployed = await deployReply;
    assert.equal(deployed.nuclio.command, 'deploy');
    assert.equal(deployed.nuclio.result.accepted, true);
    assert.equal(deployed.nuclio.result.ready, true);
    assert.ok(mock.requests.some(r => r.method === 'POST' && r.url === '/api/functions'));

    const invocationReply = nextMsg(helper.getNode('out1'));
    helper.getNode('inv').receive({ payload: 'after-deploy' });
    const invocation = await invocationReply;
    assert.deepEqual(invocation.payload, { echo: 'after-deploy' });
});

test('lifecycle commands work for functions without an HTTP trigger', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, {
        configCode: `apiVersion: nuclio.io/v1
kind: NuclioFunction
spec:
  disableDefaultHTTPTrigger: true
  triggers:
    nats:
      kind: nats
      url: nats://nats:4222
      attributes:
        topic: demo.request
        reply: true`,
    }));

    const fn = helper.getNode('fn');
    await waitUntil(() => fn.fnState === 'ready' && !fn.redeploying, { msg: 'non-HTTP function ready' });
    assert.equal(fn.invocationUrl, undefined);

    const summary = await helper.request().get('/nuclio/api/functions?id=fn&view=summary').expect(200);
    assert.equal(summary.body.httpTrigger, false);
    assert.deepEqual(summary.body.invocation.urls, []);
    assert.deepEqual(summary.body.invocation.triggerSummaries, [{
        name: 'nats',
        kind: 'nats',
        topic: 'demo.request',
    }]);

    const statusReply = nextMsg(helper.getNode('out1'));
    helper.getNode('inv').receive({ nuclio: { command: 'status' }, payload: 'status' });
    const status = await statusReply;
    assert.equal(status.nuclio.result.ready, true);

    const redeployReply = nextMsg(helper.getNode('out1'));
    helper.getNode('inv').receive({ nuclio: { command: 'redeploy' }, payload: 'redeploy' });
    const redeployed = await redeployReply;
    assert.equal(redeployed.nuclio.result.ready, true);
    assert.ok(mock.requests.some(request => request.method === 'PATCH'), 'redeploy should work without an HTTP trigger');

    const fallback = nextMsg(helper.getNode('out2'));
    helper.getNode('inv').receive({ payload: 'not an HTTP invocation' });
    const msg = await fallback;
    assert.equal(msg.payload, 'not an HTTP invocation');
    assert.equal(mock.requests.filter(request => request.method === 'POST' && request.url === '/').length, 0);
});

test('undeploy deactivates eager functions until an explicit deploy command', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));

    mock.requests.length = 0;
    const undeployReply = nextMsg(helper.getNode('out1'));
    helper.getNode('inv').receive({ nuclio: { command: 'undeploy' }, payload: 'control' });
    const undeployed = await undeployReply;

    assert.deepEqual(undeployed.nuclio.result, {
        accepted: true,
        deleted: true,
        name: FN,
        state: null,
        ready: false,
        deploying: false,
        deploymentMode: 'eager',
        activated: false,
    });
    assert.equal(mock.functions[FN], undefined);
    assert.ok(mock.requests.some(request => request.method === 'DELETE'));

    const blockedReply = nextMsg(helper.getNode('out2'));
    helper.getNode('inv').receive({ payload: 'while-undeployed' });
    assert.equal((await blockedReply).payload, 'while-undeployed');

    const deployReply = nextMsg(helper.getNode('out1'));
    helper.getNode('inv').receive({ nuclio: { command: 'deploy' }, payload: 'control' });
    const deployed = await deployReply;
    assert.equal(deployed.nuclio.result.accepted, true);
    assert.equal(deployed.nuclio.result.activated, true);
    assert.ok(mock.requests.some(request => request.method === 'POST' && request.url === '/api/functions'));
});

test('undeploy cannot be undone by an in-flight missing-function reconciliation', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));

    let releaseStatus;
    mock.statusGate = new Promise(resolve => { releaseStatus = resolve; });
    mock.requests.length = 0;
    const fn = helper.getNode('fn');
    fn.reconcileWake?.();
    await mock.waitFor(request => request.method === 'GET' && request.url === `/api/functions/${FN}`);

    const undeployReply = nextMsg(helper.getNode('out1'));
    helper.getNode('inv').receive({ nuclio: { command: 'undeploy' }, payload: 'control' });
    const undeployed = await undeployReply;
    assert.equal(undeployed.nuclio.result.deleted, true);
    assert.equal(mock.functions[FN], undefined);

    // The blocked status GET now observes the deletion and returns 404. The
    // generation guard must discard that stale reconcile result rather than
    // recreating the function.
    releaseStatus();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(mock.functions[FN], undefined);
    assert.equal(mock.requests.filter(request => request.method === 'POST' && request.url === '/api/functions').length, 0);
});

test('invoke lifecycle commands map to idempotent deploy, redeploy, and rebuild operations', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));

    for (const command of ['deploy', 'redeploy', 'rebuild']) {
        mock.requests.length = 0;
        const reply = nextMsg(helper.getNode('out1'));
        helper.getNode('inv').receive({ nuclio: { command }, payload: command });
        const result = await reply;
        assert.equal(result.nuclio.command, command);
        assert.equal(result.nuclio.result.accepted, true);
        assert.equal(result.nuclio.result.ready, true);
        if (command === 'deploy') {
            assert.equal(mock.requests.some(r => ['PUT', 'PATCH'].includes(r.method)), false,
                'ordinary deploy should reconcile without forcing a write');
        }
        if (command === 'redeploy') {
            assert.ok(mock.requests.some(r => r.method === 'PATCH'),
                'redeploy should patch desired state');
        }
        if (command === 'rebuild') {
            const put = mock.requests.find(r => r.method === 'PUT');
            assert.ok(put, 'rebuild should update the function');
            assert.equal(put.body.metadata.annotations['skip-build'], undefined);
        }
    }
});

test('function errors route to the fallback output with response details', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));

    mock.invoke = () => ({ status: 500, body: { error: 'boom' } });
    const reply = nextMsg(helper.getNode('out2'));
    helper.getNode('inv').receive({ payload: 'hi' });
    const msg = await reply;
    assert.equal(msg.payload, 'hi');
    assert.deepEqual(msg.response.data, { error: 'boom' });
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

test('internal invocation does not fall back to external HTTP', async () => {
    mock = await startMockNuclio();
    mock.invokeAddress = '127.0.0.1:1';
    mock.externalInvocationUrls = [`http://127.0.0.1:${mock.port}`];
    const flow = baseFlow(mock);
    flow[0].externalInvocationProtocol = 'http';
    await load(flow);
    await waitReady(helper.getNode('fn'));

    const reply = nextMsg(helper.getNode('out2'));
    helper.getNode('inv').receive({ payload: 'hi' });
    const msg = await reply;
    assert.equal(msg.error.code, 'ECONNREFUSED');
    assert.equal(helper.getNode('fn').invocationUrl, 'http://127.0.0.1:1');
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

test('closing an invoke node stops pending retries', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, {}, { retries: '3', retryDelayMs: '100' }));
    await waitReady(helper.getNode('fn'));

    mock.invoke = () => ({ status: 503, body: { error: 'down' } });
    const inv = helper.getNode('inv');
    inv.receive({ payload: 'hi' });
    await waitUntil(() => inv.warn.callCount >= 1, { msg: 'first retry warning' });
    const attemptsBeforeClose = mock.requests.filter(r => r.method === 'POST' && r.url === '/').length;

    await helper.unload();
    await new Promise(r => setTimeout(r, 250));
    const attemptsAfterClose = mock.requests.filter(r => r.method === 'POST' && r.url === '/').length;
    assert.equal(attemptsAfterClose, attemptsBeforeClose);
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
        () => inv.status.getCalls().some(c => c.args[0]?.text?.includes('Redeploying')),
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
    assert.equal(call.headers['x-nuclio-target'], FN);
});

test('credential-backed request headers are not retained in the flow configuration', async () => {
    mock = await startMockNuclio();
    const flow = baseFlow(mock, {}, {
        headers: [{ name: 'X-Token', type: 'cred', value: '__PWRD__' }],
    });
    await load(flow, {
        inv: {
            headerCredentials: JSON.stringify([
                { name: 'X-Token', type: 'cred', value: 'secret-header-value' },
            ]),
        },
    });
    await waitReady(helper.getNode('fn'));

    const reply = nextMsg(helper.getNode('out1'));
    helper.getNode('inv').receive({ payload: 'hi' });
    const msg = await reply;

    const call = mock.requests.find(r => r.method === 'POST' && r.url === '/');
    assert.equal(call.headers['x-token'], 'secret-header-value');
    assert.equal(flow[2].headers[0].value, '__PWRD__');
    assert.doesNotMatch(JSON.stringify(flow), /secret-header-value/);
    assert.equal(msg.response.config, undefined);
    assert.doesNotMatch(JSON.stringify(msg.response), /secret-header-value/);
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
        { id: 'fn', type: 'nuclio-function', name: FN, runtime: 'python:3.12', code: 'x = 1', configCode: '', env_vars: [] },
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
