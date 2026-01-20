const _ = require('lodash');
const axios = require('axios');
const { Buffer } = require('buffer');
const { diff, merge, parseIntFallback } = require('./util');

const REQUEST_TIMEOUT_MS = parseIntFallback(process.env.NUCLIO_REQUEST_TIMEOUT_MS, 10000);
const DEPLOY_TIMEOUT_MS = parseIntFallback(process.env.NUCLIO_DEPLOY_TIMEOUT_MS, 60000);




/* -------------------------------------------------------------------------- */
/*                         Nuclio-only Reconciliation                         */
/* -------------------------------------------------------------------------- */



async function deployFunctionConfig({
    name,
    code,
    config,
    runtime,
    project,
    address,
    force,
    labels, 
    annotations,
    env,
}) {
    // console.log(`NUCLIO Deploying function ${name}...`);
    const projectName = project || 'default';

    // handler definition
    const [runtimeBase, runtimeVersion] = runtime.split(':');
    const moduleName = (
        runtimeBase === 'nodejs' ? 'handler' : 'main'
    );
    const funcName = (
        runtimeBase === 'golang' ? 'Handler' : 'handler'
    );
    const handler = `${moduleName}:${funcName}`;

    const configMetadata = config?.metadata || {};
    const configLabels = configMetadata.labels || {};
    const configAnnotations = configMetadata.annotations || {};

    let configBody = {
        apiVersion: 'nuclio.io/v1',
        kind: 'Function',
        ...config,
        metadata: {
            ...configMetadata,
            name: name,
            labels: {
                ...configLabels,
                ...labels,
                'nuclio.io/project-name': projectName,
            },
            annotations: {
                ...configAnnotations,
                ...annotations,
                'nuclio.io/generated_by': 'node-red',
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

    /* -------------------------- Get / Create Project -------------------------- */

    const existingProjects = await axios.get(`${address}/api/projects`, { timeout: REQUEST_TIMEOUT_MS });
    const foundProject = Object.values(existingProjects.data || {}).find(p => p?.metadata?.name === projectName);
    if (!foundProject) {
        console.log(`NUCLIO Creating project ${project}...`);
        const resp = await axios.post(`${address}/api/projects`, { metadata: { name: projectName } }, { headers: { 'Content-Type': 'application/json' }, timeout: DEPLOY_TIMEOUT_MS });
        console.log(`NUCLIO ${resp.status} ${resp.statusText}: ${resp.config.url}`);
        if (resp.status !== 201) {
            throw new Error(`Failed to create project ${project}: ${resp.status} ${resp.statusText}`);
        }
    }

    /* ----------------- Check if function already exists (GET) ----------------- */

    const headers = {
        'Content-Type': 'application/json',
        'x-nuclio-project-name': projectName,
    };

    let r;
    try {
        r = await axios.get(`${address}/api/functions/${name}`, { headers, timeout: REQUEST_TIMEOUT_MS });
    } catch (err) {
        if (err.response?.status !== 404) throw err;
    }

    /* -------------------- Update Function (POST/PUT/PATCH) -------------------- */

    // If it does, update it
    if (r && r.status === 200) {  // REVIEW
        const state = r.data?.status?.state;

        // building fn can't be updated
        if (!(BUILDING.includes(state) || WAITING.includes(state))) {
            // Compare the existing function with the new one
            const { status, ...oldFunc } = r.data;
            const newFunc = merge({}, oldFunc, configBody);
            const diffResult = diff(newFunc, {apiVersion: newFunc.apiVersion, kind: newFunc.kind, ...oldFunc});
            // const invDiffResult = diff({apiVersion: newFunc.apiVersion, kind: newFunc.kind, ...oldFunc}, newFunc);

            // No differences!
            if (_.isEmpty(diffResult)) {
                // Function isn't ready, just patch the desired state to ready
                if ((state !== 'ready') || force) {

                    /* ------------------------ Set desired state (PATCH) ----------------------- */

                    console.log(`NUCLIO Patching function ${name}...`);
                    r = await axios.patch(`${address}/api/functions/${name}`, { "desiredState": "ready" }, { headers, timeout: DEPLOY_TIMEOUT_MS });
                    console.log(`NUCLIO ${r.status} ${r.statusText}: ${r.config.url}`);
                } else {

                    /* ------------------------------- Up to date. ------------------------------ */

                    // console.log(`NUCLIO Function ${name} is already up to date.`);
                }
            } else {

                /* -------------------------- Update function (PUT) ------------------------- */

                // REF `skip-build`: https://github.com/nuclio/nuclio/blob/37f777a642b2176835e00e44921ed204df1dd908/pkg/functionconfig/types.go#L636
                const spec = diffResult?.spec || {};
                if (!(spec?.build || spec?.image || spec?.runtime) && state === 'ready') {
                    console.debug("No build changes detected. Skipping build...");
                    newFunc.metadata.annotations['skip-build'] = 'true'
                }

                // Detected changes, update function
                console.log(`NUCLIO Updating function ${name} with changes:`, diffResult);
                r = await axios.put(`${address}/api/functions/${name}`, newFunc, { headers, timeout: DEPLOY_TIMEOUT_MS });
                console.log(`NUCLIO ${r.status} ${r.statusText}: ${r.config.url}`);
            }
        }
    } 
    
    /* ------------------------- Create Function (POST) ------------------------- */
    
    else {
        // Function doesn't exist, create it
        console.log(`NUCLIO Creating function ${name}...`);
        r = await axios.post(`${address}/api/functions`, configBody, { headers, timeout: DEPLOY_TIMEOUT_MS });
        console.log(`NUCLIO ${r.status} ${r.statusText}: ${r.config.url}`);
    }
    return r;
}


const deployFunction = async (node, config={}) => {
    if (node.redeploying && !config.force || !node.fnConfigSpec) return;
    node.redeploying = true;
    node.fnInvocationStatus = -1;
    node.status(STATUSES.redeploying);
    try {
        await deployFunctionConfig({ ...node.fnConfigSpec, ...config });
    } catch (err) {
        console.error("Error while deploying function:", err);
        console.error(err.response?.data);
        node.status({ fill: "red", shape: "ring", text: err.message });
        node.redeploying = false;
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
    deployFunction,
    WAITING,
    BUILDING,
    STATUSES,
};
