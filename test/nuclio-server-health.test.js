const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDashboardHealth } = require('../lib/nuclio-server-health');

test('dashboard circuit opens after consecutive transient failures and recovers with one probe', () => {
    let now = 0;
    const health = createDashboardHealth({
        failureThreshold: 3,
        baseCooldownMs: 100,
        maxCooldownMs: 400,
        now: () => now,
    });
    const transient = { code: 'ECONNREFUSED' };

    for (let i = 0; i < 2; i++) {
        const permit = health.acquire();
        health.failure(permit, transient);
    }
    assert.equal(health.snapshot().state, 'closed');
    assert.equal(health.snapshot().consecutiveFailures, 2);

    const finalPermit = health.acquire();
    health.failure(finalPermit, transient);
    assert.equal(health.snapshot().state, 'open');
    assert.throws(() => health.acquire(), err =>
        err.code === 'NUCLIO_CIRCUIT_OPEN' && err.retryAfterMs === 100,
    );

    now = 100;
    const probe = health.acquire();
    assert.equal(health.snapshot().state, 'half-open');
    assert.throws(() => health.acquire(), err => err.code === 'NUCLIO_CIRCUIT_OPEN');

    health.success(probe);
    assert.deepEqual(health.snapshot(), {
        state: 'closed',
        consecutiveFailures: 0,
        cooldownMs: 100,
        nextProbeAt: 0,
        probeInFlight: false,
    });
});

test('valid dashboard responses do not trip the availability circuit', () => {
    const health = createDashboardHealth({ failureThreshold: 3 });
    health.failure(health.acquire(), { code: 'ECONNREFUSED' });
    health.failure(health.acquire(), { code: 'ECONNREFUSED' });
    health.failure(health.acquire(), { response: { status: 404 } });
    assert.equal(health.snapshot().state, 'closed');
    assert.equal(health.snapshot().consecutiveFailures, 0);
});
