const { before, after, afterEach } = require('node:test');
const helper = require('node-red-node-test-helper');
const nuclioNodes = [
    require('../../lib/nodes/nuclio-config.js'),
    require('../../lib/nodes/nuclio-project.js'),
    require('../../lib/nodes/nuclio-function.js'),
    require('../../lib/nodes/nuclio.js'),
];
const { startMockNuclio } = require('./mock-nuclio');

helper.init(require.resolve('node-red'), { logging: { console: { level: 'off' } } });

before(() => new Promise(resolve => helper.startServer(resolve)));
after(() => new Promise(resolve => helper.stopServer(resolve)));

let activeMock;
afterEach(async () => {
    await helper.unload();
    if (activeMock) { await activeMock.close(); activeMock = null; }
});

const FN = 'test-fn';
const TEST_SERVER_DEFAULTS = {
    requestTimeoutMs: '10000',
    deployTimeoutMs: '60000',
    pollMs: '1000',
    readyPollMs: '5000',
    backoffMs: '150',
    backoffMaxMs: '400',
    startStaggerMs: '0',
};

const startMock = async options => {
    activeMock = await startMockNuclio(options);
    return activeMock;
};

// Default flow: server config + function config + invoke node + output helpers.
const baseFlow = (mock, fn = {}, inv = {}) => [
    { id: 'srv', type: 'nuclio-config', address: mock.url, addressType: 'str', publicAddress: '', publicAddressType: 'str', invocationUrlPreference: 'internal', ...TEST_SERVER_DEFAULTS },
    { id: 'fn', type: 'nuclio-function', server: 'srv', name: FN, runtime: 'python:3.12', code: 'x = 1', configCode: '', env_vars: [], ...fn },
    { id: 'inv', type: 'nuclio', function: 'fn', timeoutMs: '', maxInFlight: '', headers: [], wires: [['out1'], ['out2']], ...inv },
    { id: 'out1', type: 'helper' },
    { id: 'out2', type: 'helper' },
];

const load = (flow, credentials) => new Promise((resolve, reject) => {
    helper.load(nuclioNodes, flow, credentials, err => err ? reject(err) : resolve());
});

const waitUntil = async (fn, { timeout = 5000, interval = 25, msg = 'condition' } = {}) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const value = await fn();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, interval));
    }
    throw new Error(`timed out waiting for ${msg}`);
};

const nextMsg = (node, { timeout = 5000 } = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeout);
    node.once('input', msg => { clearTimeout(timer); resolve(msg); });
});

const waitReady = (fnNode, opts = {}) => waitUntil(
    () => fnNode.invocationUrl && !fnNode.redeploying && fnNode.fnState === 'ready',
    { msg: 'function ready', ...opts },
);

const isDeployWrite = request => ['POST', 'PUT', 'PATCH'].includes(request.method)
    && request.url.startsWith('/api/functions');

module.exports = {
    FN,
    TEST_SERVER_DEFAULTS,
    baseFlow,
    helper,
    isDeployWrite,
    load,
    nextMsg,
    startMock,
    startMockNuclio: startMock,
    waitReady,
    waitUntil,
};
