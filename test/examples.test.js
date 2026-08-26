const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const root = path.join(__dirname, '..');
const examples = ['http', 'cron', 'batching', 'mqtt', 'nats', 'nats-mqtt'];

const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const readYaml = file => yaml.load(fs.readFileSync(path.join(root, file), 'utf8'));

function assertFlowReferences(file, flow) {
    const ids = new Set(flow.map(node => node.id));
    assert.equal(ids.size, flow.length, `${file}: node IDs must be unique`);

    for (const node of flow) {
        for (const field of ['server', 'project', 'function']) {
            if (node[field] && !(node.type === 'nats-suite-server' && field === 'server')) {
                assert.ok(ids.has(node[field]), `${file}: ${node.id}.${field} references ${node[field]}`);
            }
        }

        // MQTT node broker fields contain a broker hostname configuration, not
        // a Node-RED node ID. The remaining broker references are node IDs.
        if (!['mqtt-broker', 'mqtt in', 'mqtt out'].includes(node.type) && node.broker) {
            assert.ok(ids.has(node.broker), `${file}: ${node.id}.broker references ${node.broker}`);
        }

        for (const wire of node.wires || []) {
            for (const target of wire) {
                assert.ok(ids.has(target), `${file}: ${node.id} wire references ${target}`);
            }
        }
    }
}

test('Compose examples have valid local-platform wiring and self-contained paths', () => {
    const readme = fs.readFileSync(path.join(root, 'examples/README.md'), 'utf8');
    const launcher = fs.readFileSync(path.join(root, 'examples/run-compose.sh'), 'utf8');

    for (const example of examples) {
        const prefix = `examples/${example}`;
        const compose = readYaml(`${prefix}/docker-compose.yml`);
        const platform = readYaml(`${prefix}/config/platform.yaml`);
        const flow = readJson(`${prefix}/data/flows.json`);
        const expectedNetwork = `${compose.name}_default`;

        assert.ok(compose.services?.nodered, `${prefix}: missing Node-RED service`);
        assert.ok(compose.services?.['nuclio-dashboard'], `${prefix}: missing Nuclio dashboard service`);
        assert.equal(compose.services.nodered.build.context, '../..', `${prefix}: build context must reach the repository root`);
        assert.ok(compose.services.nodered.volumes.includes('../../config/settings.js:/data/settings.js'), `${prefix}: settings mount must reach the repository root`);
        assert.ok(compose.services.nodered.volumes.includes('../..:/usr/src/node-red/node-red-contrib-nuclio'), `${prefix}: package mount must reach the repository root`);
        assert.equal(platform.local?.defaultFunctionContainerNetworkName, expectedNetwork, `${prefix}: local platform network must match Compose`);
        assert.match(compose.services['nuclio-dashboard'].image, /NUCLIO_ARCH/, `${prefix}: dashboard image must be architecture-selectable`);
        assertFlowReferences(`${prefix}/data/flows.json`, flow);
        assert.ok(flow.some(node => node.type === 'nuclio-config'), `${prefix}: missing server config`);
        assert.ok(flow.some(node => node.type === 'nuclio-project'), `${prefix}: missing project`);
        assert.ok(flow.some(node => node.type === 'nuclio-function'), `${prefix}: missing function`);
        assert.ok(readme.includes(`run-compose.sh ${example}`), `${prefix}: example is not documented`);
        assert.match(launcher, new RegExp(`${example}(?:\\||\\))`), `${prefix}: launcher does not allow the example`);

        if (example === 'nats') {
            assert.equal(compose.services.nodered.depends_on.nats.condition, 'service_healthy', `${prefix}: Node-RED must wait for NATS readiness`);
            assert.ok(compose.services.nats.healthcheck, `${prefix}: NATS must have a readiness check`);
        }
    }
});

test('direct-trigger examples expose only intentional deployment/control nodes', () => {
    for (const example of ['mqtt', 'nats', 'nats-mqtt']) {
        const flow = readJson(`examples/${example}/data/flows.json`);
        const invokeNodes = flow.filter(node => node.type === 'nuclio');
        if (example === 'nats') {
            const functionIds = new Set(flow.filter(node => node.type === 'nuclio-function').map(node => node.id));
            assert.equal(invokeNodes.length, 4, `${example}: each Nuclio-backed tab should show its worker`);
            for (const node of invokeNodes) assert.ok(functionIds.has(node.function), `${example}: invoke must reference a function node`);
        } else {
            assert.equal(invokeNodes.length, 0, `${example}: direct trigger should not contain an unused Invoke node`);
        }
    }
});

test('focused examples cover the primary trigger and invocation patterns', () => {
    const http = readJson('examples/http/data/flows.json');
    assert.ok(http.some(node => node.type === 'nuclio'), 'HTTP example should invoke through Node-RED');

    const cron = readJson('examples/cron/data/flows.json');
    assert.match(cron.find(node => node.type === 'nuclio-function').configCode, /kind: cron/);

    const batching = readJson('examples/batching/data/flows.json');
    const batchFunction = batching.find(node => node.type === 'nuclio-function');
    assert.match(batchFunction.configCode, /batchSize: 4/);
    assert.ok(batching.some(node => node.type === 'function'), 'batching example should create a burst');

    const nats = readJson('examples/nats/data/flows.json');
    assert.ok(nats.some(node => node.type === 'nats-suite-publish'));
    assert.ok(nats.some(node => node.type === 'nats-suite-subscribe'));
    assert.match(nats.find(node => node.name === 'example-nats-request-worker').configCode, /reply: true/);
    assert.ok(nats.some(node => node.type === 'nats-suite-stream-publisher'));
    assert.ok(nats.some(node => node.type === 'nats-suite-kv-put'));
    assert.match(nats.find(node => node.name === 'example-nats-jetstream-worker').configCode, /demo\.nats\.jetstream\.input/);
    assert.match(nats.find(node => node.name === 'example-nats-kv-worker').configCode, /demo\.nats\.kv\.request/);
    assert.ok(nats.some(node => node.type === 'nats-suite-publish' && node.mode === 'request' && node.datapointid === 'demo.nats.kv.request'));
    assert.equal(nats.filter(node => node.type === 'nuclio-function').length, 4);
    assert.equal(nats.filter(node => node.type === 'nuclio').length, 4);
    for (const fn of nats.filter(node => node.type === 'nuclio-function')) {
        assert.match(fn.configCode, /disableDefaultHTTPTrigger: true/, `${fn.name}: NATS worker should not expose an implicit HTTP trigger`);
    }

    const natsMqtt = readJson('examples/nats-mqtt/data/flows.json');
    assert.ok(natsMqtt.some(node => node.type === 'mqtt in'));
    assert.match(natsMqtt.find(node => node.type === 'nuclio-function').configCode, /reply: false/);
});
