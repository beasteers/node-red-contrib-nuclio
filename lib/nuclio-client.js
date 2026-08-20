const axios = require('axios');
const { BUILDING, WAITING } = require('./nuclio-states');

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
        'x-nuclio-function-namespace': server.namespace || 'nuclio',
    };
    const statusOpts = { headers, timeout: server.requestTimeoutMs };   // reads
    const deployOpts = { headers, timeout: server.deployTimeoutMs };    // writes

    return {
        getFunction: (name) =>
            axios.get(`${address}/api/functions/${pathSegment(name)}`, statusOpts),
        listFunctions: () =>
            axios.get(`${address}/api/functions`, statusOpts),
        createFunction: (body) =>
            axios.post(`${address}/api/functions`, body, deployOpts),
        updateFunction: (name, body) =>
            axios.put(`${address}/api/functions/${pathSegment(name)}`, body, deployOpts),
        patchDesiredState: (name) =>
            axios.patch(`${address}/api/functions/${pathSegment(name)}`, { desiredState: 'ready' }, deployOpts),
        getReplicas: (name) =>
            axios.get(`${address}/api/functions/${pathSegment(name)}/replicas`, statusOpts),
        getLogs: (name, replica, { tailLines = 70 } = {}) =>
            axios.get(`${address}/api/functions/${pathSegment(name)}/logs/${pathSegment(replica)}?follow=false&tailLines=${tailLines}`, statusOpts),
        listProjects: () =>
            axios.get(`${address}/api/projects`, { headers: namespaceHeaders, timeout: server.requestTimeoutMs }),
        createProject: (name) =>
            axios.post(`${address}/api/projects`, { metadata: { name } }, { headers: { ...namespaceHeaders, 'Content-Type': 'application/json' }, timeout: server.deployTimeoutMs }),
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
