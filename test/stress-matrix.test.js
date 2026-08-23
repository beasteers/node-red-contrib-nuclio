const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseCli, runMatrix, toStressArgs } = require('../scripts/stress-matrix');

test('stress matrix converts case options into stress-test arguments', () => {
    assert.deepEqual(toStressArgs({ inputTopic: 'demo/input', payloadSize: 128 }, 50), [
        '--input-topic', 'demo/input', '--payload-size', '128', '--rate', '50',
    ]);
});

test('stress matrix runs cases sequentially at each selected rate', async () => {
    const seen = [];
    const results = await runMatrix({
        config: path.join(__dirname, '..', 'scripts', 'stress-matrix.example.json'),
        rates: [10, 20],
        overrides: { duration: 0, warmup: 0 },
        failFast: false,
    }, {
        benchmark: async options => {
            seen.push(`${options.trigger}:${options.rate}`);
            return { summary: { completed: 1, errors: 0, latencyMs: { p95: 1 } } };
        },
    });

    assert.deepEqual(seen, [
        'http:10', 'http:20',
        'mqtt:10', 'mqtt:20',
        'nats:10', 'nats:20',
    ]);
    assert.equal(results.length, 6);
    assert.equal(results.every(result => !result.error), true);
});

test('stress matrix CLI parses rates and overrides', () => {
    const cli = parseCli(['--config', 'matrix.json', '--rates', '10,100', '--duration', '30', '--fail-fast']);

    assert.deepEqual(cli.rates, [10, 100]);
    assert.equal(cli.overrides.duration, '30');
    assert.equal(cli.failFast, true);
});
