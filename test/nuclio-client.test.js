const http = require('node:http');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('../lib/nuclio-client');

test('Nuclio resource path segments are URI encoded', async () => {
    let requestUrl;
    let requestHeaders;
    const server = http.createServer((req, res) => {
        requestUrl = req.url;
        requestHeaders = req.headers;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
        const address = `http://127.0.0.1:${server.address().port}`;
        const client = createClient(
            { address, namespace: 'custom-namespace', requestTimeoutMs: 1000, deployTimeoutMs: 1000 },
            'default',
        );
        await client.getLogs('function/name', 'replica name');
        assert.equal(
            requestUrl,
            '/api/functions/function%2Fname/logs/replica%20name?follow=false&tailLines=70',
        );
        assert.equal(requestHeaders['x-nuclio-function-namespace'], 'custom-namespace');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
