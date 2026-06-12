const _ = require('lodash');
const axios = require('axios');
const { Buffer } = require('buffer');
const { diff, merge } = require('./util');

// Timeouts come from the server config node (node.server.requestTimeoutMs /
// deployTimeoutMs); the redeploy deadline from the function node
// (node.redeployDeadlineMs). All resolve node-config -> NUCLIO_* env -> default.


/* -------------------------------------------------------------------------- */
/*                         Nuclio-only Reconciliation                         */
/* -------------------------------------------------------------------------- */

function buildFunctionConfig({
    name,
    code,
    config,
    runtime,
    project,
    labels,
    annotations,
    env,
}) {
    // handler definition
    const [runtimeBase] = runtime.split(':');
    const moduleName = (
        runtimeBase === 'nodejs' ? 'handler' : 
        runtimeBase === 'shell' ? 'main.sh' : 
        'main'
    );
    const funcName = (
        runtimeBase === 'golang' ? 'Handler' : 'handler'
    );
    const handler = (`${moduleName}:${funcName}`);

    const metadata = config?.metadata || {};

    return {
        apiVersion: 'nuclio.io/v1',
        kind: 'Function',
        ...config,
        metadata: {
            ...metadata,
            name: name,
            labels: {
                ...(metadata.labels || {}),
                ...labels,
                'nuclio.io/project-name': project || 'default',
            },
            annotations: {
                ...(metadata.annotations || {}),
                ...annotations,
                'nuclio.io/generated-by': 'node-red',
            },
        },
        spec: {
            runtime: runtime,
            handler: handler,
            ...config?.spec,
            build: {
                functionSourceCode: code.trim() ? Buffer.from(code).toString('base64') : undefined,
                ...config?.spec?.build,
            },
            env: [
                ...(env || []),
                ...(config?.spec?.env || []),
            ],
        },
    };
}

async function deployFunctionConfig(node, address, {
    config: configBody,
    force,
}) {
    const projectName = configBody?.metadata?.labels?.['nuclio.io/project-name'] || 'default';
    const name = configBody?.metadata?.name;
    const requestTimeout = node.server.requestTimeoutMs;
    const deployTimeout = node.server.deployTimeoutMs;
    node.log(`Deploying function ${name}...`);

    /* -------------------------- Get / Create Project -------------------------- */

    const existingProjects = await axios.get(`${address}/api/projects`, { timeout: requestTimeout });
    const foundProject = Object.values(existingProjects.data || {}).find(p => p?.metadata?.name === projectName);
    if (!foundProject) {
        node.log(`Creating project ${projectName}...`);
        const resp = await axios.post(`${address}/api/projects`, { metadata: { name: projectName } }, { headers: { 'Content-Type': 'application/json' }, timeout: deployTimeout });
        node.log(`${resp.status} ${resp.statusText}: ${resp.config.url}`);
        if (resp.status !== 201) {
            throw new Error(`Failed to create project ${projectName}: ${resp.status} ${resp.statusText}`);
        }
    }

    /* ----------------- Check if function already exists (GET) ----------------- */

    const headers = {
        'Content-Type': 'application/json',
        'x-nuclio-project-name': projectName,
    };

    let r;
    try {
        r = await axios.get(`${address}/api/functions/${name}`, { headers, timeout: requestTimeout });
    } catch (err) {
        if (err.response?.status !== 404) throw err;
    }

    /* -------------------- Update Function (POST/PUT/PATCH) -------------------- */

    // If it does, update it
    let changed = false;
    if (r && r.status === 200) {
        const state = r.data?.status?.state;

        // building fn can't be updated
        if (!(BUILDING.includes(state) || WAITING.includes(state))) {
            // Compare the existing function with the new one
            const { status, ...oldFunc } = r.data;
            const newFunc = merge({}, oldFunc, configBody);
            const diffResult = diff(newFunc, {apiVersion: newFunc.apiVersion, kind: newFunc.kind, ...oldFunc});

            // No differences!
            if (_.isEmpty(diffResult)) {
                // Function isn't ready, just patch the desired state to ready
                if ((state !== 'ready') || force) {

                    /* ------------------------ Set desired state (PATCH) ----------------------- */

                    node.log(`Patching function ${name}...`);
                    r = await axios.patch(`${address}/api/functions/${name}`, { "desiredState": "ready" }, { headers, timeout: deployTimeout });
                    node.log(`${r.status} ${r.statusText}: ${r.config.url}`);
                    changed = true;
                }

                /* ------------------------- Otherwise: up to date. -------------------------- */

            } else {

                /* -------------------------- Update function (PUT) ------------------------- */

                // REF `skip-build`: https://github.com/nuclio/nuclio/blob/37f777a642b2176835e00e44921ed204df1dd908/pkg/functionconfig/types.go#L636
                const spec = diffResult?.spec || {};
                if (!(spec?.build || spec?.image || spec?.runtime) && state === 'ready') {
                    node.debug("No build changes detected. Skipping build...");
                    newFunc.metadata.annotations['skip-build'] = 'true'
                }

                // Detected changes, update function
                node.log(`Updating function ${name} with changes: ${JSON.stringify(diffResult)}`);
                r = await axios.put(`${address}/api/functions/${name}`, newFunc, { headers, timeout: deployTimeout });
                node.log(`${r.status} ${r.statusText}: ${r.config.url}`);
                changed = true;
            }
        }
    }

    /* ------------------------- Create Function (POST) ------------------------- */

    else {
        // Function doesn't exist, create it
        node.log(`Creating function ${name}...`);
        r = await axios.post(`${address}/api/functions`, configBody, { headers, timeout: deployTimeout });
        node.log(`${r.status} ${r.statusText}: ${r.config.url}`);
        changed = true;
    }
    return { response: r, changed };
}


