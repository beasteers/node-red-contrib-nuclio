const _ = require('lodash');
const axios = require('axios');
const { Buffer } = require('buffer');
const { diff, merge } = require('./util');





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

    let configBody = {
        apiVersion: 'nuclio.io/v1',
        kind: 'Function',
        ...config,
        metadata: {
            name: name,
            ...config?.metadata,
            labels: {
                'nuclio.io/project-name': projectName,
                ...labels,
                ...config?.metadata?.labels,
            },
            annotations: {
                'nuclio.io/generated_by': 'node-red',
                ...annotations,
                ...config?.metadata?.annotations,
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

    const existingProjects = await axios.get(`${address}/api/projects`);
    const foundProject = Object.values(existingProjects.data || {}).find(p => p?.metadata?.name === projectName);
    if (!foundProject) {
        console.log(`NUCLIO Creating project ${project}...`);
        const resp = await axios.post(`${address}/api/projects`, { metadata: { name: projectName } }, { headers: { 'Content-Type': 'application/json' } });
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
        r = await axios.get(`${address}/api/functions/${name}`, { headers });
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
                    r = await axios.patch(`${address}/api/functions/${name}`, { "desiredState": "ready" }, { headers });
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
                    console.log("No build changes detected. Skipping build...");
                    newFunc.metadata.annotations['skip-build'] = 'true'
                }

                // Detected changes, update function
                console.log(`NUCLIO Updating function ${name} with changes:`, diffResult);
                r = await axios.put(`${address}/api/functions/${name}`, newFunc, { headers });
                console.log(`NUCLIO ${r.status} ${r.statusText}: ${r.config.url}`);
            }
        }
    } 
    
    /* ------------------------- Create Function (POST) ------------------------- */
    
    else {
        // Function doesn't exist, create it
        console.log(`NUCLIO Creating function ${name}...`);
        r = await axios.post(`${address}/api/functions`, configBody, { headers });
        console.log(`NUCLIO ${r.status} ${r.statusText}: ${r.config.url}`);
    }
    return r;
}



const getUrls = (func, node) => {
    const name = func?.metadata?.name || node.name;
    const namespace = func?.metadata?.namespace || node.fnConfigSpec?.metadata?.namespace;
    const internalUrls = func?.status?.internalInvocationUrls || [];
    const externalUrls = func?.status?.externalInvocationUrls || [];
    const internal = internalUrls.length > 0 ? `http://${internalUrls[0]}` : undefined;
    const external = externalUrls.length > 0 ? `https://${externalUrls[0]}` : undefined;
    const kubernetes = `http://${name + (namespace ? '.'+namespace : '')}.svc.cluster.local:8080`;
    const docker = `http://nuclio-${namespace || 'nuclio'}-${name}:8080`;  // REF: https://github.com/nuclio/nuclio/blob/37f777a642b2176835e00e44921ed204df1dd908/pkg/platform/local/platform.go#L911
    const invocation = internal || external || node.urls?.invocation;  // REF: https://github.com/nuclio/nuclio/blob/37f777a642b2176835e00e44921ed204df1dd908/pkg/platform/kube/resourcescaler/resourcescaler.go#L353
    const healthPath = '/__internal/health';
    return {
        internal,
        external,
        kubernetes,
        docker,
        invocation,
        healthcheck: getHealthcheckUrl(internal, healthPath),
        healthPath,
    };
}

const getHealthcheckUrl = (url, internalHealthPath) => {
    if (!url) return undefined;
    // replace port with 8082
    let u = new URL(url);
    u.port = 8082;
    u.pathname = internalHealthPath || '/';
    return u.toString();
}








/* -------------------------------------------------------------------------- */
/*                      Node-Red & Nuclio Reconciliation                      */
/* -------------------------------------------------------------------------- */



const reconcileLoop = async (node) => {
    await deployFunction(node);
    while (!node.closed) {
        let sleep = await reconcileStep(node);
        if (sleep) await new Promise(resolve => setTimeout(resolve, sleep));
    }
}

