const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const root = path.join(__dirname, '..');
const examples = ['http', 'cron', 'batching', 'mqtt', 'nats-request', 'nats-mqtt'];

const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const readYaml = file => yaml.load(fs.readFileSync(path.join(root, file), 'utf8'));

function assertFlowReferences(file, flow) {
    const ids = new Set(flow.map(node => node.id));
    assert.equal(ids.size, flow.length, `${file}: node IDs must be unique`);

    for (const node of flow) {
        for (const field of ['server', 'project', 'function']) {
            if (node[field]) {
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
    }
});

test('direct-trigger examples do not contain misleading Invoke nodes', () => {
    for (const example of ['mqtt', 'nats-request', 'nats-mqtt']) {
        const flow = readJson(`examples/${example}/data/flows.json`);
        assert.equal(flow.filter(node => node.type === 'nuclio').length, 0, `${example}: direct trigger should not contain an unused Invoke node`);
    }
});

test('Kubernetes HTTP reference is a small Kustomize application', () => {
    const prefix = 'examples/http/k8s';
    const kustomization = readYaml(`${prefix}/kustomization.yaml`);
    const deployment = readYaml(`${prefix}/deployment.yaml`);
    const service = readYaml(`${prefix}/service.yaml`);
    const flow = readJson(`${prefix}/data/flows.json`);
    const container = deployment.spec.template.spec.containers[0];
    const env = Object.fromEntries((container.env || []).map(entry => [entry.name, entry.value]));

    assert.deepEqual(kustomization.resources, ['deployment.yaml', 'service.yaml']);
    assert.deepEqual(
        kustomization.configMapGenerator.map(generator => generator.name),
        ['node-red-http-settings', 'node-red-http-flows'],
    );
    assert.equal(deployment.kind, 'Deployment');
    assert.equal(deployment.spec.template.spec.initContainers[0].name, 'seed-node-red');
    assert.equal(service.spec.selector['app.kubernetes.io/name'], 'node-red-http');
    assert.equal(container.image, 'nodered-nuclio-reference:local');
    assert.equal(env.NUCLIO_DASHBOARD_URL, 'http://nuclio-dashboard.nuclio.svc.cluster.local:8070');
    assert.equal(env.NUCLIO_NAMESPACE, 'nuclio');
    assert.equal(env.NUCLIO_PROJECT, 'example-http-k8s');
    assertFlowReferences(`${prefix}/data/flows.json`, flow);
    assert.ok(flow.some(node => node.type === 'nuclio-config'));
    assert.ok(flow.some(node => node.type === 'nuclio-project'));
    assert.ok(flow.some(node => node.type === 'nuclio-function'));
    assert.match(fs.readFileSync(path.join(root, `${prefix}/README.md`), 'utf8'), /kubectl apply -k/);
});

test('KinD verification remains maintainer tooling', () => {
    const runner = fs.readFileSync(path.join(root, 'hack/kind/run.sh'), 'utf8');
    const wrapper = fs.readFileSync(path.join(root, 'scripts/kind-canary.sh'), 'utf8');
    assert.match(runner, /up \[basic\|autoscale\|scale-to-zero\]/);
    assert.match(runner, /test-scenario \[basic\|autoscale\|scale-to-zero\]/);
    assert.match(runner, /down/);
    assert.match(wrapper, /hack\/kind\/run\.sh/);
    assert.ok(fs.existsSync(path.join(root, 'hack/kind/README.md')));
    assert.match(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /hack\/kind/);
});

test('KinD fixture is static and environment-driven', () => {
    const fixture = path.join(root, 'hack/kind/fixture');
    const flow = readJson('hack/kind/fixture/flows.json');
    const functionNode = flow.find(node => node.type === 'nuclio-function');

    for (const file of ['Dockerfile', 'main.py', 'settings.js', 'flows.json']) {
        assert.ok(fs.existsSync(path.join(fixture, file)), `missing fixture asset: ${file}`);
    }
    assert.equal(functionNode.sourceType, 'advanced');
    assert.ok(functionNode.deploymentVariables.every(variable => variable.type === 'env'));
    assert.match(functionNode.configCode, /\$\{CANARY_IMAGE\}/);
    assert.match(functionNode.configCode, /\$\{CANARY_MIN_REPLICAS\}/);
    assert.match(fs.readFileSync(path.join(fixture, 'settings.js'), 'utf8'), /process\.env\.NODE_RED_PORT/);
    assert.equal(fs.readdirSync(path.join(root, 'hack/kind'), { recursive: true }).some(file => file.endsWith('.tmpl')), false);
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

    const natsRequest = readJson('examples/nats-request/data/flows.json');
    assert.match(natsRequest.find(node => node.type === 'nuclio-function').configCode, /reply: true/);

    const natsMqtt = readJson('examples/nats-mqtt/data/flows.json');
    assert.ok(natsMqtt.some(node => node.type === 'mqtt in'));
    assert.match(natsMqtt.find(node => node.type === 'nuclio-function').configCode, /reply: false/);
});
