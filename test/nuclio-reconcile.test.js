const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getUrls } = require('../lib/nuclio-reconcile');


test('getUrls prefers internal invocation url', () => {
    const urls = getUrls({
        metadata: { name: 'fn', namespace: 'ns' },
        status: { internalInvocationUrls: ['10.0.0.1:8080'], externalInvocationUrls: ['fn.example.com'] },
    }, {});
    assert.equal(urls.internal, 'http://10.0.0.1:8080');
    assert.equal(urls.external, 'https://fn.example.com');
    assert.equal(urls.invocation, 'http://10.0.0.1:8080');
    assert.equal(urls.kubernetes, 'http://fn.ns.svc.cluster.local:8080');
    assert.equal(urls.docker, 'http://nuclio-ns-fn:8080');
});

test('getUrls keeps the last known invocation url when none reported', () => {
    const node = { name: 'fn', urls: { invocation: 'http://10.0.0.9:8080' } };
    const urls = getUrls({ metadata: { name: 'fn' }, status: {} }, node);
    assert.equal(urls.invocation, 'http://10.0.0.9:8080');
});

test('getUrls healthcheck swaps to port 8082', () => {
    const urls = getUrls({
        metadata: { name: 'fn' },
        status: { internalInvocationUrls: ['10.0.0.1:8080'] },
    }, {});
    assert.equal(urls.healthcheck, 'http://10.0.0.1:8082/__internal/health');
});
