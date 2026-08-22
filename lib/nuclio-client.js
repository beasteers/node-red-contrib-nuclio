const axios = require('axios');
const { BUILDING, WAITING } = require('./nuclio-states');
const { getDashboardHealth } = require('./nuclio-server-health');

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
const createClient = (server, projectName) => {
    const address = server.address;
    const pathSegment = value => encodeURIComponent(`${value}`);
    const headers = {
        'Content-Type': 'application/json',
        'x-nuclio-project-name': projectName || 'default',
        'x-nuclio-function-namespace': server.namespace || 'nuclio',
    };
    const namespaceHeaders = {
        'x-nuclio-project-namespace': server.namespace || 'nuclio',
    };
    const statusOpts = { headers, timeout: server.requestTimeoutMs };   // reads
    const deployOpts = { headers, timeout: server.deployTimeoutMs };    // writes
    const request = config => {
        const health = getDashboardHealth(server);
        const permit = health.acquire();
        return axios(config).then(response => {
            health.success(permit);
            return response;
        }, err => {
            health.failure(permit, err);
            throw err;
        });
    };

    return {
        getFunction: (name) =>
            request({ method: 'get', url: `${address}/api/functions/${pathSegment(name)}`, ...statusOpts }),
        listFunctions: () =>
            request({ method: 'get', url: `${address}/api/functions`, ...statusOpts }),
        createFunction: (body) =>
            request({ method: 'post', url: `${address}/api/functions`, data: body, ...deployOpts }),
        deleteFunction: (name) =>
            request({ method: 'delete', url: `${address}/api/functions/${pathSegment(name)}`, ...deployOpts }),
        updateFunction: (name, body) =>
            request({ method: 'put', url: `${address}/api/functions/${pathSegment(name)}`, data: body, ...deployOpts }),
        patchDesiredState: (name) =>
            request({ method: 'patch', url: `${address}/api/functions/${pathSegment(name)}`, data: { desiredState: 'ready' }, ...deployOpts }),
        getReplicas: (name) =>
            request({ method: 'get', url: `${address}/api/functions/${pathSegment(name)}/replicas`, ...statusOpts }),
        getLogs: (name, replica, { tailLines = 70 } = {}) =>
            request({ method: 'get', url: `${address}/api/functions/${pathSegment(name)}/logs/${pathSegment(replica)}?follow=false&tailLines=${tailLines}`, ...statusOpts }),
        listProjects: () =>
            request({ method: 'get', url: `${address}/api/projects`, headers: namespaceHeaders, timeout: server.requestTimeoutMs }),
        createProject: (name) =>
            request({ method: 'post', url: `${address}/api/projects`, data: { metadata: { name } }, headers: { ...namespaceHeaders, 'Content-Type': 'application/json' }, timeout: server.deployTimeoutMs }),
    };
};

const getClient = (node) => {
    if (!node._client) {
        node._client = createClient(node.server, node.project?.name || 'default');
    }
    return node._client;
};


module.exports = {
    createClient,
    getClient,
    BUILDING,
    WAITING,
};
