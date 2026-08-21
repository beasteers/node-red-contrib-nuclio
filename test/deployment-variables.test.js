const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    interpolateConfig,
    interpolateString,
    resolveEntries,
} = require('../lib/nuclio-deployment-variables');

test('interpolates variables and nested Bash-style defaults without shell evaluation', () => {
    const variables = new Map([
        ['PRIMARY', { value: '', secret: false }],
        ['SECONDARY', { value: 'arm64v8/', secret: false }],
    ]);
    assert.equal(
        interpolateString('gcr.io/iguazio/${PRIMARY:-${SECONDARY}}alpine:3.23', variables).value,
        'gcr.io/iguazio/arm64v8/alpine:3.23',
    );
    assert.equal(interpolateString('$(echo untouched)', variables).value, '$(echo untouched)');
});

test('missing variables fail unless a default is provided', () => {
    assert.throws(
        () => interpolateString('${MISSING}', new Map()),
        /Deployment variable "MISSING" is not defined/,
    );
    assert.equal(interpolateString('${MISSING:-fallback}', new Map()).value, 'fallback');
});

test('interpolation reports secret-bearing YAML paths without exposing values', () => {
    const result = interpolateConfig({
        spec: {
            build: { baseImage: 'registry/${IMAGE_SUFFIX}' },
            env: [{ name: 'TOKEN', value: '${TOKEN}' }],
        },
    }, new Map([
        ['IMAGE_SUFFIX', { value: 'private', secret: true }],
        ['TOKEN', { value: 'do-not-log', secret: true }],
    ]));

    assert.equal(result.value.spec.build.baseImage, 'registry/private');
    assert.equal(result.value.spec.env[0].value, 'do-not-log');
    assert.deepEqual(result.secretPaths.sort(), ['spec.build.baseImage', 'spec.env.0.value']);
});

test('deployment variable entries resolve environment and credential sources', () => {
    process.env.NUCLIO_TEST_ARCH_PREFIX = 'arm64v8/';
    try {
        const RED = { util: { evaluateNodeProperty: (value, type) => type === 'env' ? process.env[value] : value } };
        const variables = resolveEntries(RED, {}, [
            { name: 'ARCH_PREFIX', type: 'env', value: 'NUCLIO_TEST_ARCH_PREFIX' },
            { name: 'TOKEN', type: 'cred', value: 'secret-value' },
        ]);
        assert.deepEqual(variables.get('ARCH_PREFIX'), { value: 'arm64v8/', secret: false });
        assert.deepEqual(variables.get('TOKEN'), { value: 'secret-value', secret: true });
    } finally {
        delete process.env.NUCLIO_TEST_ARCH_PREFIX;
    }
});
