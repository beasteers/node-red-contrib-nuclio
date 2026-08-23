const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    correlationId,
    parseArgs,
    percentile,
    runBenchmark,
    summarize,
} = require('../scripts/stress-test');

test('stress-test argument parsing applies safe trigger defaults', () => {
    const options = parseArgs(['--trigger', 'nats', '--rate', '25', '--duration', '2']);

    assert.equal(options.rate, 25);
    assert.equal(options.duration, 2);
    assert.equal(options.subject, 'demo.nats.input');
    assert.equal(options.concurrency, 100);
    assert.equal(options.endpoint, 'external');
});

test('stress-test extracts correlation IDs from wrapped trigger responses', () => {
    assert.equal(correlationId({ id: 'direct' }), 'direct');
    assert.equal(correlationId({ received: { id: 'wrapped' } }), 'wrapped');
    assert.equal(correlationId({ payload: { correlationId: 'payload' } }), 'payload');
    assert.equal(correlationId({ value: true }), undefined);
});

test('stress-test calculates latency percentiles and offered load', () => {
    assert.equal(percentile([3, 1, 2], 0.5), 2);
    assert.deepEqual(summarize({
        attempted: 2,
        completed: 2,
        errors: 0,
        rejectedByClient: 1,
        timeouts: 0,
        unmatchedResponses: 0,
        latencies: [1, 3],
        wallDurationMs: 12,
    }, 100), {
        offered: 3,
        attempted: 2,
        completed: 2,
        errors: 0,
        rejectedByClient: 1,
        timeouts: 0,
        unmatchedResponses: 0,
        durationMs: 100,
        wallDurationMs: 12,
        completedPerSecond: 20,
        latencyMs: { p50: 1, p95: 1, p99: 1, max: 3 },
    });
});

test('stress-test enforces the client concurrency limit with a mock transport', async () => {
    const options = parseArgs([
        '--trigger', 'http', '--url', 'http://example.test', '--requests', '4',
        '--rate', '0', '--duration', '1', '--warmup', '0', '--concurrency', '2',
    ]);
    const result = await runBenchmark(options, {
        transportFactory: async () => ({
            description: 'mock',
            send: async payload => {
                await new Promise(resolve => setTimeout(resolve, 5));
                return { body: { id: payload.id }, latencyMs: 5 };
            },
            close: async () => {},
        }),
    });

    assert.equal(result.summary.offered, 4);
    assert.equal(result.summary.attempted, 2);
    assert.equal(result.summary.completed, 2);
    assert.equal(result.summary.rejectedByClient, 2);
});
