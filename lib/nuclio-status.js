const { getClient } = require('./nuclio-client');

const DEFAULT_NAMESPACE = 'nuclio';
const MIN_STATUS_CACHE_AGE_MS = 250;
const BATCH_UNSUPPORTED_TTL_MS = 60000;

const coordinatorKey = (namespace, projectName) => `${namespace}\u0000${projectName}`;

const getCoordinator = (node) => {
    const server = node.server;
    if (!server) return null;

    const namespace = server.namespace || DEFAULT_NAMESPACE;
    const projectName = node.project?.name || 'default';
    server.statusCoordinators ||= new Map();
    const key = coordinatorKey(namespace, projectName);
    let coordinator = server.statusCoordinators.get(key);
    if (!coordinator) {
        coordinator = {
            server,
            namespace,
            projectName,
            members: new Set(),
            snapshot: null,
            refreshedAt: 0,
            refreshPromise: null,
            lastError: null,
            lastErrorAt: 0,
            batchUnsupportedUntil: 0,
        };
        server.statusCoordinators.set(key, coordinator);
    }
    return coordinator;
};

const registerFunction = (node) => {
    const coordinator = getCoordinator(node);
    if (!coordinator) return null;
    coordinator.members.add(node);
    coordinator.snapshot = null;
    coordinator.refreshedAt = 0;
    coordinator.batchUnsupportedUntil = 0;
    node.statusCoordinator = coordinator;
    return coordinator;
};

const unregisterFunction = (node) => {
    const coordinator = node.statusCoordinator;
    if (!coordinator) return;
    coordinator.members.delete(node);
    coordinator.snapshot = null;
    coordinator.refreshedAt = 0;
    if (!coordinator.members.size) {
        node.server?.statusCoordinators?.delete(coordinatorKey(coordinator.namespace, coordinator.projectName));
    }
    node.statusCoordinator = null;
};

const invalidateStatus = (node) => {
    const coordinator = node.statusCoordinator;
    if (!coordinator) return;
    coordinator.snapshot = null;
    coordinator.refreshedAt = 0;
    coordinator.lastError = null;
    coordinator.lastErrorAt = 0;
};

const cacheAgeFor = (node) => {
    const server = node.server || {};
    const interval = node.fnState === 'ready' ? server.readyPollMs : server.pollMs;
    return Math.max(MIN_STATUS_CACHE_AGE_MS, interval || 1000);
};

const refresh = (node, coordinator, maxAge) => {
    const now = Date.now();
    if (coordinator.snapshot && now - coordinator.refreshedAt <= maxAge) {
        return Promise.resolve(coordinator.snapshot);
    }
    if (coordinator.lastError && now - coordinator.lastErrorAt <= maxAge) {
        return Promise.reject(coordinator.lastError);
    }
    if (coordinator.refreshPromise) return coordinator.refreshPromise;

    const promise = getClient(node).listFunctions()
        .then(response => {
            if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) {
                throw new Error('Nuclio function list response was not an object');
            }
            coordinator.snapshot = response.data;
            coordinator.refreshedAt = Date.now();
            coordinator.lastError = null;
            coordinator.lastErrorAt = 0;
            return coordinator.snapshot;
        })
        .catch(err => {
            coordinator.lastError = err;
            coordinator.lastErrorAt = Date.now();
            throw err;
        })
        .finally(() => {
            coordinator.refreshPromise = null;
        });
    coordinator.refreshPromise = promise;
    return promise;
};

const functionNotFound = (node) => {
    const error = new Error(`Function ${node.name} was not found in project ${node.project?.name || 'default'}`);
    error.response = {
        status: 404,
        headers: { 'content-type': 'application/json' },
        data: { error: error.message },
    };
    return error;
};

const getStatus = async (node) => {
    const coordinator = node.statusCoordinator;
    if (!coordinator || coordinator.members.size < 2 || Date.now() < coordinator.batchUnsupportedUntil) {
        return getClient(node).getFunction(node.name);
    }

    let snapshot;
    try {
        snapshot = await refresh(node, coordinator, cacheAgeFor(node));
    } catch (err) {
        // Older or proxy-wrapped dashboards may not expose the list endpoint.
        // Fall back to the established per-function endpoint for this project.
        if (err.response?.status === 404) {
            coordinator.batchUnsupportedUntil = Date.now() + BATCH_UNSUPPORTED_TTL_MS;
            return getClient(node).getFunction(node.name);
        }
        throw err;
    }

    const functionData = snapshot[node.name];
    if (!functionData) throw functionNotFound(node);
    return { status: 200, data: functionData };
};

module.exports = {
    DEFAULT_NAMESPACE,
    getStatus,
    registerFunction,
    unregisterFunction,
    invalidateStatus,
};