const deployFunction = async (node, config={}) => {
    if (!node.redeploying) {
        node.redeploying = true;
        node.status(STATUSES.redeploying);
        try {
            await deployFunctionConfig({ ...node.fnConfigSpec, ...config });
        } catch (err) {
            console.error("Error while deploying function:", err);
            console.error(err.response?.data);
            node.status({ fill: "red", shape: "ring", text: err.message });
            node.redeploying = false;
        }
    }
}


const reconcileStep = async (node) => {
    const name = node.name;
    const address = node.server.address;
    if (!name || !address) {
        // Node is closed or not configured
        return 5000;
    }

    /* -------------- Get the function status. If not found, deploy ------------- */

    let r;
    try {
        // Check function status
        r = await axios.get(`${address}/api/functions/${name}`, { headers: { 'Content-Type': 'application/json' } });
    } catch (err) {
        // Error while checking function status
        if(err?.response?.status === 404) {
            // Function not found, deploy it
            await deployFunction(node);
        }

        // Wait for next check
        return 1000;
    }

    /* -------------------------------------------------------------------------- */
    /*                     Handle different function statuses.                    */
    /* -------------------------------------------------------------------------- */

    try {
        const func = r.data;
        const state = func?.status?.state;
        node.fnData = func;
        node.fnState = state;
        node.urls = getUrls(func, node);
        if (state!=='ready' || node.fnInvocationStatus!==200) console.log("Reconciling", name, state, node.fnInvocationStatus, node.counter);

        /* ---------------------------- Check each state ---------------------------- */

        if (state === 'ready') {
            // Function is ready
            node.redeploying = false;

            if (node.fnInvocationStatus === 200) {
                // Wait for next check
                // node.status(STATUSES.ready);
                node.status({ ...STATUSES.ready, text: node.counter > 1 ? `${node.counter}` : '' });
                return 5000;
            } 
            else {
                // Wait for next check
                // node.status({...STATUSES.readyNotOk, text: `${node.fnInvocationStatus}`});
                return 1000;
            }
        }
        else if (state === 'error') {
            // Function is in error state
            node.redeploying = false;

            // Wait for next check
            node.status(STATUSES[state]);
            return 5000;
        } 
        else if (state === 'unhealthy') {
            // Function is unhealthy
            node.status(STATUSES.unhealthy);
            if (!node.redeploying && node.fnInvocationStatus !== 200) {
                await deployFunction(node);
            }

            // Wait for next check
            return 1000;
        }
        else if (state === null) {
            // Function is unhealthy

            // But requests are still 200
            if (node.fnInvocationStatus === 200) {
                node.status(STATUSES.unhealthyOk);
            }
            // unhealthy and not currently redeploying
            else if (!node.redeploying) {
                await deployFunction(node);
            } else {
                node.status(STATUSES[state]);
            }

            // Wait for next check
            return 1000;
        }
        else if (state === 'scaledToZero') {
            // Wait for next check
            node.status(STATUSES[state]);
            return 5000;
        }
        else if (BUILDING.includes(state)) {
            // Wait for next check
            node.status(STATUSES[state]);
            return 1000;
        }
        else if (WAITING.includes(state)) {
            // Wait for next check
            node.status(STATUSES[state]);
            return 3000;
        }
        else {
            // Wait for next check
            node.status(STATUSES[state] || { fill: "yellow", shape: "dot", text: state });
            return 1000;
        }
    } catch (err) {
        // Wait for next check
        node.status({ fill: "red", shape: "ring", text: err.message });
        console.error("Error while checking function status:", err);
        return 1000;
    }
}



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
}
const PROVISIONED = ['ready', 'scaledToZero', 'imported'];
const FAILED = ['error'];
const WAITING = ['waitingForBuild', 'waitingForResourceConfiguration', 'waitingForScaleResourceFromZero', 'waitingForScaleResourceToZero'];
const BUILDING = ['building', 'configuringResources'];



module.exports = {
    deployFunction,
    reconcileLoop,
    reconcileStep,
    STATUSES,
};