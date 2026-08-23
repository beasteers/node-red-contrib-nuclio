const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseCli, runScenario, toStressArgs } = require('../scripts/stress-scenario');

test('stress scenario converts camelCase defaults into stress arguments', () => {
    assert.deepEqual(toStressArgs({
        trigger: 'http',
        payloadSize: 256,
        sampleInterval: 500,
    }), [
        '--trigger', 'http', '--payload-size', '256', '--sample-interval', '500',
    ]);
});

test('stress scenario runs phases in order and disables repeated warmups', async () => {
    const seen = [];
    const result = await runScenario({
        config: path.join(__dirname, '..', 'scripts', 'stress-scenario.compose.json'),
        quiet: true,
    }, {
        benchmark: async options => {
            seen.push({ rate: options.rate, warmup: options.warmup });
            return {
                target: 'mock',
                options: { rate: options.rate, duration: options.duration },
                summary: {
                    offered: options.rate,
                    attempted: options.rate,
                    completed: options.rate,
                    errors: 0,
                    rejectedByClient: 0,
                    timeouts: 0,
                    unmatchedResponses: 0,
                    durationMs: options.duration * 1000,
                    wallDurationMs: options.duration * 1000,
                    completedPerSecond: options.rate,
                    latencyMs: { p95: 1 },
                },
                errors: {},
                samples: [{ replicas: 1 }],
            };
        },
    });

    assert.deepEqual(seen, [
        { rate: 100, warmup: 5 },
        { rate: 500, warmup: 0 },
        { rate: 100, warmup: 0 },
    ]);
    assert.equal(result.summary.phases, 3);
    assert.equal(result.summary.successfulPhases, 3);
    assert.equal(result.summary.failedPhases, 0);
    assert.equal(result.summary.completed, 700);
    assert.equal(result.phases[1].samples[0].phase, 'sustained-peak');
});

test('stress scenario CLI parses config and failure policy', () => {
    const cli = parseCli(['--config', 'scenario.json', '--output', 'result.json', '--quiet', '--fail-fast']);

    assert.equal(cli.config, 'scenario.json');
    assert.equal(cli.output, 'result.json');
    assert.equal(cli.quiet, true);
    assert.equal(cli.failFast, true);
});
