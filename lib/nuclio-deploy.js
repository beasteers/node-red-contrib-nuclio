const _ = require('lodash');
const { Buffer } = require('buffer');
const { diff, merge, hashConfig, isTransientErrorCode, isTransientHttpStatus } = require('./util');
const { getClient } = require('./nuclio-client');
const { invalidateStatus } = require('./nuclio-status');
const { STATUSES, canUpdateFunction } = require('./nuclio-states');
const RUNTIME_METADATA = require('../resources/nuclio-runtime-metadata');

const runtimeMetadata = runtime => {
    const value = `${runtime || ''}`;
    const base = value.split(':')[0];
    return RUNTIME_METADATA.find(item => item.value === value)
        || RUNTIME_METADATA.find(item => item.base === base)
        || { handler: 'main:handler' };
};

// Timeouts come from the server config node (node.server.requestTimeoutMs /
// deployTimeoutMs); the redeploy deadline from the function node
// (node.redeployDeadlineMs). All resolve node-config -> built-in default;
// environment values are used only when the field type is explicitly `env`.

// Deployed-config fingerprints stamped on the function as annotations. The
// config hash covers the whole desired body; the build hash covers only the
// image/build-affecting inputs (runtime/handler/image/build). Comparing hashes instead of
// deep-diffing server state (which is full of server-side defaults) makes
// change detection immune to default churn.
const HASH_ANNOTATION = 'nuclio.io/node-red-config-hash';
const BUILD_HASH_ANNOTATION = 'nuclio.io/node-red-build-hash';
const PROJECT_CACHE_TTL_MS = 60000;

// Project creation is shared by every function attached to a server config
// node. Cache the existence check and retain the in-flight promise so a flow
// deploy cannot stampede the dashboard with identical list/create requests.
const ensureProject = async (node, client, projectName) => {
    const server = node.server || node;
    server.projectCache ||= new Map();

    const now = Date.now();
    const cached = server.projectCache.get(projectName);
    if (cached && cached.expiresAt > now) return cached.promise;

    const promise = (async () => {
        const existingProjects = await client.listProjects();
        const foundProject = Object.values(existingProjects.data || {})
            .find(project => project?.metadata?.name === projectName);
        if (foundProject) return;

        node.log(`Creating project ${projectName}...`);
        try {
            // A concurrent deploy may create the project after our list
            // request; Nuclio reports that harmless race as HTTP 409.
            const resp = await client.createProject(projectName);
            node.log(`${resp.status} ${resp.statusText}: ${resp.config.url}`);
        } catch (err) {
            if (err.response?.status !== 409) throw err;
            node.log(`Project ${projectName} was created concurrently; continuing.`);
        }
    })();

    server.projectCache.set(projectName, {
        promise,
        expiresAt: now + PROJECT_CACHE_TTL_MS,
    });
    promise.catch(() => {
        // Do not cache a failed lookup or create attempt. The next reconcile
        // should be allowed to retry immediately.
        if (server.projectCache.get(projectName)?.promise === promise) {
            server.projectCache.delete(projectName);
        }
    });
    return promise;
};

const normalizeCodeEntryForUpdate = (functionConfig, desiredConfig) => {
    const desiredSpec = desiredConfig.spec || {};
    const desiredBuild = desiredSpec.build || {};
    const spec = functionConfig.spec || (functionConfig.spec = {});
    const build = spec.build || (spec.build = {});
    const hasInlineSource = typeof desiredBuild.functionSourceCode === 'string'
        && desiredBuild.functionSourceCode.length > 0;
    const hasExternalSource = Boolean(desiredBuild.codeEntryType || desiredBuild.path);

    // lodash.merge preserves server-enriched fields that are absent from the
    // desired body. Code-entry types are mutually exclusive, so remove the
    // stale winner before Nuclio evaluates the new request.
    if (desiredSpec.image) {
        delete build.functionSourceCode;
        delete build.codeEntryType;
        delete build.path;
        delete build.codeEntryAttributes;
    } else if (hasInlineSource || hasExternalSource) {
        delete spec.image;
        if (hasInlineSource) {
            delete build.codeEntryType;
            delete build.path;
            delete build.codeEntryAttributes;
        } else if (hasExternalSource) {
            delete build.functionSourceCode;
        }
    }
};


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
    const handler = runtimeMetadata(runtime).handler;

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
        image: spec.image,
        build: spec.build,
    });
    const configHash = hashConfig(body);
    body.metadata.annotations[BUILD_HASH_ANNOTATION] = buildHash;
    body.metadata.annotations[HASH_ANNOTATION] = configHash;

    return body;
}

