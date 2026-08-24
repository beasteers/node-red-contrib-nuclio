const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    capacityText,
    decorateStatus,
    inFlightText,
    replicaText,
} = require('../lib/nuclio-node-status');

test('formats observed replicas and capped in-flight work compactly', () => {
    const fnNode = {
        statusSnapshot: { status: { readyReplicas: 2, desiredReplicas: 2 } },
    };
    const node = { counter: 4, maxInFlight: 32 };

    assert.equal(replicaText(fnNode), '2/2r');
    assert.equal(inFlightText(node), '4/32i');
    assert.equal(capacityText(fnNode, node), '2/2r · 4/32i');
});

test('uses available replicas and omits idle in-flight work', () => {
    const fnNode = {
        statusSnapshot: { status: { availableReplicas: 1, replicas: 3 } },
    };

    assert.equal(replicaText(fnNode), '1/3r');
    assert.equal(inFlightText({ counter: 0, maxInFlight: 10 }), '');
    assert.equal(capacityText(fnNode, { counter: 0, maxInFlight: 10 }), '1/3r');
});

test('uses live active replica data with configured fixed replicas', () => {
    const fnNode = {
        statusSnapshot: {
            status: { activeReplicas: 1 },
            spec: { replicas: 2 },
        },
    };

    assert.equal(replicaText(fnNode), '1/2r');
});

test('preserves status state while appending capacity', () => {
    const status = { fill: 'red', shape: 'ring', text: 'Backpressure' };
    const fnNode = {
        statusSnapshot: { status: { readyReplicas: 2, desiredReplicas: 2 } },
    };

    assert.deepEqual(decorateStatus(status, fnNode, { counter: 4, maxInFlight: 4 }), {
        fill: 'red',
        shape: 'ring',
        text: 'Backpressure · 2/2r · 4/4i',
    });
});

test('does not invent capacity when Nuclio has not reported replicas', () => {
    const status = { fill: 'green', shape: 'dot', text: '' };
    assert.deepEqual(decorateStatus(status, {}, { counter: 0, maxInFlight: 0 }), status);
});
