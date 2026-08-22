const { isTransientErrorCode, isTransientHttpStatus } = require('./util');

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_BASE_COOLDOWN_MS = 5000;
const DEFAULT_MAX_COOLDOWN_MS = 60000;

const healthByServer = new WeakMap();

class CircuitOpenError extends Error {
    constructor(retryAfterMs) {
        super(`Nuclio dashboard is unavailable; retry in ${Math.ceil(retryAfterMs / 1000)}s`);
        this.name = 'CircuitOpenError';
        this.code = 'NUCLIO_CIRCUIT_OPEN';
        this.statusCode = 503;
        this.retryAfterMs = retryAfterMs;
        this.isCircuitOpen = true;
    }
}

const isDashboardFailure = err =>
    isTransientErrorCode(err?.code) || isTransientHttpStatus(err?.response?.status);

const createDashboardHealth = ({
    failureThreshold = DEFAULT_FAILURE_THRESHOLD,
    baseCooldownMs = DEFAULT_BASE_COOLDOWN_MS,
    maxCooldownMs = DEFAULT_MAX_COOLDOWN_MS,
    now = () => Date.now(),
} = {}) => {
    let state = 'closed';
    let consecutiveFailures = 0;
    let cooldownMs = baseCooldownMs;
    let nextProbeAt = 0;
    let probeInFlight = false;

    const open = () => {
        state = 'open';
        nextProbeAt = now() + cooldownMs;
        cooldownMs = Math.min(cooldownMs * 2, maxCooldownMs);
        probeInFlight = false;
    };

    const close = () => {
        state = 'closed';
        consecutiveFailures = 0;
        cooldownMs = baseCooldownMs;
        nextProbeAt = 0;
        probeInFlight = false;
    };

    return {
        acquire() {
            const currentTime = now();
            if (state === 'open') {
                if (currentTime < nextProbeAt) {
                    throw new CircuitOpenError(nextProbeAt - currentTime);
                }
                state = 'half-open';
            }

            if (state === 'half-open') {
                if (probeInFlight) {
                    throw new CircuitOpenError(Math.max(1, nextProbeAt - currentTime));
                }
                probeInFlight = true;
                return { probe: true };
            }

            return { probe: false };
        },

        success(permit) {
            // Any HTTP response proves that the dashboard is reachable. This
            // includes valid 404/401/403 responses, which are API or config
            // problems rather than availability failures.
            if (permit?.probe || state !== 'closed') close();
            else {
                consecutiveFailures = 0;
                cooldownMs = baseCooldownMs;
            }
        },

        failure(permit, err) {
            if (!isDashboardFailure(err)) {
                // A non-transient response proves the control plane answered.
                close();
                return;
            }

            if (permit?.probe || state === 'half-open') {
                open();
                return;
            }

            consecutiveFailures++;
            if (consecutiveFailures >= failureThreshold) open();
        },

        snapshot() {
            return {
                state,
                consecutiveFailures,
                cooldownMs,
                nextProbeAt,
                probeInFlight,
            };
        },
    };
};

const getDashboardHealth = server => {
    if (!server || typeof server !== 'object') return createDashboardHealth();
    let health = healthByServer.get(server);
    if (!health) {
        health = createDashboardHealth();
        healthByServer.set(server, health);
    }
    return health;
};

const isCircuitOpenError = err => err?.isCircuitOpen === true
    || err?.code === 'NUCLIO_CIRCUIT_OPEN';

module.exports = {
    CircuitOpenError,
    createDashboardHealth,
    getDashboardHealth,
    isCircuitOpenError,
    isDashboardFailure,
};
