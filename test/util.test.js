const { test } = require('node:test');
const assert = require('node:assert/strict');
const { diff, merge, parseIntFallback, asString, splitByDotWithEscape, nestedAssign, redactPaths, stableStringify, hashConfig, retryBackoff, isTransientErrorCode, isTransientHttpStatus, isTransientError } = require('../lib/util');


/* ----------------------------------- diff ---------------------------------- */

test('diff detects string changes', () => {
    assert.deepEqual(diff({ spec: { handler: 'a' } }, { spec: { handler: 'b' } }), { spec: { handler: 'a' } });
});

test('diff detects numeric changes', () => {
    // regression: _.isEmpty(2) === true used to swallow scalar changes
    assert.deepEqual(diff({ spec: { minReplicas: 2 } }, { spec: { minReplicas: 1 } }), { spec: { minReplicas: 2 } });
});

test('diff detects boolean changes', () => {
    assert.deepEqual(diff({ spec: { disabled: true } }, { spec: { disabled: false } }), { spec: { disabled: true } });
});

test('diff detects new keys', () => {
    assert.deepEqual(diff({ a: 1, b: 2 }, { a: 1 }), { b: 2 });
});

test('diff returns empty for identical objects', () => {
    assert.deepEqual(diff({ a: 1, b: { c: 'x' } }, { a: 1, b: { c: 'x' } }), {});
});

test('diff treats empty containers and missing values as equal', () => {
    assert.deepEqual(diff({ a: {}, b: [], c: '' }, {}), {});
    assert.deepEqual(diff({ a: { b: {} } }, { a: undefined }), {});
});

test('diff recurses into nested objects', () => {
    assert.deepEqual(
        diff({ spec: { build: { commands: ['pip install x'] } } }, { spec: { build: { commands: [] } } }),
        { spec: { build: { commands: { 0: 'pip install x' } } } },
    );
});

test('diff handles nullish b', () => {
    assert.deepEqual(diff({ a: 1 }, undefined), { a: 1 });
    assert.deepEqual(diff({ a: 1 }, null), { a: 1 });
});

/* ---------------------------------- merge ---------------------------------- */

test('merge replaces arrays instead of merging by index', () => {
    assert.deepEqual(merge({}, { env: [{ name: 'A' }, { name: 'B' }] }, { env: [{ name: 'C' }] }), { env: [{ name: 'C' }] });
});

test('merge deep-merges plain objects', () => {
    assert.deepEqual(merge({}, { a: { b: 1 } }, { a: { c: 2 } }), { a: { b: 1, c: 2 } });
});

/* ------------------------------ small helpers ------------------------------ */

test('parseIntFallback parses ints and falls back', () => {
    assert.equal(parseIntFallback('5000', 1), 5000);
    assert.equal(parseIntFallback(undefined, 1), 1);
    assert.equal(parseIntFallback('abc', 1), 1);
});

test('asString stringifies non-strings', () => {
    assert.equal(asString('x'), 'x');
    assert.equal(asString(5), '5');
    assert.equal(asString({ a: 1 }), '{"a":1}');
});

test('splitByDotWithEscape splits on dots, honors escapes', () => {
    assert.deepEqual(splitByDotWithEscape('a.b.c'), ['a', 'b', 'c']);
    assert.deepEqual(splitByDotWithEscape('metadata.annotations.nuclio\\.io/x'), ['metadata', 'annotations', 'nuclio.io/x']);
});

test('nestedAssign sets deep paths, creating objects as needed', () => {
    const obj = { spec: { existing: 1 } };
    nestedAssign(obj, 'spec.build.codeEntryAttributes.s3SecretAccessKey', 'shh');
    assert.deepEqual(obj, { spec: { existing: 1, build: { codeEntryAttributes: { s3SecretAccessKey: 'shh' } } } });
});

test('nestedAssign honors escaped dots in keys', () => {
    const obj = {};
    nestedAssign(obj, 'metadata.annotations.nuclio\\.io/x', 'v');
    assert.deepEqual(obj, { metadata: { annotations: { 'nuclio.io/x': 'v' } } });
});

test('nestedAssign rejects prototype-chain keys instead of polluting', () => {
    assert.throws(() => nestedAssign({}, '__proto__.polluted', 'yes'), /Unsafe key/);
    assert.throws(() => nestedAssign({}, 'a.__proto__.polluted', 'yes'), /Unsafe key/);
    assert.throws(() => nestedAssign({}, 'constructor.prototype.polluted', 'yes'), /Unsafe key/);
    assert.throws(() => nestedAssign({}, 'spec.__proto__', 'yes'), /Unsafe key/);
    assert.equal({}.polluted, undefined);
});

test('redactPaths copies and redacts escaped nested paths', () => {
    const source = { spec: { env: [{ name: 'TOKEN', value: 'secret' }], 'a.b': { value: 'keep' } } };
    const redacted = redactPaths(source, ['spec.env.0.value', 'spec.a\\.b.value']);
    assert.equal(redacted.spec.env[0].value, '[redacted]');
    assert.equal(redacted.spec['a.b'].value, '[redacted]');
    assert.equal(source.spec.env[0].value, 'secret');
});

/* ------------------------------ stable hashing ------------------------------ */

test('stableStringify is independent of key order, preserves array order', () => {
    assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
    assert.equal(stableStringify({ x: { d: 1, c: [1, 2] } }), '{"x":{"c":[1,2],"d":1}}');
    // array order is meaningful (e.g. env vars) - not sorted
    assert.notEqual(stableStringify([{ name: 'A' }, { name: 'B' }]), stableStringify([{ name: 'B' }, { name: 'A' }]));
});

test('hashConfig is deterministic and sensitive to changes', () => {
    const a = hashConfig({ spec: { env: [{ name: 'A', value: '1' }], build: { functionSourceCode: 'eA==' } } });
    const b = hashConfig({ spec: { build: { functionSourceCode: 'eA==' }, env: [{ name: 'A', value: '1' }] } });
    assert.equal(a, b);  // key order irrelevant
    assert.notEqual(a, hashConfig({ spec: { env: [{ name: 'A', value: '2' }], build: { functionSourceCode: 'eA==' } } }));
});

test('retryBackoff doubles per attempt, caps, and honors Retry-After', () => {
    assert.equal(retryBackoff(1, 500), 500);
    assert.equal(retryBackoff(2, 500), 1000);
    assert.equal(retryBackoff(3, 500), 2000);
    assert.equal(retryBackoff(10, 500), 10000);       // backoff capped
    assert.equal(retryBackoff(1, 500, '3'), 3000);    // Retry-After wins when larger
    assert.equal(retryBackoff(3, 500, '1'), 2000);    // ...but not when smaller
    assert.equal(retryBackoff(1, 500, '999'), 30000); // Retry-After capped too
    assert.equal(retryBackoff(1, 500, 'garbage'), 500);  // bogus header ignored
});

/* -------------------------- transient classification -------------------------- */

test('classifies transient connection errors and HTTP statuses consistently', () => {
    assert.equal(isTransientErrorCode('ECONNRESET'), true);
    assert.equal(isTransientErrorCode('EINVAL'), false);
    assert.equal(isTransientHttpStatus(503), true);
    assert.equal(isTransientHttpStatus(504), true);
    assert.equal(isTransientHttpStatus(500), false);
    assert.equal(isTransientError({ code: 'ETIMEDOUT' }), true);
    assert.equal(isTransientError({ response: { status: 429 } }), true);
    assert.equal(isTransientError({ response: { status: 400 } }), false);
});
