const axios = require('axios');
const { BUILDING, WAITING } = require('./nuclio-states');
const { getDashboardHealth } = require('./nuclio-server-health');
const { getMetrics } = require('./nuclio-metrics');

/* -------------------------------------------------------------------------- */
/*                                Nuclio Client                               */
/* -------------------------------------------------------------------------- */
// The only module that talks to the Nuclio dashboard. Endpoint paths, request
// headers, and request bodies live here. State metadata and presentation live
// in nuclio-states.js so a state change has one authoritative definition.
//
// Thin wrapper over the dashboard REST API. `server` is the Nuclio Server
// config node ({ address, namespace, requestTimeoutMs, deployTimeoutMs }); projectName
// scopes function lookups via the x-nuclio-project-name header.
const createClient = (server, projectName, { signal } = {}) => {
    const address = server.address;
    const pathSegment = value => encodeURIComponent(`${value}`);
    const requestHeaders = { ...(server.requestHeaders || {}) };
    const headers = {
        ...requestHeaders,
        'Content-Type': 'application/json',
        'x-nuclio-project-name': projectName || 'default',
        'x-nuclio-function-namespace': server.namespace || 'nuclio',
    };
    const namespaceHeaders = {
        ...requestHeaders,
        'Content-Type': 'application/json',
        'x-nuclio-project-namespace': server.namespace || 'nuclio',
    };
    const statusOpts = { headers, timeout: server.requestTimeoutMs };   // reads
    const deployOpts = { headers, timeout: server.deployTimeoutMs };    // writes
    const request = (operation, config) => {
        if (server.authConfigError) {
            const err = new Error(`Nuclio authentication configuration is invalid: ${server.authConfigError}`);
            err.code = 'NUCLIO_AUTH_CONFIG';
            return Promise.reject(err);
        }
        const health = getDashboardHealth(server);
        const metrics = getMetrics(server);
        const startedAt = Date.now();
        let permit;
        try {
            permit = health.acquire();
        } catch (err) {
            metrics.recordDashboardRequest(operation, Date.now() - startedAt, 'circuit_open');
            metrics.recordCircuitRejection();
            throw err;
        }
        const requestConfig = signal && !config.signal ? { ...config, signal } : config;
        return axios(requestConfig).then(response => {
            health.success(permit);
            metrics.recordDashboardRequest(operation, Date.now() - startedAt, 'success', response.status);
            return response;
        }, err => {
            const previousState = health.snapshot().state;
            health.failure(permit, err);
            const outcome = err.response ? 'http_error' : 'network_error';
            metrics.recordDashboardRequest(operation, Date.now() - startedAt, outcome, err.response?.status);
            if (previousState !== 'open' && health.snapshot().state === 'open') metrics.recordCircuitTrip();
            throw err;
        });
    };

    return {
        getFunction: (name) =>
            request('getFunction', { method: 'get', url: `${address}/api/functions/${pathSegment(name)}`, ...statusOpts }),
        listFunctions: () =>
            request('listFunctions', { method: 'get', url: `${address}/api/functions`, ...statusOpts }),
        createFunction: (body) =>
            request('createFunction', { method: 'post', url: `${address}/api/functions`, data: body, ...deployOpts }),
        deleteFunction: (name) =>
            request('deleteFunction', { method: 'delete', url: `${address}/api/functions/${pathSegment(name)}`, ...deployOpts }),
        updateFunction: (name, body) =>
            request('updateFunction', { method: 'put', url: `${address}/api/functions/${pathSegment(name)}`, data: body, ...deployOpts }),
        patchDesiredState: (name) =>
            request('patchDesiredState', { method: 'patch', url: `${address}/api/functions/${pathSegment(name)}`, data: { desiredState: 'ready' }, ...deployOpts }),
        getReplicas: (name) =>
            request('getReplicas', { method: 'get', url: `${address}/api/functions/${pathSegment(name)}/replicas`, ...statusOpts }),
        getLogs: (name, replica, { tailLines = 70 } = {}) =>
            request('getLogs', { method: 'get', url: `${address}/api/functions/${pathSegment(name)}/logs/${pathSegment(replica)}?follow=false&tailLines=${tailLines}`, ...statusOpts }),
        listProjects: () =>
            request('listProjects', { method: 'get', url: `${address}/api/projects`, headers: namespaceHeaders, timeout: server.requestTimeoutMs }),
        createProject: (name) =>
            request('createProject', { method: 'post', url: `${address}/api/projects`, data: { metadata: { name } }, headers: { ...namespaceHeaders, 'Content-Type': 'application/json' }, timeout: server.deployTimeoutMs }),
    };
};

const getClient = (node) => {
    if (!node._client) {
        node._client = createClient(
            node.server,
            node.project?.name || 'default',
            { signal: node.dashboardAbortController?.signal },
        );
    }
    return node._client;
};


module.exports = {
    createClient,
    getClient,
    BUILDING,
    WAITING,
};
