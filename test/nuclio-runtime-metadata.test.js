const test = require('node:test');
const assert = require('node:assert/strict');
const metadata = require('../resources/nuclio-runtime-metadata');

test('runtime metadata includes editor samples for Java and .NET Core', () => {
    assert.deepEqual(metadata.find(item => item.value === 'java'), {
        value: 'java',
        base: 'java',
        label: 'Java',
        language: 'java',
        handler: 'EmptyHandler',
    });
    assert.deepEqual(metadata.find(item => item.value === 'dotnetcore'), {
        value: 'dotnetcore',
        base: 'dotnetcore',
        label: '.NET Core',
        language: 'csharp',
        handler: 'nuclio:empty',
    });
});
