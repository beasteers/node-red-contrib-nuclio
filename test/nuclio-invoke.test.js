const { test } = require('node:test');
const assert = require('node:assert/strict');
const { invokeWithRetry } = require('../lib/nuclio-invoke');

const makeNodes = (overrides = {}) => {
    const statuses = [];
    const warnings = [];
    const node = {
        closed: false,
        counter: 0,
        retries: 0,
        retryDelayMs: 0,
        timeoutMs: 1000,
        redeploying: false,
        statusDebounced: status => statuses.push(status),
        warn: warning => warnings.push(warning),
        ...overrides.node,
    };
    const fnNode = {
        invocationUrl: 'http://first.test',
        invocationUrls: ['http://first.test'],
        fnConfigSpec: { name: 'test-function' },
        fnState: 'ready',
        ...overrides.fnNode,
    };
    return { node, fnNode, statuses, warnings };
};

test('invokes successfully and records the response', async () => {
    const { node, fnNode, statuses } = makeNodes();
    const msg = { payload: { input: 1 } };

    const result = await invokeWithRetry({
        node,
        fnNode,
        msg,
        headers: { 'Content-Type': 'application/json' },
        request: async (url, payload, options) => {
            assert.equal(url, 'http://first.test');
            assert.deepEqual(payload, { input: 1 });
            assert.equal(options.timeout, 1000);
            return { data: { output: 2 }, status: 200 };
        },
    });

    assert.equal(result.error, null);
    assert.equal(result.transientError, false);
    assert.deepEqual(result.response, { data: { output: 2 }, status: 200 });
    assert.deepEqual(msg.payload, { output: 2 });
    assert.equal(fnNode.fnInvocationStatus, 200);
    assert.equal(node.counter, 0);
    assert.equal(statuses.at(-1).fill, 'green');
});

test('fails over to the next endpoint after a connectivity error', async () => {
    const { node, fnNode, warnings } = makeNodes({
        fnNode: {
            invocationUrls: ['http://first.test', 'http://second.test'],
        },
    });
    const urls = [];

    const result = await invokeWithRetry({
        node,
        fnNode,
        msg: { payload: 'input' },
        headers: {},
        request: async url => {
            urls.push(url);
            if (url === 'http://first.test') throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
            return { data: 'output', status: 200 };
        },
    });

    assert.equal(result.error, null);
    assert.deepEqual(urls, ['http://first.test', 'http://second.test']);
    assert.equal(fnNode.invocationUrl, 'http://second.test');
    assert.equal(warnings.length, 1);
    assert.equal(node.counter, 0);
});

test('retries transient HTTP failures up to the configured limit', async () => {
    const { node, fnNode, warnings } = makeNodes({
        node: { retries: 1 },
    });
    let calls = 0;

    const result = await invokeWithRetry({
        node,
        fnNode,
        msg: { payload: 'input' },
        headers: {},
        request: async () => {
            calls++;
            if (calls === 1) {
                throw Object.assign(new Error('unavailable'), {
                    response: { status: 503, headers: {} },
                });
            }
            return { data: 'output', status: 200 };
        },
    });

    assert.equal(result.error, null);
    assert.equal(calls, 2);
    assert.equal(warnings.length, 1);
    assert.equal(node.counter, 0);
});
