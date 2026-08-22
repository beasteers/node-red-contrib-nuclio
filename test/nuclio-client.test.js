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

test('deleteFunction URI-encodes the function name', async () => {
    let requestUrl;
    const server = http.createServer((req, res) => {
        requestUrl = req.url;
        res.writeHead(204);
        res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
        const address = `http://127.0.0.1:${server.address().port}`;
        const client = createClient(
            { address, namespace: 'nuclio', requestTimeoutMs: 1000, deployTimeoutMs: 1000 },
            'default',
        );
        await client.deleteFunction('function/name');
        assert.equal(requestUrl, '/api/functions/function%2Fname');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('project requests use the project namespace header', async () => {
    let requestHeaders;
    const server = http.createServer((req, res) => {
        requestHeaders = req.headers;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
        const address = `http://127.0.0.1:${server.address().port}`;
        const client = createClient(
            { address, namespace: 'custom-namespace', requestTimeoutMs: 1000, deployTimeoutMs: 1000 },
            'project-a',
        );
        await client.listProjects();
        assert.equal(requestHeaders['x-nuclio-project-namespace'], 'custom-namespace');
        assert.equal(requestHeaders['x-nuclio-function-namespace'], undefined);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('dashboard circuit state is shared by clients using the same server', async () => {
    let requestCount = 0;
    const server = http.createServer((req, res) => {
        requestCount++;
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unavailable' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
        const address = `http://127.0.0.1:${server.address().port}`;
        const config = { address, namespace: 'nuclio', requestTimeoutMs: 1000, deployTimeoutMs: 1000 };
        const firstClient = createClient(config, 'project-a');
        const secondClient = createClient(config, 'project-b');

        for (const request of [
            () => firstClient.listFunctions(),
            () => secondClient.listProjects(),
            () => firstClient.getFunction('fn'),
        ]) {
            await assert.rejects(request, err => err.response?.status === 503);
        }

        let circuitError;
        try {
            await secondClient.getFunction('fn');
        } catch (err) {
            circuitError = err;
        }
        assert.equal(circuitError?.code, 'NUCLIO_CIRCUIT_OPEN');
        assert.equal(requestCount, 3);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('dashboard requests are aborted by the caller signal', async () => {
    const server = http.createServer(() => {
        // Deliberately leave the request pending until the client aborts it.
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
        const controller = new AbortController();
        const address = `http://127.0.0.1:${server.address().port}`;
        const client = createClient(
            { address, namespace: 'nuclio', requestTimeoutMs: 10000, deployTimeoutMs: 10000 },
            'default',
            { signal: controller.signal },
        );
        const request = client.getFunction('fn');
        setTimeout(() => controller.abort(), 20);
        await assert.rejects(request, err => err.code === 'ERR_CANCELED');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
