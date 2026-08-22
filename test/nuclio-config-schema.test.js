const test = require('node:test');
const assert = require('node:assert/strict');
const editor = require('../resources/nuclio-config-schema');

test('Nuclio schema exposes common function configuration keys', () => {
    const spec = editor.getDefinition(['spec']);
    assert.equal(spec.eventTimeout.type, 'string');
    assert.equal(spec.resources.type, 'object');
    assert.equal(spec.triggers.type, 'object');
});

test('Nuclio schema suggests trigger execution settings', () => {
    const text = 'spec:\n  triggers:\n    http:\n      ';
    const labels = editor.completions(text, 3, text.split('\n')[3].length).map(item => item.label);
    assert.ok(labels.includes('mode'));
    assert.ok(labels.includes('batch'));
    assert.ok(labels.includes('numWorkers'));
});

test('Nuclio schema warns on invalid scalar values without rejecting unknown fields', () => {
    const warnings = editor.validate([
        'spec:',
        '  replicas: many',
        '  eventTimeout: 30s',
        '  customFutureField: whatever',
    ].join('\n'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].text, /replicas/);
});