// Build + push the function config. Returns true if the deploy request was
// accepted, false if it failed, undefined if skipped (already deploying).
// `node.redeploying` stays set on success - the reconcile loop clears it once
// the function reports a terminal state, and invoke nodes fall back until then.
const deployFunction = async (node, options={}) => {
    if (node.redeploying && !options.force || !node.fnConfigSpec) return;
    // A manual redeploy is an explicit "try again" - un-give-up the self-healer.
    if (options.force) node.selfHealAttempts = 0;
    node.redeploying = true;
    node.redeployDeadline = Date.now() + node.redeployDeadlineMs;
    node.fnInvocationStatus = -1;
    node.status(STATUSES.redeploying);
    try {
        options = { ...node.fnConfigSpec, ...options };
        const { force, address } = options;
        const configBody = buildFunctionConfig(options);
        const { changed } = await deployFunctionConfig(node, address, { config: configBody, force });
        // Nothing was pushed - don't hold invoke nodes in the redeploy fallback
        if (!changed) node.redeploying = false;
        return true;
    } catch (err) {
        // Deploy failed - clear the flag so the reconcile loop can retry
        node.redeploying = false;
        const r = err.response;
        if (r && (r.status === 404 || r.status === 502 || r.status === 503)) {
            // Server not ready or transient gateway error, back off and retry
            node.status({ fill: "red", shape: "ring", text: `Error ${r.status}` });
            return false;
        }

        node.error(`Error while deploying function: ${err.message} ${r?.data ? JSON.stringify(r.data) : ''}`);
        node.status({ fill: "red", shape: "ring", text: err.message });
        return false;
    }
};

const WAITING = ['waitingForBuild', 'waitingForResourceConfiguration', 'waitingForScaleResourceFromZero', 'waitingForScaleResourceToZero'];
const BUILDING = ['building', 'configuringResources'];


// **REF: https://docs.nuclio.io/en/stable/reference/function-configuration/function-configuration-reference.html#function-state-state
// **REF: https://github.com/nuclio/nuclio/blob/37f777a642b2176835e00e44921ed204df1dd908/pkg/functionconfig/types.go#L931
// State                               Description
// ready                               Function is deployed successfully and ready to process events.
// imported                            Function is imported but not yet deployed.
// building                            Function image is being built.
// waitingForResourceConfiguration     Function waits for resources to be ready. For instance, in case of k8s function waits for deployment/pods and etc.
// waitingForScaleResourceFromZero     Function is scaling up from zero replicas.
// waitingForScaleResourceToZero       Function is scaling down to zero replicas.
// scaledToZero                        Function is scaled to zero, so the number of function replicas is zero.
// error                               An error occurred during function deployment that cannot be rectified without redeployment.
// unhealthy                           An error occurred during function deployment, which might be resolved over time, and might require redeployment. For example, issues with insufficient resources or a missing image.

const STATUSES = {
    ready:                            { fill: "green",  shape: "dot",  text: "" },
    imported:                         { fill: "yellow", shape: "dot",  text: "Imported" },
    building:                         { fill: "yellow", shape: "dot",  text: "Building..." },
    configuringResources:             { fill: "yellow", shape: "dot",  text: "Configuring Resources..." },
    waitingForBuild:                  { fill: "yellow", shape: "ring", text: "Waiting For Build..." },
    waitingForResourceConfiguration:  { fill: "yellow", shape: "ring", text: "Waiting For Resource Configuration..." },
    waitingForScaleResourceFromZero:  { fill: "yellow", shape: "ring", text: "Waiting to Scale Resource From Zero..." },
    waitingForScaleResourceToZero:    { fill: "yellow", shape: "ring", text: "Waiting to Scale Resource To Zero..." },
    scaledToZero:                     { fill: "grey",   shape: "dot",  text: "Scaled to Zero" },
    error:                            { fill: "red",    shape: "dot",  text: "Error" },
    unhealthy:                        { fill: "red",    shape: "ring", text: "Unhealthy" },
    
    // custom
    readyNoDashboard:                 { fill: "green",  shape: "ring", text: "" }, 
    redeploying:                      { fill: "yellow", shape: "dot",  text: "Redeploying..." }, 
    unhealthyOk:                      { fill: "yellow",    shape: "ring",  text: "Unhealthy?" }, 
    readyNotOk:                       { fill: "yellow",    shape: "ring",  text: "Ready?" }, 
};

module.exports = {
    buildFunctionConfig,
    deployFunction,
    WAITING,
    BUILDING,
    STATUSES,
};
