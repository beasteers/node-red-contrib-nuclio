module.exports = function(RED) {
    function NuclioProject(config) {
        RED.nodes.createNode(this, config);
        this.name = RED.util.evaluateNodeProperty(config.name, config.nameType, this) || 'default';
    }

    RED.nodes.registerType('nuclio-project', NuclioProject);
};
