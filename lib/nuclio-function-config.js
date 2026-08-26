const { Buffer } = require('buffer');
const { hashConfig, splitByDotWithEscape } = require('./util');
const RUNTIME_METADATA = require('../resources/nuclio-runtime-metadata');

// Deployed-config fingerprints stamped on the function as annotations. The
// config hash covers the whole desired body; the build hash covers only the
// image/build-affecting inputs (runtime/handler/image/build). Comparing hashes
// instead of deep-diffing server state (which is full of server-side defaults)
// makes change detection immune to default churn.
const HASH_ANNOTATION = 'nuclio.io/node-red-config-hash';
const BUILD_HASH_ANNOTATION = 'nuclio.io/node-red-build-hash';
const MANAGED_SPEC_PATHS_ANNOTATION = 'nuclio.io/node-red-managed-spec-paths';

// Nuclio's public documentation has used both `Http` and `HTTP` in this
// field's spelling over time. Emit the JSON/API spelling used by the current
// function model, while accepting the documented alias when loading YAML.
const DEFAULT_HTTP_TRIGGER_FIELD = 'disableDefaultHTTPTrigger';
const DEFAULT_HTTP_TRIGGER_ALIAS = 'disableDefaultHttpTrigger';

const normalizeDefaultHttpTriggerField = config => {
    const spec = config?.spec;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)
        || !Object.prototype.hasOwnProperty.call(spec, DEFAULT_HTTP_TRIGGER_ALIAS)) {
        return config;
    }

    const normalizedSpec = { ...spec };
    if (!Object.prototype.hasOwnProperty.call(spec, DEFAULT_HTTP_TRIGGER_FIELD)) {
        normalizedSpec[DEFAULT_HTTP_TRIGGER_FIELD] = spec[DEFAULT_HTTP_TRIGGER_ALIAS];
    }
    delete normalizedSpec[DEFAULT_HTTP_TRIGGER_ALIAS];
    return { ...config, spec: normalizedSpec };
};

const escapePathKey = key => `${key}`.replace(/\./g, '\\.');

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
    return keys.flatMap(key => managedSpecPaths(value[key], `${prefix}.${escapePathKey(key)}`));
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
    const keys = splitByDotWithEscape(path);
    const lastKey = keys.pop();
    let current = source;
    const parents = [];
    for (const key of keys) {
        if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, key)) return;
        parents.push([current, key]);
        current = current[key];
    }
    if (current && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, lastKey)) {
        delete current[lastKey];
        // Do not leave empty trigger/config objects behind after removing the
        // last explicitly-managed field. Arrays are intentionally not pruned.
        for (let index = parents.length - 1; index >= 0; index--) {
            const [parent, key] = parents[index];
            const child = parent[key];
            if (!child || typeof child !== 'object' || Array.isArray(child) || Object.keys(child).length) break;
            delete parent[key];
        }
    }
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
    const normalizedConfig = normalizeDefaultHttpTriggerField(config);
    const handler = runtimeMetadata(runtime).handler;
    const metadata = normalizedConfig?.metadata || {};

    const spec = {
        runtime: runtime,
        handler: handler,
        ...normalizedConfig?.spec,
        build: {
            functionSourceCode: code.trim() ? Buffer.from(code).toString('base64') : undefined,
            ...normalizedConfig?.spec?.build,
        },
        env: [
            ...(env || []),
            ...(normalizedConfig?.spec?.env || []),
        ],
    };

    const body = {
        apiVersion: 'nuclio.io/v1',
        kind: 'Function',
        ...normalizedConfig,
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
    normalizeDefaultHttpTriggerField,
    DEFAULT_HTTP_TRIGGER_FIELD,
    DEFAULT_HTTP_TRIGGER_ALIAS,
    HASH_ANNOTATION,
    BUILD_HASH_ANNOTATION,
    MANAGED_SPEC_PATHS_ANNOTATION,
};
