const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getCredentialEntries, resolveTypedValue } = require('../lib/nuclio-credential-entries');
const credentialList = require('../resources/nuclio-credential-list');

test('credential list editor storage keeps credential values out of flow entries', () => {
    const secret = 'Bearer very-secret-token';
    const node = {
        credentials: {
            headerCredentials: JSON.stringify([
                { name: 'Authorization', type: 'cred', value: secret },
                { name: 'X-Mode', type: 'str', value: 'test' },
            ]),
        },
    };

    const entries = credentialList.getEntries(node, [
        { name: 'Authorization', type: 'cred', value: credentialList.PASSWORD_SENTINEL },
    ], 'headerCredentials');
    assert.equal(entries[0].value, secret);

    const flowEntries = credentialList.saveEntries(node, 'headerCredentials', [
        { name: 'Authorization', type: 'cred', value: credentialList.PASSWORD_SENTINEL },
        { name: 'X-Mode', type: 'str', value: 'production' },
    ], name => name.toLowerCase());

    assert.equal(flowEntries[0].value, credentialList.PASSWORD_SENTINEL);
    assert.equal(flowEntries[1].value, 'production');
    assert.doesNotMatch(JSON.stringify(flowEntries), /very-secret-token/);
    assert.equal(JSON.parse(node.credentials.headerCredentials)[0].value, secret);
    assert.equal(JSON.parse(node.credentials.headerCredentials)[1].value, 'production');
});

test('credential list editor removes the credential field when no credential rows remain', () => {
    const node = {
        credentials: {
            environmentVariables: JSON.stringify([
                { name: 'TOKEN', type: 'cred', value: 'secret' },
            ]),
        },
    };

    const flowEntries = credentialList.saveEntries(node, 'environmentVariables', [
        { name: 'MODE', type: 'str', value: 'test' },
    ]);

    assert.deepEqual(flowEntries, [{ name: 'MODE', type: 'str', value: 'test' }]);
    assert.equal(node.credentials.environmentVariables, undefined);
});

test('runtime credential entries take precedence over ordinary flow entries', () => {
    const node = {
        credentials: {
            environmentVariables: JSON.stringify([
                { name: 'TOKEN', type: 'cred', value: 'runtime-secret' },
            ]),
        },
    };
    const flowEntries = [{ name: 'TOKEN', type: 'cred', value: credentialList.PASSWORD_SENTINEL }];

    const entries = getCredentialEntries(node, flowEntries, 'environmentVariables');
    assert.equal(resolveTypedValue({}, node, null, entries[0]), 'runtime-secret');
});

