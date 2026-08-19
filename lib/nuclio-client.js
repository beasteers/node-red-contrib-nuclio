const axios = require('axios');
const { BUILDING, WAITING } = require('./nuclio-states');

/* -------------------------------------------------------------------------- */
/*                                Nuclio Client                               */
/* -------------------------------------------------------------------------- */
// The only module that talks to the Nuclio dashboard. Everything version-
// specific about the integration lives here: endpoint paths, request headers,
// request bodies, and the function state names the rest of the code reacts
// to. A Nuclio version bump should only ever require changes in this file.
//
// Thin wrapper over the dashboard REST API. `server` is the Nuclio Server
// config node ({ address, requestTimeoutMs, deployTimeoutMs }); projectName
// scopes function lookups via the x-nuclio-project-name header.
const createClient = (server, projectName) => {
    const address = server.address;
    const headers = {
        'Content-Type': 'application/json',
        'x-nuclio-project-name': projectName || 'default',
    };
    const statusOpts = { headers, timeout: server.requestTimeoutMs };   // reads
    const deployOpts = { headers, timeout: server.deployTimeoutMs };    // writes

    return {
        getFunction: (name) =>
            axios.get(`${address}/api/functions/${name}`, statusOpts),
        createFunction: (body) =>
            axios.post(`${address}/api/functions`, body, deployOpts),
        updateFunction: (name, body) =>
            axios.put(`${address}/api/functions/${name}`, body, deployOpts),
        patchDesiredState: (name) =>
            axios.patch(`${address}/api/functions/${name}`, { desiredState: 'ready' }, deployOpts),
        getReplicas: (name) =>
            axios.get(`${address}/api/functions/${name}/replicas`, statusOpts),
        getLogs: (name, replica, { tailLines = 70 } = {}) =>
            axios.get(`${address}/api/functions/${name}/logs/${replica}?follow=false&tailLines=${tailLines}`, statusOpts),
        listProjects: () =>
            axios.get(`${address}/api/projects`, { timeout: server.requestTimeoutMs }),
        createProject: (name) =>
            axios.post(`${address}/api/projects`, { metadata: { name } }, { headers: { 'Content-Type': 'application/json' }, timeout: server.deployTimeoutMs }),
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
