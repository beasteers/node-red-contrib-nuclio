// Keep the Node-RED integration cases in one test file so the shared test-helper
// lifecycle is created and torn down once. The cases themselves live by behavior.
require('./integration/deployment.test');
require('./integration/invocation.test');
require('./integration/admin-api.test');
require('./integration/lifecycle.test');
