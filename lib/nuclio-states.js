// Nuclio states and their Node-RED presentation live here so adding a state
// does not require synchronized edits across the client, API, and reconciler.
const BUILDING = Object.freeze(['building', 'configuringResources']);
const WAITING = Object.freeze([
    'waitingForBuild',
    'waitingForResourceConfiguration',
    'waitingForScaleResourceFromZero',
    'waitingForScaleResourceToZero',
]);

const NUCLIO_STATES = Object.freeze([
    'ready',
    'imported',
    ...BUILDING,
    ...WAITING,
    'scaledToZero',
    'error',
    'unhealthy',
]);

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

    // Node-RED-only statuses.
    redeploying:                      { fill: "yellow", shape: "dot",  text: "Redeploying..." },
    deploymentDisabled:               { fill: "grey",   shape: "ring", text: "Deployment disabled" },
    unhealthyOk:                      { fill: "yellow", shape: "ring", text: "Unhealthy?" },
};

// Fixed polling intervals for states that are not user-tunable. Ready and the
// ordinary default interval remain configurable on the server node.
const POLL_MS = {
    deploying:    3000,
    error:        5000,
    scaledToZero: 5000,
    ...Object.fromEntries(WAITING.map(state => [state, 3000])),
};

const KNOWN_STATES = new Set(NUCLIO_STATES);
const UPDATE_BLOCKED_STATES = new Set([...BUILDING, ...WAITING]);

// Unknown future states are observed but never modified. Null is also not
// updateable because it does not provide enough information to safely deploy.
const canUpdateFunction = (state) =>
    state != null && KNOWN_STATES.has(state) && !UPDATE_BLOCKED_STATES.has(state);

module.exports = {
    BUILDING,
    WAITING,
    NUCLIO_STATES,
    STATUSES,
    POLL_MS,
    canUpdateFunction,
};
