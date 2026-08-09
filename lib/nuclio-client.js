const axios = require('axios');

/* -------------------------------------------------------------------------- */
/*                                Nuclio Client                               */
/* -------------------------------------------------------------------------- */
// The only module that talks to the Nuclio dashboard. Everything version-
// specific about the integration lives here: endpoint paths, request headers,
// request bodies, and the function state names the rest of the code reacts
// to. A Nuclio version bump should only ever require changes in this file.
//
// State handling is open-world: callers act on the small known set (ready,
// error, unhealthy, scaledToZero, 404) and treat any other state as
// "in transition - show it and wait", so unknown future states degrade to
// observation instead of breakage.

// States in which the dashboard refuses function updates (a build is already
// in flight); deploys skip-and-wait while a function is in one of these.
// REF: https://docs.nuclio.io/en/stable/reference/function-configuration/function-configuration-reference.html#function-state-state
const BUILDING = ['building', 'configuringResources'];
const WAITING = ['waitingForBuild', 'waitingForResourceConfiguration', 'waitingForScaleResourceFromZero', 'waitingForScaleResourceToZero'];

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


module.exports = {
    createClient,
    BUILDING,
    WAITING,
};
