const test = require('node:test');
const assert = require('node:assert/strict');
const editor = require('../resources/nuclio-config-schema');

test('Nuclio schema exposes common function configuration keys', () => {
    const spec = editor.getDefinition(['spec']);
    assert.equal(spec.eventTimeout.type, 'string');
    assert.equal(spec.resources.type, 'object');
    assert.equal(spec.triggers.type, 'object');
    assert.equal(spec.platform.type, 'object');
    assert.equal(spec.devices.type, 'array');
});

test('Nuclio schema suggests platform attributes', () => {
    const text = 'spec:\n  platform:\n    attributes:\n      ';
    const labels = editor.completions(text, 3, text.split('\n')[3].length).map(item => item.label);
    assert.ok(labels.includes('restartPolicy'));
    assert.ok(labels.includes('mountMode'));
    assert.ok(labels.includes('healthCheckInterval'));
});

test('Nuclio schema suggests trigger execution settings', () => {
    const text = 'spec:\n  triggers:\n    http:\n      ';
    const labels = editor.completions(text, 3, text.split('\n')[3].length).map(item => item.label);
    assert.ok(labels.includes('mode'));
    assert.ok(labels.includes('batch'));
    assert.ok(labels.includes('numWorkers'));
});

test('Nuclio schema suggests enum values', () => {
    const text = 'spec:\n  triggers:\n    http:\n      mode: ';
    const labels = editor.completions(text, 3, text.split('\n')[3].length).map(item => item.label);
    assert.deepEqual(labels, ['sync', 'async']);
});

test('Nuclio schema suggests deployment-only trigger kinds and attributes', () => {
    const kindText = 'spec:\n  triggers:\n    source:\n      kind: ';
    const kindLabels = editor.completions(kindText, 3, kindText.split('\n')[3].length).map(item => item.label);
    assert.ok(kindLabels.includes('mqtt'));
    assert.ok(kindLabels.includes('natsjetstream'));
    assert.ok(kindLabels.includes('v3ioStream'));

    const attributeText = [
        'spec:',
        '  triggers:',
        '    source:',
        '      kind: natsjetstream',
        '      attributes:',
        '        ',
    ].join('\n');
    const attributeLabels = editor.completions(attributeText, 5, attributeText.split('\n')[5].length)
        .map(item => item.label);
    assert.ok(attributeLabels.includes('stream'));
    assert.ok(attributeLabels.includes('consumer'));
    assert.ok(attributeLabels.includes('allowReconnect'));

    const mqttText = [
        'spec:',
        '  triggers:',
        '    source:',
        '      kind: mqtt',
        '      attributes:',
        '        subscriptions:',
        '          ',
    ].join('\n');
    const mqttLabels = editor.completions(mqttText, 6, mqttText.split('\n')[6].length)
        .map(item => item.label);
    assert.ok(mqttLabels.includes('topic'));
    assert.ok(mqttLabels.includes('qos'));
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
