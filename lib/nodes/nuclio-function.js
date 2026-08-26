const yaml = require('js-yaml');
const { reconcileLoop } = require('../nuclio-reconcile');
const { deployFunction, undeployFunction } = require('../nuclio-deploy');
const { registerFunction, unregisterFunction, invalidateStatus } = require('../nuclio-status');
const { asString, boolSetting, numSetting, validateFunctionName, validateSourcePath } = require('../util');
const { interpolateConfig, resolveEntries } = require('../nuclio-deployment-variables');
const { getCredentialEntries, resolveTypedValue } = require('../nuclio-credential-entries');
const { STATUSES } = require('../nuclio-states');
const { decorateStatus } = require('../nuclio-node-status');
const SOURCE_TYPES = new Set(['sourceCode', 'image', 'git', 'archive', 'advanced']);

const normalizeSourceType = sourceType => sourceType === 'github' ? 'git' : sourceType;

const optionalSetting = (RED, node, config, field, defaultType = 'str') => {
    const value = config[field];
    if (value === undefined || value === null || value === '') return undefined;
    return RED.util.evaluateNodeProperty(value, config[`${field}Type`] || defaultType, node);
};

const optionalInteger = (RED, node, config, field) => {
    const value = optionalSetting(RED, node, config, field, 'num');
    if (value === undefined || value === '') return undefined;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1) throw new Error(`${field} must be a positive integer`);
    return number;
};

const optionalNonNegativeInteger = (RED, node, config, field) => {
    const value = optionalSetting(RED, node, config, field, 'num');
    if (value === undefined || value === '') return undefined;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) throw new Error(`${field} must be a non-negative integer`);
    return number;
};

