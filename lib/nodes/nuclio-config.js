const { numSetting, stripTrailingSlash } = require('../util');

module.exports = function(RED) {
    function NuclioServer(config) {
        RED.nodes.createNode(this, config);
        this.address = stripTrailingSlash(RED.util.evaluateNodeProperty(config.address, config.addressType, this));
        this.publicAddress = stripTrailingSlash(RED.util.evaluateNodeProperty(config.publicAddress, config.publicAddressType, this));
        const configuredInvocationPreference = config.invocationUrlPreference
            || process.env.NUCLIO_INVOCATION_URL_PREFERENCE;
        this.invocationUrlPreference = ['service', 'internal', 'external'].includes(configuredInvocationPreference)
            ? configuredInvocationPreference
            : 'service';
        this.externalInvocationProtocol = config.externalInvocationProtocol === 'http' ? 'http' : 'https';
        const configuredServiceHost = config.internalInvocationServiceHost
            ? RED.util.evaluateNodeProperty(
                config.internalInvocationServiceHost,
                config.internalInvocationServiceHostType || 'str',
                this,
            )
            : '';
        this.internalInvocationServiceHost = configuredServiceHost
            || process.env.NUCLIO_INTERNAL_INVOCATION_SERVICE_HOST
            || 'nuclio-{function}';

        this.requestTimeoutMs = numSetting(RED, this, config, 'requestTimeoutMs', 'NUCLIO_REQUEST_TIMEOUT_MS', 10000);
        this.deployTimeoutMs  = numSetting(RED, this, config, 'deployTimeoutMs',  'NUCLIO_DEPLOY_TIMEOUT_MS',  60000);
        this.pollMs           = numSetting(RED, this, config, 'pollMs',           'NUCLIO_POLL_MS',             1000);
        this.readyPollMs      = numSetting(RED, this, config, 'readyPollMs',      'NUCLIO_READY_POLL_MS',       5000);
        this.backoffMs        = numSetting(RED, this, config, 'backoffMs',        'NUCLIO_BACKOFF_MS',          5000);
        this.backoffMaxMs     = numSetting(RED, this, config, 'backoffMaxMs',     'NUCLIO_BACKOFF_MAX_MS',     60000);
        this.startStaggerMs   = numSetting(RED, this, config, 'startStaggerMs',   'NUCLIO_START_STAGGER_MS',   2000);
    }

    RED.nodes.registerType('nuclio-config', NuclioServer);
};
