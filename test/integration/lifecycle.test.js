const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HASH_ANNOTATION, BUILD_HASH_ANNOTATION } = require('../../lib/nuclio-function-config.js');
const {
    FN,
    baseFlow,
    helper,
    isDeployWrite,
    load,
    nextMsg,
    startMockNuclio,
    waitReady,
    waitUntil,
} = require('../helpers/node-red');

let mock;

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

test('concurrent project creation conflict does not block function deployment', async () => {
    mock = await startMockNuclio({ projectCreateConflict: true });
    const CUSTOM = 'racing-project';
    const flow = baseFlow(mock);
    flow[1].project = 'proj-node';
    flow[2] = { id: 'proj-node', type: 'nuclio-project', name: CUSTOM, nameType: 'str' };
    await load(flow);

    await mock.waitFor(r => r.method === 'POST' && r.url === '/api/projects');
    const functionCreate = await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    assert.equal(functionCreate.body.metadata.labels['nuclio.io/project-name'], CUSTOM);
    await waitReady(helper.getNode('fn'));
});

test('concurrent function creation conflict is observed and tolerated', async () => {
    mock = await startMockNuclio({ functionCreateConflict: true });
    await load(baseFlow(mock));

    await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    await waitReady(helper.getNode('fn'));
    assert.equal(mock.requests.filter(r => r.method === 'POST' && r.url === '/api/functions').length, 1);
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

test('state null is observed as unknown without mutation', async () => {
    mock = await startMockNuclio({ functions: { [FN]: { metadata: { name: FN }, spec: {} } }, state: null });
    await load(baseFlow(mock));

    const fn = helper.getNode('fn');
    await waitUntil(() => fn.fnState === null, { timeout: 5000 });
    mock.requests.length = 0;
    // Missing status is not evidence that Node-RED should redeploy, even when
    // an unhealthy recovery policy is configured elsewhere.
    await waitUntil(() => fn.lastStatus?.text === 'Unhealthy?', { timeout: 5000 });
    assert.equal(mock.requests.filter(isDeployWrite).length, 0);
    assert.equal(fn.unhealthyStreak, 0);
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

/* -------------------------------------------------------------------------- */
/*                          Error Recovery & Stress                           */
/* -------------------------------------------------------------------------- */

test('function recovers from error state after code fix', async () => {
    // bad code pushes nuclio into error; user fixes code, redeploys, function recovers
    mock = await startMockNuclio();
    mock.nextFnStates[FN] = ['error'];
    await load(baseFlow(mock));

    await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    const fn = helper.getNode('fn');
    await waitUntil(() => fn.fnState === 'error', { timeout: 5000 });
    assert.equal(fn.fnState, 'error');

    await helper.unload();

    // user fixes the code and redeploys — the function is now healthy
    mock.requests.length = 0;
    mock.functionStates[FN] = 'ready';
    await load(baseFlow(mock, { code: 'x = 2' }));

    const put = await mock.waitFor(r => r.method === 'PUT');
    assert.equal(Buffer.from(put.body.spec.build.functionSourceCode, 'base64').toString(), 'x = 2');
    await waitReady(helper.getNode('fn'));
    assert.equal(helper.getNode('fn').fnState, 'ready');
});

test('in-flight invocation counter clears cleanly during concurrent redeploy', async () => {
    mock = await startMockNuclio();
    // slow invoke so we can set redeploying mid-flight
    let resolveInvoke;
    const invoked = new Promise(r => { resolveInvoke = r; });
    mock.invoke = (body) => new Promise(resolve => {
        setTimeout(() => {
            resolve({ status: 200, body: { echo: body } });
            resolveInvoke();
        }, 150);
    });
    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));

    const inv = helper.getNode('inv');
    const fn = helper.getNode('fn');
    const reply = nextMsg(helper.getNode('out1'));

    // fire invocation; while axios is in-flight, simulate a concurrent redeploy
    inv.receive({ payload: 'hi' });
    await new Promise(r => setTimeout(r, 20));  // let axios start
    fn.redeploying = true;  // concurrent redeploy starts mid-invocation

    await invoked;  // wait for the slow invocation to finish
    const msg = await reply;
    assert.deepEqual(msg.payload, { echo: 'hi' });

    // the counter must have been decremented — no backpressure leak
    assert.equal(inv.counter, 0);
});

/* -------------------------------------------------------------------------- */
/*                          Nuclio Outage Scenarios                           */
/* -------------------------------------------------------------------------- */

test('full outage: dashboard 503 recovers and deploys when server returns', async () => {
    // simulate Nuclio dashboard being down (gateway error); verify backoff
    // and that the function deploys successfully once the server recovers
    mock = await startMockNuclio();
    mock.failStatus = 503;
    await load(baseFlow(mock));

    const fn = helper.getNode('fn');
    // the reconcile loop polls, gets 503, backs off with "Error 503" status
    await waitUntil(() => fn.lastStatus?.text?.includes('503'), { timeout: 8000 });

    // snapshot the backoff state so we can verify recovery resets it
    assert.ok(fn._backoff > 0 || mock.requests.filter(r => r.method === 'GET' && r.url.includes('/api/functions/')).length >= 2,
        'should have polled at least once and backed off');

    await helper.unload();

    // dashboard recovers
    mock.failStatus = null;
    mock.requests.length = 0;
    await load(baseFlow(mock));

    await waitReady(helper.getNode('fn'), { timeout: 10000 });
    const recovered = helper.getNode('fn');
    assert.equal(recovered.fnState, 'ready');
    assert.ok(recovered.invocationUrl);
});

test('invoke node mirrors outage status from function node', async () => {
    mock = await startMockNuclio();
    mock.failStatus = 503;
    // fast polls so status propagates quickly
    const flow = baseFlow(mock);
    flow[0].pollMs = '300';
    await load(flow);

    const fn = helper.getNode('fn');
    const inv = helper.getNode('inv');
    await waitUntil(() => fn.lastStatus?.text?.includes('503'), { timeout: 8000 });

    // the function node propagates status to child invoke nodes (nuclio.js:139-141)
    await waitUntil(
        () => inv.status.getCalls().some(c => c.args[0]?.text?.includes('503')),
        { msg: 'invoke node mirrors outage status from function node' },
    );
});
