const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildAuthHeaders } = require('../lib/nuclio-auth');

test('builds Basic and Bearer dashboard authorization headers', () => {
    assert.deepEqual(buildAuthHeaders({
        authType: 'basic',
        username: 'alice',
        password: 's3cret',
    }), {
        Authorization: `Basic ${Buffer.from('alice:s3cret').toString('base64')}`,
    });
    assert.deepEqual(buildAuthHeaders({ authType: 'bearer', token: 'token-value' }), {
        Authorization: 'Bearer token-value',
    });
});

test('preserves custom headers without allowing reserved scope headers', () => {
    assert.deepEqual(buildAuthHeaders({
        requestHeaders: [{ name: 'X-Organization', value: 'team-a' }],
    }), { 'X-Organization': 'team-a' });
    assert.throws(
        () => buildAuthHeaders({ requestHeaders: [{ name: 'x-nuclio-project-name', value: 'other' }] }),
        /reserved/,
    );
    assert.throws(
        () => buildAuthHeaders({ authType: 'bearer', token: 'token', requestHeaders: [{ name: 'Authorization', value: 'other' }] }),
        /authentication mode/,
    );
});

test('fails closed when an authentication credential is missing', () => {
    assert.throws(() => buildAuthHeaders({ authType: 'basic', username: 'alice' }), /username and password/);
    assert.throws(() => buildAuthHeaders({ authType: 'bearer' }), /requires a token/);
});
