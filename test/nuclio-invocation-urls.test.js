const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getInvocationUrl, getInvocationUrlOptions, getInvocationUrls, serviceInvocationUrl } = require('../lib/nuclio-invocation-urls');


test('internal preference uses the reported internal url', () => {
    const url = getInvocationUrl({
        status: { internalInvocationUrls: ['10.0.0.1:8080'], externalInvocationUrls: ['fn.example.com'] },
    }, { server: { invocationUrlPreference: 'internal' } });
    assert.equal(url, 'http://10.0.0.1:8080');
});

test('external preference uses the reported external url', () => {
    const url = getInvocationUrl({ status: { externalInvocationUrls: ['fn.example.com'] } }, {
        server: { invocationUrlPreference: 'external' },
    });
    assert.equal(url, 'https://fn.example.com');
});

test('getInvocationUrls preserves explicit schemes and supports external preference', () => {
    const urls = getInvocationUrls({
        status: {
            internalInvocationUrls: ['10.0.0.1:8080'],
            externalInvocationUrls: ['http://fn.example.com'],
        },
    }, { server: { invocationUrlPreference: 'external' } });
    assert.deepEqual(urls, ['http://fn.example.com']);
});

test('getInvocationUrlOptions exposes every configured invocation endpoint source', () => {
    const options = getInvocationUrlOptions({
        status: {
            internalInvocationUrls: ['10.0.0.1:8080'],
            externalInvocationUrls: ['fn.example.com'],
        },
    }, {
        name: 'echo',
        server: { invocationUrlPreference: 'internal' },
    });
    assert.equal(options.preference, 'internal');
    assert.deepEqual(options.urls, ['http://10.0.0.1:8080']);
    assert.deepEqual(options.serviceUrls, ['http://nuclio-echo:8080']);
    assert.deepEqual(options.internalUrls, ['http://10.0.0.1:8080']);
    assert.deepEqual(options.externalUrls, ['https://fn.example.com']);
});

test('getInvocationUrls applies the configured protocol to scheme-less external urls', () => {
    const urls = getInvocationUrls({ status: { externalInvocationUrls: ['fn.example.com'] } }, {
        server: { invocationUrlPreference: 'external', externalInvocationProtocol: 'http' },
    });
    assert.deepEqual(urls, ['http://fn.example.com']);
});

test('service preference uses stable function DNS instead of dashboard IPs', () => {
    const server = { invocationUrlPreference: 'service' };
    const urls = getInvocationUrls({ status: { internalInvocationUrls: ['172.18.0.9:8080'] } }, {
        name: 'dewlit-logic',
        server,
    });
    assert.deepEqual(urls, ['http://nuclio-dewlit-logic:8080']);
    assert.equal(serviceInvocationUrl('endless-api', server), 'http://nuclio-endless-api:8080');
});

test('service preference accepts a Docker hostname template', () => {
    const server = {
        invocationUrlPreference: 'service',
        internalInvocationServiceHost: 'nuclio-nuclio-{function}',
    };
    assert.equal(serviceInvocationUrl('endless-api', server), 'http://nuclio-nuclio-endless-api:8080');
});

test('internal preference preserves the reported internal URL', () => {
    const urls = getInvocationUrls({ status: { internalInvocationUrls: ['172.18.0.9:8080'] } }, {
        server: { invocationUrlPreference: 'internal' },
    });
    assert.deepEqual(urls, ['http://172.18.0.9:8080']);
});

test('getInvocationUrl keeps the last known url when none reported', () => {
    const url = getInvocationUrl({ status: {} }, {
        invocationUrl: 'http://10.0.0.9:8080',
        server: { invocationUrlPreference: 'service' },
    });
    assert.equal(url, 'http://10.0.0.9:8080');
});

test('non-HTTP functions do not expose an HTTP invocation endpoint', () => {
    const options = getInvocationUrlOptions({
        spec: {
            disableDefaultHTTPTrigger: true,
            triggers: {
                nats: { kind: 'nats' },
            },
        },
        status: {
            internalInvocationUrls: ['10.0.0.1:8080'],
            externalInvocationUrls: ['fn.example.com'],
        },
    }, { name: 'nats-worker', server: { invocationUrlPreference: 'service' } });

    assert.equal(options.httpTrigger, false);
    assert.deepEqual(options.urls, []);
    assert.deepEqual(options.serviceUrls, []);
    assert.deepEqual(options.internalUrls, []);
    assert.deepEqual(options.externalUrls, []);
});

test('disabling the default HTTP trigger without explicit triggers is non-HTTP', () => {
    const options = getInvocationUrlOptions({
        spec: { disableDefaultHTTPTrigger: true },
        status: { internalInvocationUrls: ['10.0.0.1:8080'] },
    }, { name: 'nats-worker', server: { invocationUrlPreference: 'service' } });

    assert.equal(options.httpTrigger, false);
    assert.deepEqual(options.urls, []);
});
