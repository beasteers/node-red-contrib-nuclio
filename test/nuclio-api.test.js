const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildFunctionConfig, STATUSES, WAITING, BUILDING } = require('../lib/nuclio-api');


/* --------------------------- buildFunctionConfig --------------------------- */

const base = { name: 'fn', code: 'x = 1', config: {}, runtime: 'python:3.12' };

test('handler entrypoint per runtime', () => {
    assert.equal(buildFunctionConfig({ ...base, runtime: 'python:3.12' }).spec.handler, 'main:handler');
    assert.equal(buildFunctionConfig({ ...base, runtime: 'golang' }).spec.handler, 'main:Handler');
    assert.equal(buildFunctionConfig({ ...base, runtime: 'nodejs' }).spec.handler, 'handler:handler');
    assert.equal(buildFunctionConfig({ ...base, runtime: 'shell' }).spec.handler, 'main.sh:handler');
});

test('source code is base64 encoded; empty code is omitted', () => {
    const body = buildFunctionConfig({ ...base, code: 'print(1)' });
    assert.equal(Buffer.from(body.spec.build.functionSourceCode, 'base64').toString(), 'print(1)');
    assert.equal(buildFunctionConfig({ ...base, code: '  ' }).spec.build.functionSourceCode, undefined);
});

test('project label and generated-by annotation are always set', () => {
    const body = buildFunctionConfig({ ...base, project: 'proj', annotations: { a: '1' } });
    assert.equal(body.metadata.labels['nuclio.io/project-name'], 'proj');
    assert.equal(body.metadata.annotations['nuclio.io/generated-by'], 'node-red');
    assert.equal(body.metadata.annotations.a, '1');
    assert.equal(buildFunctionConfig(base).metadata.labels['nuclio.io/project-name'], 'default');
});

test('node-level env vars come before config spec env', () => {
    const body = buildFunctionConfig({
        ...base,
        env: [{ name: 'A', value: '1' }],
        config: { spec: { env: [{ name: 'B', value: '2' }] } },
    });
    assert.deepEqual(body.spec.env.map(e => e.name), ['A', 'B']);
});

test('user config can override runtime/handler but not name', () => {
    const body = buildFunctionConfig({
        ...base,
        config: { metadata: { name: 'evil' }, spec: { handler: 'custom:entry' } },
    });
    assert.equal(body.metadata.name, 'fn');
    assert.equal(body.spec.handler, 'custom:entry');
});

/* --------------------------------- STATUSES -------------------------------- */

test('every documented nuclio state has a status entry', () => {
    const states = ['ready', 'imported', 'building', 'configuringResources', 'scaledToZero', 'error', 'unhealthy', ...WAITING, ...BUILDING];
    for (const state of states) {
        assert.ok(STATUSES[state], `missing STATUSES entry for ${state}`);
    }
});