const applyExecutionConfig = (RED, node, configData, config) => {
    const triggerName = optionalSetting(RED, node, config, 'executionTriggerName') || 'default-http';
    const mode = optionalSetting(RED, node, config, 'executionMode');
    const batchMode = optionalSetting(RED, node, config, 'executionBatchMode');
    const batchSize = optionalInteger(RED, node, config, 'executionBatchSize');
    const batchTimeout = optionalSetting(RED, node, config, 'executionBatchTimeout');
    const workers = optionalInteger(RED, node, config, 'executionWorkers');
    const eventTimeout = optionalSetting(RED, node, config, 'executionEventTimeout');
    const hasSettings = [mode !== 'inherit' ? mode : undefined,
        batchMode !== 'inherit' ? batchMode : undefined,
        batchSize, batchTimeout, workers, eventTimeout]
        .some(value => value !== undefined && value !== '');
    if (!hasSettings) return;
    if (mode && mode !== 'inherit' && !['sync', 'async'].includes(`${mode}`)) {
        throw new Error(`Invalid execution mode "${mode}"`);
    }
    if (batchMode && batchMode !== 'inherit' && !['enable', 'disable'].includes(`${batchMode}`)) {
        throw new Error(`Invalid execution batching mode "${batchMode}"`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(`${triggerName}`)) {
        throw new Error(`Invalid execution trigger name "${triggerName}"`);
    }

    const spec = configData.spec = { ...(configData.spec || {}) };
    const triggerSettings = [mode !== 'inherit' ? mode : undefined,
        batchMode !== 'inherit' ? batchMode : undefined,
        batchSize, batchTimeout, workers]
        .some(value => value !== undefined && value !== '');
    if (triggerSettings) {
        const triggers = spec.triggers = { ...(spec.triggers || {}) };
        const existingTrigger = triggers[triggerName];
        if (existingTrigger?.kind && `${existingTrigger.kind}`.toLowerCase() !== 'http') {
            throw new Error(`Execution settings require an HTTP trigger; "${triggerName}" is ${existingTrigger.kind}`);
        }
        const trigger = { ...(existingTrigger || {}), kind: existingTrigger?.kind || 'http' };
        if (mode && mode !== 'inherit') trigger.mode = mode;
        if (batchMode && batchMode !== 'inherit') {
            trigger.batch = { ...(trigger.batch || {}), mode: batchMode };
        }
        if (batchSize !== undefined) trigger.batch = { ...(trigger.batch || {}), batchSize };
        if (batchTimeout !== undefined) trigger.batch = { ...(trigger.batch || {}), timeout: batchTimeout };
        if (workers !== undefined) trigger.numWorkers = workers;
        triggers[triggerName] = trigger;
    }
    if (eventTimeout !== undefined) spec.eventTimeout = eventTimeout;
};

const applyScalingConfig = (RED, node, configData, config) => {
    const mode = optionalSetting(RED, node, config, 'scalingMode') || 'yaml';
    const values = {
        replicas: optionalNonNegativeInteger(RED, node, config, 'scalingReplicas'),
        minReplicas: optionalNonNegativeInteger(RED, node, config, 'scalingMinReplicas'),
        maxReplicas: optionalNonNegativeInteger(RED, node, config, 'scalingMaxReplicas'),
        targetCPU: optionalInteger(RED, node, config, 'scalingTargetCPU'),
    };
    const requests = {
        cpu: optionalSetting(RED, node, config, 'resourceRequestsCpu'),
        memory: optionalSetting(RED, node, config, 'resourceRequestsMemory'),
    };
    const limits = {
        cpu: optionalSetting(RED, node, config, 'resourceLimitsCpu'),
        memory: optionalSetting(RED, node, config, 'resourceLimitsMemory'),
    };
    if (!['yaml', 'fixed', 'autoscaled'].includes(mode)) {
        throw new Error(`Invalid scaling mode "${mode}"`);
    }
    if (values.minReplicas !== undefined && values.maxReplicas !== undefined
        && values.minReplicas > values.maxReplicas) {
        throw new Error('Minimum replicas cannot exceed maximum replicas');
    }
    if (values.targetCPU !== undefined && (values.targetCPU < 1 || values.targetCPU > 100)) {
        throw new Error('Target CPU must be an integer from 1 to 100');
    }
    if (mode === 'fixed') {
        if (values.replicas === undefined || values.replicas < 1) {
            throw new Error('Fixed scaling requires a positive replica count');
        }
        values.minReplicas = undefined;
        values.maxReplicas = undefined;
        values.targetCPU = undefined;
    } else if (mode === 'autoscaled') {
        if (values.maxReplicas !== undefined && values.maxReplicas < 1) {
            throw new Error('Autoscaling requires a positive maximum replica count');
        }
        // `scalingReplicas` belongs to the fixed-replica editor mode and can
        // contain a stale hidden value after switching to autoscaling. Nuclio
        // uses minReplicas/maxReplicas for autoscaling. An explicit
        // `replicas: 0` takes precedence over those bounds and prevents
        // scale-from-zero, so the selected mode must remove it.
        values.replicas = undefined;
    }

    const hasValues = mode !== 'yaml' || Object.values(values).some(value => value !== undefined)
        || Object.values(requests).some(value => value !== undefined)
        || Object.values(limits).some(value => value !== undefined);
    if (!hasValues) return;

    const spec = configData.spec = { ...(configData.spec || {}) };
    if (mode === 'fixed') {
        delete spec.minReplicas;
        delete spec.maxReplicas;
        delete spec.targetCPU;
    } else if (mode === 'autoscaled') {
        delete spec.replicas;
    }
    for (const [key, value] of Object.entries(values)) {
        if (value !== undefined) spec[key] = value;
    }
    if (Object.values(requests).some(value => value !== undefined)) {
        spec.resources = { ...(spec.resources || {}), requests: { ...(spec.resources?.requests || {}) } };
        for (const [key, value] of Object.entries(requests)) {
            if (value !== undefined) spec.resources.requests[key] = value;
        }
    }
    if (Object.values(limits).some(value => value !== undefined)) {
        spec.resources = { ...(spec.resources || {}), limits: { ...(spec.resources?.limits || {}) } };
        for (const [key, value] of Object.entries(limits)) {
            if (value !== undefined) spec.resources.limits[key] = value;
        }
    }
};

const applySecretReferences = (configData, config) => {
    const references = Array.isArray(config.envSecretRefs)
        ? config.envSecretRefs.filter(entry => entry && entry.name && entry.secretName && entry.secretKey)
        : [];
    if (!references.length) return;

    const normalized = references.map(entry => ({
        name: `${entry.name}`,
        valueFrom: {
            secretKeyRef: {
                name: `${entry.secretName}`,
                key: `${entry.secretKey}`,
            },
        },
    }));
    const names = new Set(normalized.map(entry => entry.name));
    const spec = configData.spec = { ...(configData.spec || {}) };
    const existingEnv = Array.isArray(spec.env) ? spec.env.filter(entry => !names.has(entry?.name)) : [];
    spec.env = [...existingEnv, ...normalized];
};

const inferSourceType = (configData) => {
    if (configData?.spec?.image) return 'image';
    const codeEntryType = normalizeSourceType(configData?.spec?.build?.codeEntryType);
    if (codeEntryType) return SOURCE_TYPES.has(codeEntryType) ? codeEntryType : 'advanced';
    if (configData?.spec?.build?.path) return 'advanced';
    return 'sourceCode';
};

const applySourceConfig = (configData, config, credentials = {}) => {
    const spec = configData.spec = { ...(configData.spec || {}) };
    const build = spec.build = { ...(spec.build || {}) };
    const existingBuild = { ...build };
    const existingAttributes = { ...(existingBuild.codeEntryAttributes || {}) };
    const normalizedSourceType = normalizeSourceType(config.sourceType);
    const sourceType = SOURCE_TYPES.has(normalizedSourceType) ? normalizedSourceType : inferSourceType(configData);
    const hasExplicitSourceType = Object.prototype.hasOwnProperty.call(config, 'sourceType');
    const sourcePath = Object.prototype.hasOwnProperty.call(config, 'codeEntryPath')
        ? config.codeEntryPath || ''
        : existingBuild.path || '';
    const sourceBranch = Object.prototype.hasOwnProperty.call(config, 'codeEntryBranch')
        ? config.codeEntryBranch || ''
        : existingAttributes.branch || '';
    const sourceTag = Object.prototype.hasOwnProperty.call(config, 'codeEntryTag')
        ? config.codeEntryTag || ''
        : existingAttributes.tag || '';
    const sourceReference = Object.prototype.hasOwnProperty.call(config, 'codeEntryReference')
        ? config.codeEntryReference || ''
        : existingAttributes.reference || '';
    const sourceUsername = Object.prototype.hasOwnProperty.call(config, 'codeEntryUsername')
        ? config.codeEntryUsername || ''
        : existingAttributes.username || '';
    const sourceWorkDir = Object.prototype.hasOwnProperty.call(config, 'codeEntryWorkDir')
        ? config.codeEntryWorkDir || ''
        : existingAttributes.workDir || '';

    // Legacy flows have no source selector fields. Preserve their raw YAML
    // exactly, including source types that this editor does not expose yet.
    if ((sourceType === 'sourceCode' || sourceType === 'advanced') && !hasExplicitSourceType) return sourceType;

    // Advanced source configurations are owned entirely by the YAML editor.
    // Do not clear fields belonging to a newer or unsupported Nuclio source.
    if (sourceType === 'advanced') return sourceType;

    // The source selector owns these mutually exclusive fields. Removing stale
    // fields is important when a function changes from inline code/image to a
    // repository source, because Nuclio gives them precedence over one another.
    delete spec.image;
    delete build.functionSourceCode;
    delete build.codeEntryType;
    delete build.path;
    delete build.codeEntryAttributes;

    if (sourceType === 'image') {
        spec.image = sourcePath;
        return sourceType;
    }

    if (sourceType === 'git' || sourceType === 'archive') {
        build.codeEntryType = sourceType;
        build.path = sourcePath;
        const attributes = {};
        if (sourceType === 'git' && sourceBranch) attributes.branch = sourceBranch;
        if (sourceType === 'git' && sourceTag) attributes.tag = sourceTag;
        if (sourceType === 'git' && sourceReference) attributes.reference = sourceReference;
        if (sourceType === 'git' && sourceUsername) attributes.username = sourceUsername;
        if (sourceWorkDir) attributes.workDir = sourceWorkDir;
        const password = credentials.password || existingAttributes.password || '';
        if (sourceType === 'git' && password) attributes.password = password;
        if (Object.keys(attributes).length) build.codeEntryAttributes = attributes;
        return sourceType;
    }

    return sourceType;
};

module.exports = function(RED) {
    const getDeploymentVariables = (node, config) => {
        let entries = config.deploymentVariables;
        try {
            if (node.credentials?.deploymentVariables && node.credentials.deploymentVariables !== '__PWRD__') {
                entries = JSON.parse(node.credentials.deploymentVariables);
            }
        } catch (err) {
            throw new Error(`Could not parse deployment variables: ${err.message}`);
        }
        return resolveEntries(RED, node, entries);
    };

    const getConfig = (node, config) => {
        const parsedConfig = yaml.load(config.configCode || '{}') || {};
        const interpolation = interpolateConfig(
            parsedConfig,
            node.deploymentVariables || new Map(),
        );
        const configData = interpolation.value;
        if (typeof configData !== 'object' || Array.isArray(configData)) {
            throw new Error('Function config YAML must contain an object at its root');
        }

        applyExecutionConfig(RED, node, configData, config);
        applyScalingConfig(RED, node, configData, config);
        applySecretReferences(configData, config);
        const sourceType = applySourceConfig(configData, config, {
            password: node.credentials?.codeEntryPassword || node.credentials?.codeEntryToken || '',
        });
        const nameError = validateFunctionName(config.name);
        if (nameError) throw new Error(nameError);
        const sourcePath = sourceType === 'image'
            ? configData.spec?.image
            : configData.spec?.build?.path;
        const sourcePathError = validateSourcePath(sourceType, sourcePath);
        if (sourcePathError) throw new Error(sourcePathError);

        const envEntries = getCredentialEntries(node, config.env_vars, 'environmentVariables')
            .filter(entry => entry && typeof entry === 'object' && entry.name);
        const secretEnvPaths = envEntries
            .map((entry, index) => entry?.type === 'cred' ? `spec.env.${index}.value` : null)
            .filter(Boolean);

        return {
            config: {
                name: config.name,
                runtime: config.runtime || 'python:3.12',
                // External sources and images must never carry the online editor's
                // code, otherwise Nuclio will select functionSourceCode first.
                code: sourceType === 'sourceCode' ? config.code || '' : '',
                config: configData,
                project: node.project?.name,
                address: node.server?.address,
                env: envEntries.map(({ name, value, type }) => ({
                    name,
                    value: asString(resolveTypedValue(RED, node, null, { name, value, type })),
                })),
                annotations: {
                    'nuclio.io/node-red': 'true',
                    'nuclio.io/node-red-node-id': node.id,
                    'nuclio.io/node-red-version': `${RED.settings.version}`,
                },
            },
            secretPaths: [...interpolation.secretPaths, ...secretEnvPaths],
        };
    };

    function NuclioFunctionConfig(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Config nodes have no editor presence - mirror status onto the invoke
        // nodes that use this function and retain the latest status for nodes
        // that register later.
        node.childNodes = [];
        node.lastStatus = null;
        node.status = status => {
            node.lastStatus = status;
            node.childNodes.forEach(child => child.status(decorateStatus(status, node, child)));
        };

        node.server = RED.nodes.getNode(config.server) || null;
        node.project = config.project
            ? RED.nodes.getNode(config.project)
            : { name: 'default' };
        if (node.server?.address) registerFunction(node);

        node.configError = false;
        node.configErrorReason = '';
        if (config.project && !node.project) {
            node.configError = true;
            node.configErrorReason = 'Project config node not found';
            node.status({ fill: 'yellow', shape: 'ring', text: 'Project not found' });
        }
        const fixedSecretPaths = [
            'spec.build.codeEntryAttributes.password',
            'spec.build.codeEntryAttributes.headers.Authorization',
        ];
        // Keep only paths, never duplicate secret values on the node. These
        // paths are used to redact admin responses before they leave Node-RED.
        node.secretVarPaths = fixedSecretPaths;
        try {
            node.deploymentVariables = getDeploymentVariables(node, config);
            node.deploymentVariableError = '';
        } catch (err) {
            node.deploymentVariables = new Map();
            node.deploymentVariableError = err.message;
            node.warn(`Invalid deployment variables: ${err.message}`);
        }
        if (!node.server?.address) {
            node.configError = true;
            node.configErrorReason = 'No server configured';
            node.status({ fill: 'yellow', shape: 'ring', text: 'No server' });
        }
        if (!node.configError) {
            try {
                if (node.deploymentVariableError) throw new Error(node.deploymentVariableError);
                const resolvedConfig = getConfig(node, config);
                node.fnConfigSpec = resolvedConfig.config;
                node.secretVarPaths = [
                    ...new Set([...node.secretVarPaths, ...resolvedConfig.secretPaths]),
                ];
                node.debug(`Nuclio function config loaded: ${node.fnConfigSpec.name} (${node.fnConfigSpec.runtime})`);
            } catch (err) {
                node.error(`Invalid Nuclio config YAML: ${err.message}`);
                node.status({ fill: 'red', shape: 'ring', text: 'Invalid config YAML' });
                node.configError = true;
                node.configErrorReason = 'Invalid config YAML';
            }
        }

        node.maxSelfHealAttempts = numSetting(RED, node, config, 'maxSelfHealAttempts', 5);
        node.redeployDeadlineMs  = numSetting(RED, node, config, 'redeployDeadlineMs', 120000);
        node.autoRedeployOnUnhealthy = boolSetting(RED, node, config, 'autoRedeployOnUnhealthy', false);
        node.autoRedeployOnError = boolSetting(RED, node, config, 'autoRedeployOnError', false);
        node.deploymentMode = config.deploymentMode === 'lazy' ? 'lazy' : 'eager';
        node.lazyActivated = node.deploymentMode !== 'lazy';

        node.closed = false;
        node.dashboardAbortController = new AbortController();
        node.reconcileStarted = false;
        node.reconcilePromise = null;
        // Lifecycle commands are serialized per function, not per invoke
        // node. Multiple invoke nodes can reference this shared config node.
        node.commandPromise = Promise.resolve();
        node.redeploying = false;
        node.selfHealAttempts = 0;
        node.fnInvocationStatus = -1;
        node.lastInvocationAt = 0;
        node.unhealthyStreak = 0;
        // Eager functions get a bounded startup-recovery window so a host or
        // Docker daemon restart can recover a missing processor without
        // requiring a manual deploy command. Lazy functions opt into the same
        // window when their deploy command activates them.
        node.startupRecoveryActive = node.deploymentMode !== 'lazy';
        node.startupRecoveryAttempts = 0;
        node.startupRecoveryNextAt = 0;
        node.startupRecoveryHealthySince = null;
        node.deploymentGeneration = 0;

        node.on('close', function(_removed, done) {
            node.closed = true;
            node.dashboardAbortController.abort();
            unregisterFunction(node);
            if (node.reconcileTimer) {
                clearTimeout(node.reconcileTimer);
                node.reconcileTimer = null;
            }
            node.reconcileWake?.();
            if (typeof done === 'function') {
                const pending = [node.reconcilePromise, node.deployPromise].filter(Boolean);
                Promise.allSettled(pending).then(() => done());
            }
        });

        const runReconcile = (options) => reconcileLoop(node, options).catch(err => {
                node.error(`Reconcile loop stopped: ${err.message}`);
                if (node.closed) return;
                node.reconcileTimer = setTimeout(() => runReconcile(options), node.server.backoffMs);
            });
        const startReconcileLoop = (options) => {
            const promise = runReconcile(options);
            node.reconcilePromise = promise;
            promise.then(() => {
                if (node.reconcilePromise === promise) node.reconcilePromise = null;
            }, () => {
                if (node.reconcilePromise === promise) node.reconcilePromise = null;
            });
            return promise;
        };
        node.startReconcile = (options = {}) => {
            if (node.closed || node.configError || node.server?.deploymentEnabled === false || node.reconcileStarted) return false;
            node.reconcileStarted = true;
            startReconcileLoop(options);
            return true;
        };
        node.activateDeployment = async (options = {}) => {
            const { wakeReconcile = true, ...deployOptions } = options;
            if (node.server?.deploymentEnabled === false || node.configError) return false;
            if (node.lazyActivated === false) node.deploymentGeneration++;
            node.lazyActivated = true;
            node.startupRecoveryActive = true;
            node.startupRecoveryAttempts = 0;
            node.startupRecoveryNextAt = 0;
            node.startupRecoveryHealthySince = null;
            if (!node.reconcileStarted) {
                node.startReconcile({ skipStagger: true, skipInitialDeploy: true });
            }
            const accepted = await deployFunction(node, deployOptions);
            // An explicit command should not wait for the normal ready poll
            // cadence before the reconcile loop observes its result.
            if (wakeReconcile) node.reconcileWake?.();
            return accepted;
        };
        node.deactivateDeployment = async () => {
            const wasActivated = node.lazyActivated !== false;
            const wasStartupRecoveryActive = node.startupRecoveryActive;
            node.deploymentGeneration++;
            node.lazyActivated = false;
            node.startupRecoveryActive = false;
            node.startupRecoveryHealthySince = null;
            node.redeploying = false;
            node.status(STATUSES.waitingForDeploy);

            try {
                if (node.deployPromise) await node.deployPromise;
                const result = await undeployFunction(node);
                node.fnState = null;
                node.invocationUrls = [];
                node.invocationUrl = '';
                node.statusSnapshot = null;
                node.statusSnapshotAt = 0;
                node.fnInvocationStatus = -1;
                node.lastInvocationAt = 0;
                invalidateStatus(node);
                node.reconcileWake?.();
                return result;
            } catch (err) {
                node.lazyActivated = wasActivated;
                node.startupRecoveryActive = wasStartupRecoveryActive;
                node.reconcileWake?.();
                throw err;
            }
        };
        if (node.server?.deploymentPolicyError) node.warn(node.server.deploymentPolicyError);
        if (node.server?.deploymentEnabled === false && !node.configError) {
            node.status(STATUSES.deploymentDisabled);
        } else if (node.deploymentMode === 'lazy' && !node.configError) {
            node.status(STATUSES.waitingForDeploy);
        } else {
            node.startReconcile();
        }
    }

    RED.nodes.registerType('nuclio-function', NuclioFunctionConfig, {
        credentials: {
            deploymentVariables: { type: 'text' },
            environmentVariables: { type: 'text' },
            codeEntryPassword: { type: 'password' },
            // Legacy credential retained so old flows can be loaded and migrated.
            codeEntryToken: { type: 'password' },
        },
    });
};