async function deployFunctionConfig(node, {
    config: configBody,
    force,
    rebuild,
}) {
    const projectName = configBody?.metadata?.labels?.['nuclio.io/project-name'] || 'default';
    const name = configBody?.metadata?.name;
    const client = getClient(node);
    node.log(`Deploying function ${name}...`);

    /* -------------------------- Get / Create Project -------------------------- */

    await ensureProject(node, client, projectName);

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

        // Building, waiting, unknown, and missing states are observed without
        // modification; only known updateable states may enter the update path.
        if (canUpdateFunction(state)) {
            const { status, ...oldFunc } = r.data;
            const existingHash = oldFunc.metadata?.annotations?.[HASH_ANNOTATION];
            const desiredHash = configBody.metadata.annotations[HASH_ANNOTATION];
            const newFunc = merge({}, oldFunc, configBody);
            normalizeCodeEntryForUpdate(newFunc, configBody);

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
        try {
            r = await client.createFunction(configBody);
            node.log(`${r.status} ${r.statusText}: ${r.config.url}`);
            changed = true;
        } catch (err) {
            // A concurrent reconciler can pass the GET-then-POST gap. The
            // other creator owns the deployment now; observe it and let the
            // next reconciliation compare hashes before attempting an update.
            if (err.response?.status !== 409) throw err;
            node.log(`Function ${name} was created concurrently; continuing.`);
            r = await client.getFunction(name);
        }
    }
    return { response: r, changed };
}


// Build + push the function config. Returns true if the deploy request was
// accepted, false if it failed, undefined if skipped (already deploying).
// `node.redeploying` stays set on success - the reconcile loop clears it once
// the function reports a terminal state, and invoke nodes fall back until then.
// `options.rebuild` forces a full image rebuild (re-fetches git/archive source)
// even when the config is unchanged; it implies force.
const runDeployFunction = async (node, _options={}) => {
    const opts = { ..._options };  // defensive copy — don't mutate caller's object
    const force = !!opts.force || !!opts.rebuild;
    if (opts.rebuild) opts.force = true;
    if (node.server?.deploymentEnabled === false) {
        node.redeploying = false;
        node.status(STATUSES.deploymentDisabled);
        return;
    }
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
        const { rebuild } = deployOpts;
        const configBody = buildFunctionConfig(deployOpts);
        const { changed } = await deployFunctionConfig(node, { config: configBody, force, rebuild });
        if (changed || force) invalidateStatus(node);
        // Nothing was pushed - don't hold invoke nodes in the redeploy fallback
        if (!changed) node.redeploying = false;
        return true;
    } catch (err) {
        // Deploy failed - clear the flag so the reconcile loop can retry
        node.redeploying = false;
        const r = err.response;
        if (r && (r.status === 404 || isTransientHttpStatus(r.status))) {
            // Server not ready or transient gateway error, back off and retry
            node.status({ fill: "red", shape: "ring", text: `Error ${r.status}` });
            return false;
        }

        // Connectivity errors (server down) are transient — warn but don't
        // trigger Catch nodes. Same classification as nuclio.js:15.
        const isConnErr = isTransientErrorCode(err?.code);
        if (isConnErr) {
            node.warn(`Deploy deferred: server not reachable (${err.code})`);
        } else {
            node.error(`Error while deploying function: ${err.message} ${r?.data ? JSON.stringify(r.data) : ''}`);
        }
        node.status({ fill: "red", shape: "ring", text: err.message });
        return false;
    }
};

// Reconcile and editor actions can arrive at the same time. Nuclio's build
// endpoint is not a safe single-flight operation, so coalesce concurrent
// requests per function node. A later reconcile will observe the result and
// decide whether another deploy is needed.
const deployFunction = (node, options = {}) => {
    if (node.deployPromise) return node.deployPromise;
    const promise = runDeployFunction(node, options);
    const tracked = promise.finally(() => {
        if (node.deployPromise === tracked) node.deployPromise = null;
    });
    node.deployPromise = tracked;
    return tracked;
};

module.exports = {
    buildFunctionConfig,
    deployFunction,
    ensureProject,
    STATUSES,
    HASH_ANNOTATION,
    BUILD_HASH_ANNOTATION,
};
