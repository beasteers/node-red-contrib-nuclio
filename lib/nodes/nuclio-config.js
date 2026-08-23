const { asString, numSetting, stripTrailingSlash } = require('../util');
const { AUTH_TYPES, buildAuthHeaders } = require('../nuclio-auth');

const DEPLOYMENT_POLICIES = new Set(['managed', 'disabled']);

const resolveRequestHeaders = (RED, node, entries) => entries.map(entry => ({
    name: entry?.name,
    value: entry?.type === 'env'
        ? RED.util.evaluateNodeProperty(entry.value, 'env', node)
        : entry?.value,
}));

module.exports = function(RED) {
    function NuclioServer(config) {
        RED.nodes.createNode(this, config);
        this.address = stripTrailingSlash(RED.util.evaluateNodeProperty(config.address, config.addressType, this));
        const configuredNamespace = RED.util.evaluateNodeProperty(
            config.namespace,
            config.namespaceType || 'str',
            this,
        );
        const namespace = asString(configuredNamespace).trim();
        this.namespace = namespace && namespace !== 'undefined' && namespace !== 'null'
            ? namespace
            : 'nuclio';
        this.publicAddress = stripTrailingSlash(RED.util.evaluateNodeProperty(config.publicAddress, config.publicAddressType, this));
        const configuredInvocationPreference = config.invocationUrlPreference;
        this.invocationUrlPreference = ['service', 'internal', 'external'].includes(configuredInvocationPreference)
            ? configuredInvocationPreference
            : 'service';
        this.externalInvocationProtocol = config.externalInvocationProtocol === 'http' ? 'http' : 'https';
        this.authType = `${config.authType || 'none'}`.trim().toLowerCase();
        const authUsername = config.authUsername
            ? RED.util.evaluateNodeProperty(config.authUsername, config.authUsernameType || 'str', this)
            : '';
        let requestHeaders = [];
        try {
            if (this.credentials?.requestHeaders && this.credentials.requestHeaders !== '__PWRD__') {
                requestHeaders = JSON.parse(this.credentials.requestHeaders);
            }
        } catch {
            this.authConfigError = 'Request headers credentials are not valid JSON';
        }
        try {
            if (!AUTH_TYPES.has(this.authType)) throw new Error(`Unknown authentication mode "${this.authType}"`);
            if (!Array.isArray(requestHeaders)) throw new Error('Request headers credentials must be a list');
            this.requestHeaders = buildAuthHeaders({
                authType: this.authType,
                username: authUsername,
                password: this.credentials?.authPassword,
                token: this.credentials?.authToken,
                requestHeaders: resolveRequestHeaders(RED, this, requestHeaders),
            });
        } catch (err) {
            this.authConfigError ||= err.message;
            this.requestHeaders = {};
        }
        const configuredDeploymentPolicy = config.deploymentPolicy;
        const resolvedDeploymentPolicy = configuredDeploymentPolicy === undefined
            || configuredDeploymentPolicy === null
            || configuredDeploymentPolicy === ''
            ? 'managed'
            : RED.util.evaluateNodeProperty(
                configuredDeploymentPolicy,
                config.deploymentPolicyType || 'str',
                this,
            );
        const normalizedDeploymentPolicy = `${resolvedDeploymentPolicy || ''}`.trim().toLowerCase();
        this.deploymentPolicy = DEPLOYMENT_POLICIES.has(normalizedDeploymentPolicy)
            ? normalizedDeploymentPolicy
            : 'disabled';
        this.deploymentEnabled = this.deploymentPolicy === 'managed';
        this.deploymentPolicyError = DEPLOYMENT_POLICIES.has(normalizedDeploymentPolicy)
            ? ''
            : `Unknown deployment policy "${resolvedDeploymentPolicy || ''}"; deployment is disabled`;
        const configuredServiceHost = config.internalInvocationServiceHost
            ? RED.util.evaluateNodeProperty(
                config.internalInvocationServiceHost,
                config.internalInvocationServiceHostType || 'str',
                this,
            )
            : '';
        this.internalInvocationServiceHost = configuredServiceHost
            || 'nuclio-{function}';

        this.requestTimeoutMs = numSetting(RED, this, config, 'requestTimeoutMs', 10000);
        this.deployTimeoutMs  = numSetting(RED, this, config, 'deployTimeoutMs',  60000);
        this.pollMs           = numSetting(RED, this, config, 'pollMs',           1000);
        this.readyPollMs      = numSetting(RED, this, config, 'readyPollMs',      5000);
        this.backoffMs        = numSetting(RED, this, config, 'backoffMs',        5000);
        this.backoffMaxMs     = numSetting(RED, this, config, 'backoffMaxMs',     60000);
        this.startStaggerMs   = numSetting(RED, this, config, 'startStaggerMs',   2000);
    }

    RED.nodes.registerType('nuclio-config', NuclioServer, {
        credentials: {
            authPassword: { type: 'password' },
            authToken: { type: 'password' },
            requestHeaders: { type: 'text' },
        },
    });
};
