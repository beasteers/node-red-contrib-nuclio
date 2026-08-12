const _ = require('lodash');
const { Buffer } = require('buffer');
const { diff, merge, hashConfig, TRANSIENT_ERR_CODES } = require('./util');
const { createClient, BUILDING, WAITING } = require('./nuclio-client');

// Timeouts come from the server config node (node.server.requestTimeoutMs /
// deployTimeoutMs); the redeploy deadline from the function node
// (node.redeployDeadlineMs). All resolve node-config -> NUCLIO_* env -> default.

// Deployed-config fingerprints stamped on the function as annotations. The
// config hash covers the whole desired body; the build hash covers only the
// build-affecting inputs (runtime/handler/build). Comparing hashes instead of
// deep-diffing server state (which is full of server-side defaults) makes
// change detection immune to default churn.
const HASH_ANNOTATION = 'nuclio.io/node-red-config-hash';
const BUILD_HASH_ANNOTATION = 'nuclio.io/node-red-build-hash';


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

    const spec = {
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
    };

    const body = {
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
        spec,
    };

    // Fingerprints of the desired config. Build hash covers only the inputs
    // that force an image build; config hash covers the whole body. Both are
    // stamped as annotations so the next deploy can compare against them.
    const buildHash = hashConfig({
        runtime: spec.runtime,
        handler: spec.handler,
        build: spec.build,
    });
    const configHash = hashConfig(body);
    body.metadata.annotations[BUILD_HASH_ANNOTATION] = buildHash;
    body.metadata.annotations[HASH_ANNOTATION] = configHash;

    return body;
}

async function deployFunctionConfig(node, address, {
    config: configBody,
    force,
    rebuild,
}) {
    const projectName = configBody?.metadata?.labels?.['nuclio.io/project-name'] || 'default';
    const name = configBody?.metadata?.name;
    const client = createClient({ address, requestTimeoutMs: node.server.requestTimeoutMs, deployTimeoutMs: node.server.deployTimeoutMs }, projectName);
    node.log(`Deploying function ${name}...`);

    /* -------------------------- Get / Create Project -------------------------- */

    const existingProjects = await client.listProjects();
    const foundProject = Object.values(existingProjects.data || {}).find(p => p?.metadata?.name === projectName);
    if (!foundProject) {
        node.log(`Creating project ${projectName}...`);
        // any 2xx counts - axios already rejects non-2xx responses
        const resp = await client.createProject(projectName);
        node.log(`${resp.status} ${resp.statusText}: ${resp.config.url}`);
    }

    /* ----------------- Check if function already exists (GET) ----------------- */

    let r, funcExists = false;
    try {
        r = await client.getFunction(name);
        funcExists = true;
    } catch (err) {
        if (err.response?.status !== 404) throw err;
    }

    /* -------------------- Update Function (POST/PUT/PATCH) -------------------- */

    // If it does, update it
    let changed = false;
    if (funcExists && r.status === 200) {
        const state = r.data?.status?.state;

        // building/waiting functions can't be updated; unknown state is assumed
        // to be in-transition and is also skipped
        if (state != null && !(BUILDING.includes(state) || WAITING.includes(state))) {
            const { status, ...oldFunc } = r.data;
            const existingHash = oldFunc.metadata?.annotations?.[HASH_ANNOTATION];
            const desiredHash = configBody.metadata.annotations[HASH_ANNOTATION];
            const newFunc = merge({}, oldFunc, configBody);

            // Does the deployed config differ from what we want? Compare the
            // hash annotations; functions deployed by older versions don't
            // have them yet - fall back to the deep diff for those. An explicit
            // rebuild always takes the update path: Nuclio re-fetches the
            // source (git clone / archive download) on every build, so a PUT
            // without skip-build picks up new commits behind an unchanged URL.
            let configChanged;
            let diffResult;
            if (rebuild) {
                configChanged = true;
            } else if (existingHash) {
                configChanged = existingHash !== desiredHash;
            } else {
                diffResult = diff(newFunc, { apiVersion: newFunc.apiVersion, kind: newFunc.kind, ...oldFunc });
                configChanged = !_.isEmpty(diffResult);
            }

            // No differences!
            if (!configChanged) {
                // Function isn't ready, just patch the desired state to ready
                if ((state !== 'ready') || force) {

                    /* ------------------------ Set desired state (PATCH) ----------------------- */

                    node.log(`Patching function ${name}...`);
                    r = await client.patchDesiredState(name);
                    node.log(`${r.status} ${r.statusText}: ${r.config.url}`);
                    changed = true;
                }

                /* ------------------------- Otherwise: up to date. -------------------------- */

            } else {

                /* -------------------------- Update function (PUT) ------------------------- */

                // REF `skip-build`: https://github.com/nuclio/nuclio/blob/37f777a642b2176835e00e44921ed204df1dd908/pkg/functionconfig/types.go#L636
                // Reuse the image when the build inputs are unchanged: exact
                // via the build hash, or via the legacy diff for old functions
                // (this PUT migrates them to hash-based detection). A forced
                // rebuild never skips the build.
                const specDiff = diffResult?.spec || {};
                const buildUnchanged = !rebuild && (existingHash
                    ? oldFunc.metadata?.annotations?.[BUILD_HASH_ANNOTATION] === configBody.metadata.annotations[BUILD_HASH_ANNOTATION]
                    : !(specDiff.build || specDiff.image || specDiff.runtime));
                if (buildUnchanged && state === 'ready') {
                    node.debug("No build changes detected. Skipping build...");
                    newFunc.metadata.annotations['skip-build'] = 'true';
                }

                // Detected changes, update function
                node.log(`Updating function ${name}${rebuild ? ' (rebuild)' : ''}...`);
                r = await client.updateFunction(name, newFunc);
                node.log(`${r.status} ${r.statusText}: ${r.config.url}`);
                changed = true;
            }
        }
    }

    /* ------------------------- Create Function (POST) ------------------------- */

    else {
        // Function doesn't exist, create it
        node.log(`Creating function ${name}...`);
        r = await client.createFunction(configBody);
        node.log(`${r.status} ${r.statusText}: ${r.config.url}`);
        changed = true;
    }
    return { response: r, changed };
}


