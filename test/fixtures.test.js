const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const root = path.join(__dirname, '..');

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

test('Kubernetes HTTP reference is a complete Helm plus Kustomize application', () => {
    const prefix = 'examples/http/k8s';
    const kustomization = readYaml(`${prefix}/kustomization.yaml`);
    const deployment = readYaml(`${prefix}/deployment.yaml`);
    const service = readYaml(`${prefix}/service.yaml`);
    const flow = readJson(`${prefix}/data/flows.json`);
    const installer = fs.readFileSync(path.join(root, `${prefix}/install-nuclio.sh`), 'utf8');
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
    assert.match(installer, /upgrade --install nuclio nuclio\/nuclio/);
    assert.match(installer, /containerBuilderKind=kaniko/);
    assert.match(installer, /registry\.pushPullUrl/);
    assertFlowReferences(`${prefix}/data/flows.json`, flow);
    assert.ok(flow.some(node => node.type === 'nuclio-config'));
    assert.ok(flow.some(node => node.type === 'nuclio-project'));
    assert.ok(flow.some(node => node.type === 'nuclio-function'));
    assert.match(fs.readFileSync(path.join(root, `${prefix}/README.md`), 'utf8'), /kubectl apply -k/);
});

test('Compose smoke fixture is isolated from the example gallery', () => {
    const prefix = 'hack/compose-smoke';
    const compose = readYaml(`${prefix}/docker-compose.yml`);
    const platform = readYaml(`${prefix}/config/platform.yaml`);
    const flow = readJson(`${prefix}/flows.json`);
    const smokeScript = fs.readFileSync(path.join(root, 'scripts/smoke-test.sh'), 'utf8');
    const scenario = readJson(`${prefix}/stress-scenario.json`);

    assert.equal(compose.name, 'nuclio-compose-smoke');
    assert.ok(compose.services?.nodered, 'smoke fixture: missing Node-RED service');
    assert.ok(compose.services?.['nuclio-dashboard'], 'smoke fixture: missing Nuclio dashboard service');
    assert.equal(
        platform.local?.defaultFunctionContainerNetworkName,
        `${compose.name}_default`,
        'smoke fixture: local platform network must match Compose',
    );
    assertFlowReferences(`${prefix}/flows.json`, flow);
    assert.equal(flow.find(node => node.type === 'nuclio-function').name, 'smoke-test');
    assert.equal(scenario.defaults.url, 'http://nuclio-nuclio-smoke-test:8080');
    assert.match(smokeScript, /SMOKE_DIR=.*hack\/compose-smoke/);
    assert.match(smokeScript, /COMPOSE_FILE=.*docker-compose\.yml/);
    assert.doesNotMatch(smokeScript, /data\/flows\.json|FLOWS_BACKUP/);
});

test('KinD verification remains maintainer tooling', () => {
    const runner = fs.readFileSync(path.join(root, 'hack/kind/run.sh'), 'utf8');
    assert.match(runner, /up \[basic\|autoscale\|scale-to-zero\]/);
    assert.match(runner, /test-scenario \[basic\|autoscale\|scale-to-zero\]/);
    assert.match(runner, /down/);
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
