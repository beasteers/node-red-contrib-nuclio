const { getClient } = require('./nuclio-client');

const DEFAULT_NAMESPACE = 'nuclio';
const MIN_STATUS_CACHE_AGE_MS = 250;
const REPLICA_STATUS_CACHE_AGE_MS = 5000;
const REPLICA_UNSUPPORTED_TTL_MS = 60000;
const BATCH_UNSUPPORTED_TTL_MS = 60000;
const NODE_RED_OWNERSHIP_ANNOTATION = 'nuclio.io/node-red';
const NODE_RED_NODE_ID_ANNOTATION = 'nuclio.io/node-red-node-id';
const GENERATED_BY_ANNOTATION = 'nuclio.io/generated-by';

const replicaCacheAgeFor = node => Math.max(
    MIN_STATUS_CACHE_AGE_MS,
    Number(node.server?.replicaPollMs) || REPLICA_STATUS_CACHE_AGE_MS,
);

const replicaError = err => err.response?.status
    ? `HTTP ${err.response.status}`
    : err.code || 'unavailable';

const replicaResult = (entry, error) => {
    const result = { ...(entry.value || {}) };
    if (error) result.replicaStatusError = error;
    if (entry.value) result.replicaStatusStale = true;
    return result;
};

const getReplicaStatus = async node => {
    const coordinator = getCoordinator(node);
    if (!coordinator) return {};

    coordinator.replicaCache ||= new Map();
    const name = node.name;
    const entry = coordinator.replicaCache.get(name) || {
        value: null,
        result: {},
        checkedAt: 0,
        unsupportedUntil: 0,
        promise: null,
    };
    coordinator.replicaCache.set(name, entry);

    const now = Date.now();
    const maxAge = replicaCacheAgeFor(node);
    if (entry.promise) return entry.promise;
    if (entry.checkedAt && now - entry.checkedAt <= maxAge) return entry.result;
    if (entry.unsupportedUntil > now) return entry.result;

    entry.checkedAt = now;
    entry.promise = getClient(node).getReplicas(name)
        .then(response => {
            const names = response.data?.names;
            if (!Array.isArray(names)) {
                entry.result = replicaResult(entry, 'invalid-response');
                return entry.result;
            }
            entry.value = { activeReplicas: names.length };
            entry.result = entry.value;
            return entry.result;
        })
        .catch(err => {
            // Replica data is supplemental. A dashboard/platform that does
            // not expose the endpoint must not make an otherwise healthy
            // function appear unavailable. Retain the last good count for
            // display, but mark it stale so it is never mistaken for a fresh
            // health observation.
            if (err.response?.status === 404) {
                entry.unsupportedUntil = Date.now() + REPLICA_UNSUPPORTED_TTL_MS;
                entry.result = entry.value ? replicaResult(entry) : {};
                return entry.result;
            }
            entry.result = replicaResult(entry, replicaError(err));
            return entry.result;
        })
        .finally(() => {
            entry.promise = null;
        });
    return entry.promise;
};

const summarizeFunction = (func, replicaStatus = {}) => {
    const status = func?.status || {};
    const pick = (source, keys) => Object.fromEntries(
        keys.filter(key => source && source[key] !== undefined)
            .map(key => [key, source[key]])
    );
    const summarizedStatus = pick(status, [
        'state', 'internalInvocationUrls', 'externalInvocationUrls',
        'replicas', 'availableReplicas', 'readyReplicas',
        'desiredReplicas', 'activeReplicas', 'replicaStatusError',
        'replicaStatusStale',
        'error', 'message', 'reason',
    ]);
    if (replicaStatus.activeReplicas !== undefined) {
        summarizedStatus.activeReplicas = replicaStatus.activeReplicas;
    }
    if (replicaStatus.replicaStatusError !== undefined) {
        summarizedStatus.replicaStatusError = replicaStatus.replicaStatusError;
    }
    return {
        status: summarizedStatus,
        metadata: pick(func?.metadata, ['name', 'namespace', 'labels']),
        spec: pick(func?.spec, ['runtime', 'handler', 'replicas', 'minReplicas', 'maxReplicas', 'targetCPU']),
    };
};

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
            namespace,
            projectName,
            members: new Set(),
            snapshot: null,
            refreshedAt: 0,
            refreshPromise: null,
            lastError: null,
            lastErrorAt: 0,
            batchUnsupportedUntil: 0,
            replicaCache: new Map(),
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
    coordinator.replicaCache?.delete(node.name);
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
    coordinator.replicaCache?.delete(node.name);
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

const orphanError = (message) => Object.assign(new Error(message), { statusCode: 409 });

const getOrphans = async (node) => {
    const coordinator = node.statusCoordinator;
    if (!coordinator) throw new Error('Function is not registered for orphan discovery');

    const members = [...coordinator.members];
    if (!members.length) throw new Error('Orphan discovery requires a loaded function in the project');
    if (members.some(member => member.closed || member.configError)) {
        throw new Error('Orphan discovery is suppressed while the project flow has configuration errors');
    }

    // Orphan discovery must use a complete, project-scoped list. In particular,
    // a list failure must never be interpreted as an empty list.
    const snapshot = await refresh(node, coordinator, 0);
    const desiredNames = new Set(members.map(member => member.name));
    const orphans = Object.entries(snapshot)
        .filter(([name, func]) => func?.metadata?.annotations?.[NODE_RED_OWNERSHIP_ANNOTATION] === 'true'
            && !desiredNames.has(name))
        .map(([name, func]) => ({
            name,
            namespace: func.metadata?.namespace || coordinator.namespace,
            project: coordinator.projectName,
            nodeId: func.metadata?.annotations?.[NODE_RED_NODE_ID_ANNOTATION] || null,
            generatedBy: func.metadata?.annotations?.[GENERATED_BY_ANNOTATION] || null,
            state: func.status?.state || null,
        }));

    return {
        namespace: coordinator.namespace,
        project: coordinator.projectName,
        desired: [...desiredNames],
        orphans,
    };
};

const pruneOrphan = async (node, name) => {
    const target = `${name || ''}`.trim();
    if (!target) throw orphanError('A function name is required to prune an orphan');
    if (node.server?.deploymentEnabled === false) {
        throw orphanError('Function cleanup is disabled for this Nuclio server');
    }

    const result = await getOrphans(node);
    const orphan = result.orphans.find(candidate => candidate.name === target);
    if (!orphan) {
        const reason = result.desired.includes(target)
            ? 'the function is still present in the loaded flow'
            : 'the function is not a Node-RED-owned orphan in this project';
        throw orphanError(`Refusing to prune ${target}: ${reason}`);
    }

    const response = await getClient(node).deleteFunction(target, { ignoreStateValidation: true });
    invalidateStatus(node);
    return {
        deleted: target,
        namespace: result.namespace,
        project: result.project,
        status: response.status,
    };
};

const getStatus = async (node) => {
    const coordinator = node.statusCoordinator;
    const canBatch = coordinator
        && coordinator.members.size >= 2
        && Date.now() >= coordinator.batchUnsupportedUntil;
    if (!canBatch) {
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
    REPLICA_STATUS_CACHE_AGE_MS,
    getReplicaStatus,
    getStatus,
    summarizeFunction,
    getOrphans,
    pruneOrphan,
    registerFunction,
    unregisterFunction,
    invalidateStatus,
};