// Build + push the function config. Returns true if the deploy request was
// accepted, false if it failed, undefined if skipped (already deploying).
// `node.redeploying` stays set on success - the reconcile loop clears it once
// the function reports a terminal state, and invoke nodes fall back until then.
// `options.rebuild` forces a full image rebuild (re-fetches git/archive source)
// even when the config is unchanged; it implies force.
const deployFunction = async (node, _options={}) => {
    const opts = { ..._options };  // defensive copy — don't mutate caller's object
    const force = !!opts.force || !!opts.rebuild;
    if (opts.rebuild) opts.force = true;
    if ((node.redeploying && !force) || !node.fnConfigSpec) return;
    // A manual redeploy is an explicit "try again" - un-give-up the self-healer.
    if (force) node.selfHealAttempts = 0;
    node.redeploying = true;
    node.redeployDeadline = Date.now() + node.redeployDeadlineMs;
    node.fnInvocationStatus = -1;
    node.lastInvocationAt = 0;
    node.status(STATUSES.redeploying);
    try {
        const deployOpts = { ...node.fnConfigSpec, ...opts };
        const { rebuild, address } = deployOpts;
        const configBody = buildFunctionConfig(deployOpts);
        const { changed } = await deployFunctionConfig(node, address, { config: configBody, force, rebuild });
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

        // Connectivity errors (server down) are transient — warn but don't
        // trigger Catch nodes. Same classification as nuclio.js:15.
        const isConnErr = TRANSIENT_ERR_CODES.includes(err?.code);
        if (isConnErr) {
            node.warn(`Deploy deferred: server not reachable (${err.code})`);
        } else {
            node.error(`Error while deploying function: ${err.message} ${r?.data ? JSON.stringify(r.data) : ''}`);
        }
        node.status({ fill: "red", shape: "ring", text: err.message });
        return false;
    }
};

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
    redeploying:                      { fill: "yellow", shape: "dot",  text: "Redeploying..." },
    unhealthyOk:                      { fill: "yellow", shape: "ring", text: "Unhealthy?" },
};

module.exports = {
    buildFunctionConfig,
    deployFunction,
    STATUSES,
    HASH_ANNOTATION,
    BUILD_HASH_ANNOTATION,
};
