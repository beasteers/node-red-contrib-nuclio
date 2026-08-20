const { numSetting, stripTrailingSlash } = require('../util');

module.exports = function(RED) {
    function NuclioServer(config) {
        RED.nodes.createNode(this, config);
        this.address = stripTrailingSlash(RED.util.evaluateNodeProperty(config.address, config.addressType, this));
        this.publicAddress = stripTrailingSlash(RED.util.evaluateNodeProperty(config.publicAddress, config.publicAddressType, this));
        const configuredInvocationPreference = config.invocationUrlPreference;
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
            || 'nuclio-{function}';

        this.requestTimeoutMs = numSetting(RED, this, config, 'requestTimeoutMs', 10000);
        this.deployTimeoutMs  = numSetting(RED, this, config, 'deployTimeoutMs',  60000);
        this.pollMs           = numSetting(RED, this, config, 'pollMs',           1000);
        this.readyPollMs      = numSetting(RED, this, config, 'readyPollMs',      5000);
        this.backoffMs        = numSetting(RED, this, config, 'backoffMs',        5000);
        this.backoffMaxMs     = numSetting(RED, this, config, 'backoffMaxMs',     60000);
        this.startStaggerMs   = numSetting(RED, this, config, 'startStaggerMs',   2000);
    }

    RED.nodes.registerType('nuclio-config', NuclioServer);
};
