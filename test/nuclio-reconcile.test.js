const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getInvocationUrl } = require('../lib/nuclio-reconcile');


test('getInvocationUrl prefers the internal url', () => {
    const url = getInvocationUrl({
        status: { internalInvocationUrls: ['10.0.0.1:8080'], externalInvocationUrls: ['fn.example.com'] },
    }, {});
    assert.equal(url, 'http://10.0.0.1:8080');
});

test('getInvocationUrl falls back to the external url', () => {
    const url = getInvocationUrl({ status: { externalInvocationUrls: ['fn.example.com'] } }, {});
    assert.equal(url, 'https://fn.example.com');
});

test('getInvocationUrl keeps the last known url when none reported', () => {
    const url = getInvocationUrl({ status: {} }, { invocationUrl: 'http://10.0.0.9:8080' });
    assert.equal(url, 'http://10.0.0.9:8080');
});
