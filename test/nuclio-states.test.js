const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BUILDING, WAITING, STATUSES, POLL_MS, canUpdateFunction } = require('../lib/nuclio-states');

test('state metadata covers all build and wait states', () => {
    for (const state of BUILDING) {
        assert.ok(STATUSES[state]);
        assert.equal(POLL_MS[state], undefined);
        assert.equal(canUpdateFunction(state), false);
    }
    for (const state of WAITING) {
        assert.ok(STATUSES[state]);
        assert.equal(POLL_MS[state], 3000);
        assert.equal(canUpdateFunction(state), false);
    }
});

test('only known non-transition states are updateable', () => {
    assert.equal(canUpdateFunction('ready'), true);
    assert.equal(canUpdateFunction('imported'), true);
    assert.equal(canUpdateFunction('unknownFutureState'), false);
    assert.equal(canUpdateFunction(null), false);
});
