const _ = require('lodash');
const axios = require('axios');
const { Buffer } = require('buffer');


function diff(a,b) {
    var r = {};
    _.each(a, function(v,k) {
        if(b?.[k] === v) return;
        v2 = _.isObject(v) ? diff(v, b?.[k]) : v;
        if(_.isObject(v2) && _.isEmpty(v2)) return;
        if(_.isEmpty(v) && _.isEmpty(b?.[k])) return;
        r[k] = v2;
    });
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
    const internalHealthPath = '/__internal/health';
    return {
        internal,
        external,
        kubernetes,
        docker,
        invocation,
        healthcheck: getHealthcheckUrl(internal, internalHealthPath),
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

async function deployFunction({
    name,
    code,
    config,
    runtime,
    project,
    handler,
    address,
    force,
    labels, 
    annotations,
}) {
    // console.log(`NUCLIO Deploying function ${name}...`);
    const projectName = project || 'default';

    let configBody = {
        apiVersion: 'nuclio.io/v1',
        kind: 'Function',
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
        },
    };

    /* -------------------------- Get / Create Project -------------------------- */

    const existingProjects = await axios.get(`${address}/api/projects`);
    const foundProject = Object.values(existingProjects.data || {}).find(p => p?.metadata?.name === projectName);
    if (!foundProject) {
        const resp = await axios.post(`${address}/api/projects`, { metadata: { name: projectName } }, { headers: { 'Content-Type': 'application/json' } });
        console.log(`NUCLIO ${resp.status} ${resp.statusText}: ${resp.config.url}`);
        if (resp.status !== 201) {
            throw new Error(`Failed to create project ${project}: ${resp.status} ${resp.statusText}`);
        }
        console.log(`NUCLIO Created project ${project}`);
    }

    /* -------------------- Check if function already exists -------------------- */

    const headers = {
        'Content-Type': 'application/json',
        'x-nuclio-project-name': projectName,
    };

    let func;
    try {
        func = await axios.get(`${address}/api/functions/${name}`, { headers });
    } catch (err) {
        if (err.response?.status !== 404) throw err;
    }

    // If it does, update it
    if (func && func.status === 200) {  // REVIEW
        const state = func.data?.status?.state;

        // building fn can't be updated
        if (state !== 'building') {
            // Compare the existing function with the new one
            const { status, ...oldFunc } = func.data;
            const newFunc = _.merge({}, oldFunc, configBody);
            const oldFuncComp = {apiVersion: newFunc.apiVersion, kind: newFunc.kind, ...oldFunc};
            const diffResult = diff(newFunc, oldFuncComp);
            if (_.isEmpty(diffResult)) {
                if ((state !== 'ready') || force) {
                    console.log(`NUCLIO Patching function ${name}...`);
                    func = await axios.patch(`${address}/api/functions/${name}`, { "desiredState": "ready" }, { headers });
                    console.log(`NUCLIO ${func.status} ${func.statusText}: ${func.config.url}`);
                } else {
                    // console.log(`NUCLIO Function ${name} is already up to date.`);
                }
            } else {
                // // REF `skip-build`: https://github.com/nuclio/nuclio/blob/37f777a642b2176835e00e44921ed204df1dd908/pkg/functionconfig/types.go#L636

                // const spec = diffResult?.spec || {};
                // if (!(spec?.build || spec?.image || spec?.runtime)) {
                //     console.log("No build changes detected. Skipping build...");
                //     // If the function source code has changed, set skipBuild to false
                //     newFunc.metadata.annotations['skip-build'] = 'true'
                // }

                // Detected changes, update function
                console.log(`NUCLIO Function ${name} has changes:`, diffResult);
                console.log(`NUCLIO Updating function ${name}...`);
                func = await axios.put(`${address}/api/functions/${name}`, newFunc, { headers });
                console.log(`NUCLIO ${func.status} ${func.statusText}: ${func.config.url}`);
            }
        }
    } else {
        // Function doesn't exist
        console.log(`NUCLIO Creating function ${name}...`);
        func = await axios.post(`${address}/api/functions`, configBody, { headers });
        console.log(`NUCLIO ${func.status} ${func.statusText}: ${func.config.url}`);
    }
    return func;
}




async function refreshFunctionStatus(node) {
    // Check function status
    const name = node.name;
    const address = node.server.address;
    const response = await axios.get(`${address}/api/functions/${name}`, { headers: { 'Content-Type': 'application/json' } });
    const func = response.data;
    const state = func?.status?.state;
    node.fnState = state;
    node.urls = getUrls(func, node);

    // Update node status
    let reconciling = false;

    // Success
    if (PROVISIONED.includes(state)) {
        node.status(STATUSES[state] || { fill: "green", shape: "dot", text: state });
    } 
    
    // Failure
    else if (FAILED.includes(state)) {
        node.status(STATUSES[state] || { fill: "red", shape: "dot", text: state });
        const logs = func.status?.logs;
        node.error(`Deployment of ${name} failed. ${state} - ${logs?.[logs?.length - 1]?.message || ''}`);
    } 
    
    // In-Progress
    else {
        reconciling = true;
        const logs = func.status?.logs;
        node.status({ ...(STATUSES[state] || { fill: "yellow", shape: "dot" }), text: `${state} ${logs?.[logs?.length - 1]?.message || ''}` });
    }
    
    return [reconciling, func];
    // try {
    // } catch (err) {  // REVIEW

            // if(node.urls?.healthcheck) {
            //     try {
            //         console.log("Healthcheck URL:", node.urls.healthcheck);
            //         const r = await axios.get(`${node.urls.healthcheck}`)
            //         return res.status(r.status).send({ status: r.data });
            //     } catch (err) {
            //         // Healthcheck not found
            //         if (err.response?.status === 404) {
            //             return res.status(404).send(`Healthcheck "${node.urls.healthcheck}" not found.`);
            //         }
            //     }
            // }

    //     // Error while checking function status
    //     console.error(`NUCLIO Error checking function "${name}" status:`, err);
    //     node.status(STATUSES.error);
    // }
}


async function deployWatchFunction(node, { interval = 1000, endInterval, ...props }) {
    
    try {
        // Deploy function
        const res = await deployFunction({ ...props });
        // Wait for function to be ready
        while (true) {
            // Check function status
            const [reconciling, func] = await refreshFunctionStatus(node, props);
            const logs = func?.status?.logs;
            console.log("NUCLIO", node.name, func?.status?.state, logs?.[logs?.length-1]?.message || '');
            if (!reconciling) { break; }

            // Wait for next check
            await new Promise(resolve => setTimeout(resolve, interval));
        }
    } catch (err) {  // REVIEW
        // // Check if function already exists and the issue is with nuclio
        // if(node.urls?.healthcheck) {
        //     const r = await axios.get(node.urls.healthcheck);
        //     if (r.status === 200) {
        //         node.fnState = "ready";
        //         node.status(STATUSES.readyNoDashboard);
        //         return;
        //     }
        // }

        // Error while deploying
        const state = err?.response?.data?.status?.state;
        if(state) {
            node.fnState = state;
            console.error(`Error deploying function - ${err.response.status} ${err.response.statusText}: ${err.config.url}\n`, err.response.data);
        } else {
            node.fnState = "error";
            console.error("Unknown error deploying function", err);
        }
        const logs = err?.response?.data.status?.logs;
        node.error(`Deployment of ${node.name} failed. ${state} - ${logs?.[logs?.length - 1]?.message || ''}`);
        node.status(STATUSES.error);
    }

    if(endInterval) {
        // Wait for next check
        await new Promise(resolve => setTimeout(resolve, endInterval));
    }
}



/*

Possible States:
 * function not found
 * function unhealthy/needs redeploy
 * function healthy
 * 
 * nuclio dashboard up
 * nuclio dashboard down

get status:
 * check dashboard function status
 * check function healthcheck directly

*/

// class Router {
//     constructor(node) {
//         this.node = node;
//         this.backgroundStatusPoller = Poller(() => {
//             this.refreshStatus();
//         }, 15000);
//     }

//     reconcile() {

//     }

//     refreshStatus() {
        
//     }

//     invoke() {
        
//     }
// }



class NonDuplicateAsyncFunction {
    constructor(asyncFn) {
      this.asyncFn = asyncFn;
      this.running = false;
    }
  
    async run(...args) {
      if (this.running) { return; }
      this.running = true;
      try {
        await this.asyncFn(...args);
      } finally {
        this.running = false;
      }
    }
}

class Poller {
    constructor(fn, interval) {
        this.fn = fn;
        this.interval = interval;
        this.pollInterval = null;
    }

    start() {
        this.fn();
        this.pollInterval = setInterval(this.fn, this.interval);
    }

    stop() {
        clearInterval(this.pollInterval);
    }
}






// **REF: https://docs.nuclio.io/en/stable/reference/function-configuration/function-configuration-reference.html#function-state-state
// **REF: https://github.com/nuclio/nuclio/blob/37f777a642b2176835e00e44921ed204df1dd908/pkg/functionconfig/types.go#L931
// State                               Description
// ready                               Function is deployed successfully and ready to process events.
// imported                            Function is imported but not yet deployed.
// scaledToZero                        Function is scaled to zero, so the number of function replicas is zero.
// building                            Function image is being built.
// waitingForResourceConfiguration     Function waits for resources to be ready. For instance, in case of k8s function waits for deployment/pods and etc.
// waitingForScaleResourceFromZero     Function is scaling up from zero replicas.
// waitingForScaleResourceToZero       Function is scaling down to zero replicas.
// error                               An error occurred during function deployment that cannot be rectified without redeployment.
// unhealthy                           An error occurred during function deployment, which might be resolved over time, and might require redeployment. For example, issues with insufficient resources or a missing image.

const STATUSES = {
    ready:                            { fill: "green",  shape: "dot",  text: "" },
    readyNoDashboard:                 { fill: "green",  shape: "ring", text: "" },
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
}
const PROVISIONED = ['ready', 'scaledToZero', 'imported'];
const FAILED = ['error'];
const WAITING = ['waitingForBuild', 'waitingForResourceConfiguration', 'waitingForScaleResourceFromZero', 'waitingForScaleResourceToZero'];
const BUILDING = ['building', 'configuringResources', 'unhealthy'];




module.exports = {
    deployFunction,
    deployWatchFunction,
    refreshFunctionStatus,
    NonDuplicateAsyncFunction,
    Poller,
    STATUSES,
};