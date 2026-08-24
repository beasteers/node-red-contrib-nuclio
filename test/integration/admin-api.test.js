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
} = require('../helpers/node-red');

let mock;

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

test('orphan discovery is project-scoped and only reports Node-RED-owned functions', async () => {
    mock = await startMockNuclio({
        functions: {
            'old-function': {
                metadata: {
                    name: 'old-function',
                    labels: { 'nuclio.io/project-name': 'default' },
                    annotations: {
                        'nuclio.io/node-red': 'true',
                        'nuclio.io/node-red-node-id': 'removed-node',
                    },
                },
                spec: {},
            },
            'manual-function': {
                metadata: {
                    name: 'manual-function',
                    labels: { 'nuclio.io/project-name': 'default' },
                    annotations: {},
                },
                spec: {},
            },
            'other-project-function': {
                metadata: {
                    name: 'other-project-function',
                    labels: { 'nuclio.io/project-name': 'other-project' },
                    annotations: { 'nuclio.io/node-red': 'true' },
                },
                spec: {},
            },
        },
    });
    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));

    const response = await helper.request().get('/nuclio/api/orphans?id=fn').expect(200);
    assert.equal(response.body.project, 'default');
    assert.deepEqual(response.body.desired, [FN]);
    assert.deepEqual(response.body.orphans.map(orphan => orphan.name), ['old-function']);
});

test('orphan pruning requires ownership and deletes only an explicit orphan', async () => {
    mock = await startMockNuclio({
        functions: {
            'old-function': {
                metadata: {
                    name: 'old-function',
                    labels: { 'nuclio.io/project-name': 'default' },
                    annotations: { 'nuclio.io/node-red': 'true' },
                },
                spec: {},
            },
            'manual-function': {
                metadata: {
                    name: 'manual-function',
                    labels: { 'nuclio.io/project-name': 'default' },
                    annotations: {},
                },
                spec: {},
            },
        },
    });
    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));

    await helper.request().post('/nuclio/api/orphans/prune?id=fn&name=manual-function').expect(409);
    await helper.request().post(`/nuclio/api/orphans/prune?id=fn&name=${FN}`).expect(409);
    assert.ok(mock.functions['manual-function']);
    assert.ok(mock.functions[FN]);

    const response = await helper.request().post('/nuclio/api/orphans/prune?id=fn&name=old-function').expect(200);
    assert.equal(response.body.deleted, 'old-function');
    assert.equal(mock.functions['old-function'], undefined);
    assert.equal(mock.requests.filter(request => request.method === 'DELETE').length, 1);
});

test('orphan pruning is disabled with deployment policy disabled', async () => {
    mock = await startMockNuclio({
        functions: {
            'old-function': {
                metadata: {
                    name: 'old-function',
                    labels: { 'nuclio.io/project-name': 'default' },
                    annotations: { 'nuclio.io/node-red': 'true' },
                },
                spec: {},
            },
        },
    });
    const flow = baseFlow(mock);
    Object.assign(flow[0], { deploymentPolicy: 'disabled', deploymentPolicyType: 'str' });
    await load(flow);

    await helper.request().post('/nuclio/api/orphans/prune?id=fn&name=old-function').expect(409);
    assert.ok(mock.functions['old-function']);
    assert.equal(mock.requests.some(request => request.method === 'DELETE'), false);
});

test('prune input command deletes an explicit orphan and acknowledges it', async () => {
    mock = await startMockNuclio({
        functions: {
            'old-function': {
                metadata: {
                    name: 'old-function',
                    labels: { 'nuclio.io/project-name': 'default' },
                    annotations: { 'nuclio.io/node-red': 'true' },
                },
                spec: {},
            },
        },
    });
    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));

    const acknowledgement = nextMsg(helper.getNode('out1'));
    helper.getNode('inv').receive({ nuclio: { command: 'prune', target: 'old-function' } });
    const msg = await acknowledgement;
    assert.equal(msg.nuclio.result.deleted, 'old-function');
    assert.equal(mock.functions['old-function'], undefined);
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

test('manual deploy accepts an asynchronous function visibility window', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));

    mock.requests.length = 0;
    mock.hideFunctionAfterWrite = true;
    const res = await helper.request().post('/nuclio/api/functions/deploy?id=fn').expect(202);
    assert.equal(res.body.accepted, true);
    assert.equal(res.body.metadata.name, FN);
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

