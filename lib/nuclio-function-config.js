const { Buffer } = require('buffer');
const { hashConfig } = require('./util');
const RUNTIME_METADATA = require('../resources/nuclio-runtime-metadata');

// Deployed-config fingerprints stamped on the function as annotations. The
// config hash covers the whole desired body; the build hash covers only the
// image/build-affecting inputs (runtime/handler/image/build). Comparing hashes
// instead of deep-diffing server state (which is full of server-side defaults)
// makes change detection immune to default churn.
const HASH_ANNOTATION = 'nuclio.io/node-red-config-hash';
const BUILD_HASH_ANNOTATION = 'nuclio.io/node-red-build-hash';
const MANAGED_SPEC_PATHS_ANNOTATION = 'nuclio.io/node-red-managed-spec-paths';

const runtimeMetadata = runtime => {
    const value = `${runtime || ''}`;
    const base = value.split(':')[0];
    return RUNTIME_METADATA.find(item => item.value === value)
        || RUNTIME_METADATA.find(item => item.base === base)
        || { handler: 'main:handler' };
};

const managedSpecPaths = (value, prefix = 'spec') => {
    if (value === undefined) return [];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
    const keys = Object.keys(value);
    if (!keys.length) return [prefix];
    return keys.flatMap(key => managedSpecPaths(value[key], `${prefix}.${key}`));
};

const parseManagedSpecPaths = (value) => {
    try {
        const paths = JSON.parse(value || '[]');
        return Array.isArray(paths) ? paths.filter(path => typeof path === 'string') : [];
    } catch {
        return [];
    }
};

const deletePath = (source, path) => {
    const keys = path.split('.');
    const lastKey = keys.pop();
    let current = source;
    for (const key of keys) {
        if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, key)) return;
        current = current[key];
    }
    if (current && typeof current === 'object') delete current[lastKey];
};

// Compile the Node-RED function node settings into the Nuclio API body. This
// function is intentionally free of dashboard or Node-RED runtime I/O so it
// can be tested and reasoned about independently from deployment.
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

    const buildHash = hashConfig({
        runtime: spec.runtime,
        handler: spec.handler,
        image: spec.image,
        build: spec.build,
    });
    const configHash = hashConfig(body);
    body.metadata.annotations[BUILD_HASH_ANNOTATION] = buildHash;
    body.metadata.annotations[HASH_ANNOTATION] = configHash;
    // Track only the fields explicitly managed by Node-RED. This lets updates
    // remove settings deleted from the editor while retaining Nuclio-enriched
    // fields that were never present in the desired configuration.
    body.metadata.annotations[MANAGED_SPEC_PATHS_ANNOTATION] = JSON.stringify(managedSpecPaths(spec));

    return body;
}

module.exports = {
    buildFunctionConfig,
    managedSpecPaths,
    parseManagedSpecPaths,
    deletePath,
    HASH_ANNOTATION,
    BUILD_HASH_ANNOTATION,
    MANAGED_SPEC_PATHS_ANNOTATION,
};
