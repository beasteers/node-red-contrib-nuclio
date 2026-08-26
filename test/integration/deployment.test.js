const { HASH_ANNOTATION, BUILD_HASH_ANNOTATION } = require('../../lib/nuclio-function-config.js');
const { getReplicaStatus } = require('../../lib/nuclio-status.js');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    FN,
    TEST_SERVER_DEFAULTS,
    baseFlow,
    helper,
    isDeployWrite,
    load,
    nextMsg,
    startMockNuclio,
    waitReady,
    waitUntil,
} = require('../helpers/node-red');

let mock;

/* -------------------------------------------------------------------------- */
/*                              Deploy / Reconcile                            */
/* -------------------------------------------------------------------------- */

test('deploys a new function: project + full spec', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, { env_vars: [{ name: 'MY_VAR', type: 'str', value: 'hello' }] }));

    const req = await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    assert.equal(req.body.metadata.name, FN);
    assert.equal(req.body.spec.runtime, 'python:3.12');
    assert.equal(req.body.spec.handler, 'main:handler');
    assert.equal(Buffer.from(req.body.spec.build.functionSourceCode, 'base64').toString(), 'x = 1');
    assert.equal(req.body.metadata.labels['nuclio.io/project-name'], 'default');
    assert.equal(req.body.metadata.annotations['nuclio.io/generated-by'], 'node-red');
    assert.equal(req.body.metadata.annotations['nuclio.io/node-red-node-id'], 'fn');
    assert.deepEqual(req.body.spec.env, [{ name: 'MY_VAR', value: 'hello' }]);
    // the default project pre-exists in the mock (real nuclio always has one)
    assert.ok(!mock.requests.some(r => r.method === 'POST' && r.url === '/api/projects'));
    // and the function settles to ready
    await waitReady(helper.getNode('fn'));
});

test('credential-backed environment variables are deployed without storing the value in the flow', async () => {
    mock = await startMockNuclio();
    const flow = baseFlow(mock, {
        env_vars: [{ name: 'FUNCTION_TOKEN', type: 'cred', value: '__PWRD__' }],
    });
    await load(flow, {
        fn: {
            environmentVariables: JSON.stringify([
                { name: 'FUNCTION_TOKEN', type: 'cred', value: 'secret-env-value' },
            ]),
        },
    });

    const req = await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    assert.deepEqual(req.body.spec.env, [{ name: 'FUNCTION_TOKEN', value: 'secret-env-value' }]);
    assert.equal(flow[1].env_vars[0].value, '__PWRD__');
    assert.doesNotMatch(JSON.stringify(flow), /secret-env-value/);
    assert.ok(helper.getNode('fn').secretVarPaths.includes('spec.env.0.value'));
});

test('server authentication and custom headers are sent to the dashboard', async () => {
    mock = await startMockNuclio();
    const flow = baseFlow(mock);
    flow[0].authType = 'basic';
    flow[0].authUsername = 'dashboard-user';
    flow[0].authUsernameType = 'str';
    flow[0].authPasswordType = 'cred';
    await load(flow, {
        srv: {
            authPassword: 'dashboard-password',
            requestHeaders: JSON.stringify([{ name: 'X-Organization', type: 'str', value: 'team-a' }]),
        },
    });

    const req = await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    assert.equal(req.headers.authorization, `Basic ${Buffer.from('dashboard-user:dashboard-password').toString('base64')}`);
    assert.equal(req.headers['x-organization'], 'team-a');
    assert.equal(req.headers['x-nuclio-project-name'], 'default');
    assert.equal(req.headers['x-nuclio-function-namespace'], 'nuclio');
});

test('server bearer authentication resolves an environment-typed token', async () => {
    mock = await startMockNuclio();
    const envName = 'NUCLIO_TEST_DASHBOARD_TOKEN';
    const previous = process.env[envName];
    process.env[envName] = 'environment-token';
    try {
        const flow = baseFlow(mock);
        flow[0].authType = 'bearer';
        flow[0].authToken = envName;
        flow[0].authTokenType = 'env';
        await load(flow);

        const req = await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
        assert.equal(req.headers.authorization, 'Bearer environment-token');
    } finally {
        if (previous === undefined) delete process.env[envName];
        else process.env[envName] = previous;
    }
});

test('execution controls merge into the configured HTTP trigger', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, {
        executionTriggerName: 'http',
        executionMode: 'async',
        executionBatchMode: 'enable',
        executionBatchSize: '10',
        executionBatchTimeout: '1s',
        executionWorkers: '4',
        executionEventTimeout: '30s',
    }));

    const req = await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    assert.equal(req.body.spec.eventTimeout, '30s');
    assert.deepEqual(req.body.spec.triggers.http, {
        kind: 'http',
        mode: 'async',
        batch: { mode: 'enable', batchSize: 10, timeout: '1s' },
        numWorkers: 4,
    });
});

test('inherit execution defaults do not emit a second HTTP trigger', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, {
        executionTriggerName: 'http',
        executionMode: 'inherit',
        executionBatchMode: 'inherit',
    }));

    const req = await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    assert.equal(req.body.spec.triggers, undefined);
});

test('execution controls default to Nuclio default-http trigger', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, { executionMode: 'async' }));

    const req = await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    assert.equal(req.body.spec.triggers['default-http'].mode, 'async');
});

test('execution controls reject a non-HTTP trigger with the same name', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, {
        executionTriggerName: 'worker',
        executionMode: 'async',
        configCode: `spec:
  disableDefaultHTTPTrigger: true
  triggers:
    worker:
      kind: nats
      url: nats://nats:4222
      attributes:
        topic: demo.request
`,
    }));

    const fn = helper.getNode('fn');
    assert.equal(fn.configError, true);
    assert.equal(fn.configErrorReason, 'Invalid config YAML');
    assert.equal(mock.requests.some(r => ['POST', 'PUT', 'PATCH'].includes(r.method)), false);
});

test('scaling and resource controls merge into the function spec', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, {
        scalingReplicas: '0',
        scalingMinReplicas: '1',
        scalingMaxReplicas: '3',
        scalingTargetCPU: '70',
        resourceRequestsCpu: '250m',
        resourceRequestsMemory: '256Mi',
        resourceLimitsCpu: '1',
        resourceLimitsMemory: '512Mi',
    }));

    const req = await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    assert.equal(req.body.spec.replicas, 0);
    assert.equal(req.body.spec.minReplicas, 1);
    assert.equal(req.body.spec.maxReplicas, 3);
    assert.equal(req.body.spec.targetCPU, 70);
    assert.deepEqual(req.body.spec.resources, {
        requests: { cpu: '250m', memory: '256Mi' },
        limits: { cpu: '1', memory: '512Mi' },
    });
});

test('fixed scaling mode emits only a fixed replica count', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, {
        scalingMode: 'fixed',
        scalingReplicas: '2',
        configCode: 'spec:\n  minReplicas: 1\n  maxReplicas: 5\n  targetCPU: 80\n',
    }));

    const req = await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    assert.equal(req.body.spec.replicas, 2);
    assert.equal(req.body.spec.minReplicas, undefined);
    assert.equal(req.body.spec.maxReplicas, undefined);
    assert.equal(req.body.spec.targetCPU, undefined);
});

test('autoscaled scaling mode emits autoscaling bounds without fixed replicas', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, {
        scalingMode: 'autoscaled',
        // This simulates switching from fixed scaling while the hidden fixed
        // replica field still contains its previous value.
        scalingReplicas: '2',
        scalingMinReplicas: '1',
        scalingMaxReplicas: '3',
        scalingTargetCPU: '70',
        configCode: 'spec:\n  replicas: 2\n',
    }));

    const req = await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    assert.equal(req.body.spec.replicas, undefined);
    assert.equal(req.body.spec.minReplicas, 1);
    assert.equal(req.body.spec.maxReplicas, 3);
    assert.equal(req.body.spec.targetCPU, 70);
});

test('scaling rejects an invalid autoscaling range', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, {
        scalingMode: 'autoscaled',
        scalingMinReplicas: '4',
        scalingMaxReplicas: '2',
    }));

    const fn = helper.getNode('fn');
    assert.equal(fn.configError, true);
    assert.equal(fn.configErrorReason, 'Invalid config YAML');
    assert.match(fn.lastStatus?.text || '', /Invalid config YAML/);
    assert.equal(mock.requests.some(r => r.method === 'POST' && r.url === '/api/functions'), false);
});

test('scaling rejects a zero autoscaling maximum', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, {
        scalingMode: 'autoscaled',
        scalingMinReplicas: '0',
        scalingMaxReplicas: '0',
    }));

    const fn = helper.getNode('fn');
    assert.equal(fn.configError, true);
    assert.equal(fn.configErrorReason, 'Invalid config YAML');
    assert.equal(mock.requests.some(r => r.method === 'POST' && r.url === '/api/functions'), false);
});

test('Kubernetes secret references are emitted without secret values', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, {
        envSecretRefs: [{ name: 'DATABASE_PASSWORD', secretName: 'app-secrets', secretKey: 'database-password' }],
    }));

    const req = await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    assert.deepEqual(req.body.spec.env, [{
        name: 'DATABASE_PASSWORD',
        valueFrom: { secretKeyRef: { name: 'app-secrets', key: 'database-password' } },
    }]);
    assert.doesNotMatch(JSON.stringify(req.body), /secret-value|password-value/i);
});

test('external Git source suppresses online code and emits Nuclio source fields', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, {
        sourceType: 'git',
        codeEntryPath: 'https://github.com/example/functions.git',
        codeEntryBranch: 'main',
        codeEntryTag: 'v1.0.0',
        codeEntryReference: 'refs/heads/main',
        codeEntryUsername: 'git-user',
        codeEntryWorkDir: '/python/function',
    }), {
        fn: { codeEntryPassword: 'git-password' },
    });

    const req = await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    assert.equal(req.body.spec.build.functionSourceCode, undefined);
    assert.equal(req.body.spec.build.codeEntryType, 'git');
    assert.equal(req.body.spec.build.path, 'https://github.com/example/functions.git');
    assert.deepEqual(req.body.spec.build.codeEntryAttributes, {
        branch: 'main',
        tag: 'v1.0.0',
        reference: 'refs/heads/main',
        username: 'git-user',
        workDir: '/python/function',
        password: 'git-password',
    });
    await waitReady(helper.getNode('fn'));

    const spec = await helper.request().get('/nuclio/api/functions?id=fn&view=spec').expect(200);
    assert.equal(spec.body.spec.build.codeEntryAttributes.password, '[redacted]');
});

test('unknown advanced source configuration is preserved', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, {
        configCode: [
            'spec:',
            '  build:',
            '    codeEntryType: s3',
            '    path: s3://bucket/function.zip',
            '    codeEntryAttributes:',
            '      s3Bucket: bucket',
            '  minReplicas: 2',
        ].join('\n'),
    }));

    const req = await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    assert.equal(req.body.spec.build.codeEntryType, 's3');
    assert.equal(req.body.spec.build.path, 's3://bucket/function.zip');
    assert.equal(req.body.spec.build.codeEntryAttributes.s3Bucket, 'bucket');
    assert.equal(req.body.spec.minReplicas, 2);
    assert.equal(req.body.spec.build.functionSourceCode, undefined);
});

test('a trailing slash on the server address is normalized', async () => {
    mock = await startMockNuclio();
    const flow = baseFlow(mock);
    flow[0].address = `${mock.url}/`;
    await load(flow);
    const req = await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    assert.equal(req.body.metadata.name, FN);
    await waitReady(helper.getNode('fn'));
});

test('redeploying an unchanged function is a no-op', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    await helper.unload();

    mock.requests.length = 0;
    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));
    assert.deepEqual(mock.requests.filter(isDeployWrite), []);
});

test('changed code deploys via PUT with a rebuild', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    await helper.unload();

    mock.requests.length = 0;
    await load(baseFlow(mock, { code: 'x = 2' }));
    const put = await mock.waitFor(r => r.method === 'PUT');
    assert.equal(Buffer.from(put.body.spec.build.functionSourceCode, 'base64').toString(), 'x = 2');
    // source changed: must NOT skip the build
    assert.equal(put.body.metadata.annotations['skip-build'], undefined);
});

test('numeric-only config change deploys via PUT, skipping the build', async () => {
    // regression: diff() used to swallow numeric/boolean changes entirely
    mock = await startMockNuclio();
    await load(baseFlow(mock, { configCode: 'spec:\n  minReplicas: 1\n' }));
    await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    await helper.unload();

    mock.requests.length = 0;
    await load(baseFlow(mock, { configCode: 'spec:\n  minReplicas: 2\n' }));
    const put = await mock.waitFor(r => r.method === 'PUT');
    assert.equal(put.body.spec.minReplicas, 2);
    // no build inputs changed: rebuild is skipped
    assert.equal(put.body.metadata.annotations['skip-build'], 'true');
});

test('removing a managed spec field removes it from the update body', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, { configCode: 'spec:\n  minReplicas: 2\n' }));
    await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    await helper.unload();

    mock.requests.length = 0;
    await load(baseFlow(mock));
    const put = await mock.waitFor(r => r.method === 'PUT');
    assert.equal(put.body.spec.minReplicas, undefined);
    assert.ok(put.body.metadata.annotations['nuclio.io/node-red-managed-spec-paths']);
});

test('deploys stamp config + build hash annotations', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    const req = await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    assert.match(req.body.metadata.annotations[HASH_ANNOTATION], /^[0-9a-f]{64}$/);
    assert.match(req.body.metadata.annotations[BUILD_HASH_ANNOTATION], /^[0-9a-f]{64}$/);
    await waitReady(helper.getNode('fn'));
});

test('matching config hash is a no-op even if the live spec drifted', async () => {
    // hash-based detection trusts the fingerprint over a deep-diff of server
    // state, so out-of-band edits are not churned back on every reconcile
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    await waitReady(helper.getNode('fn'));
    await helper.unload();

    // someone edits the function out-of-band (hash annotation stays)
    mock.functions[FN].spec.minReplicas = 9;
    mock.requests.length = 0;

    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));
    assert.deepEqual(mock.requests.filter(isDeployWrite), []);
});

test('a legacy function (no hash) is migrated via one PUT that stamps the hashes', async () => {
    const legacy = {
        apiVersion: 'nuclio.io/v1',
        kind: 'Function',
        metadata: {
            name: FN,
            labels: { 'nuclio.io/project-name': 'default' },
            annotations: { 'nuclio.io/generated-by': 'node-red' },
        },
        spec: {
            runtime: 'python:3.12',
            handler: 'main:handler',
            build: { functionSourceCode: Buffer.from('x = 1').toString('base64') },
            env: [],
        },
    };
    mock = await startMockNuclio({ functions: { [FN]: legacy } });
    await load(baseFlow(mock));

    // unchanged build inputs -> migration PUT skips the rebuild...
    const put = await mock.waitFor(r => r.method === 'PUT');
    assert.equal(put.body.metadata.annotations['skip-build'], 'true');
    // ...and stamps the hashes so future deploys are hash-based
    assert.match(put.body.metadata.annotations[HASH_ANNOTATION], /^[0-9a-f]{64}$/);
    assert.match(put.body.metadata.annotations[BUILD_HASH_ANNOTATION], /^[0-9a-f]{64}$/);
    await waitReady(helper.getNode('fn'));
    await helper.unload();

    // second deploy is now a hash-based no-op
    mock.requests.length = 0;
    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));
    assert.deepEqual(mock.requests.filter(isDeployWrite), []);
});

test('build-hash change rebuilds; non-build change after migration skips build', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    await helper.unload();

    // code change -> build hash differs -> no skip-build
    mock.requests.length = 0;
    await load(baseFlow(mock, { code: 'x = 2' }));
    let put = await mock.waitFor(r => r.method === 'PUT');
    assert.equal(put.body.metadata.annotations['skip-build'], undefined);
    await waitReady(helper.getNode('fn'));
    await helper.unload();

    // env-only change -> build hash matches -> skip-build
    mock.requests.length = 0;
    await load(baseFlow(mock, { code: 'x = 2', env_vars: [{ name: 'NEW_VAR', type: 'str', value: 'v' }] }));
    put = await mock.waitFor(r => r.method === 'PUT');
    assert.equal(put.body.metadata.annotations['skip-build'], 'true');
    assert.deepEqual(put.body.spec.env.find(e => e.name === 'NEW_VAR'), { name: 'NEW_VAR', value: 'v' });
});

test('deployment variable credentials land in the deployed spec', async () => {
    mock = await startMockNuclio();
    const flow = baseFlow(mock, {
        deploymentVariables: [{ name: 'S3_SECRET_ACCESS_KEY', type: 'cred', value: 'shh-cred', secret: true }],
        configCode: 'spec:\n  env:\n    - name: FUNCTION_SECRET\n      value: ${S3_SECRET_ACCESS_KEY}\n',
    });
    await load(flow, {
        fn: { deploymentVariables: JSON.stringify(flow[1].deploymentVariables) },
    });
    const req = await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    assert.equal(req.body.spec.env[0].value, 'shh-cred');
});

test('status API redacts encrypted secrets', async () => {
    mock = await startMockNuclio();
    const flow = baseFlow(mock, {
        deploymentVariables: [{ name: 'S3_SECRET_ACCESS_KEY', type: 'cred', value: 'shh-cred', secret: true }],
        configCode: 'spec:\n  env:\n    - name: FUNCTION_SECRET\n      value: ${S3_SECRET_ACCESS_KEY}\n',
    });
    await load(flow, {
        fn: { deploymentVariables: JSON.stringify(flow[1].deploymentVariables) },
    });
    await waitReady(helper.getNode('fn'));

    const res = await helper.request().get('/nuclio/api/functions?id=fn&view=spec').expect(200);
    assert.equal(res.body.spec.env[0].value, '[redacted]');
});

test('status defaults to a summary and redacts Nuclio trigger credentials in explicit specs', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, {
        configCode: `spec:
  triggers:
    kafka:
      kind: kafka-cluster
      attributes:
        sasl:
          password: kafka-password
        accessKey: kafka-access-key
`,
    }));
    await waitReady(helper.getNode('fn'));

    const summary = await helper.request().get('/nuclio/api/functions?id=fn').expect(200);
    assert.equal(summary.body.spec.triggers, undefined);

    const spec = await helper.request().get('/nuclio/api/functions?id=fn&view=spec').expect(200);
    assert.equal(spec.body.spec.triggers.kafka.attributes.sasl.password, '[redacted]');
    assert.equal(spec.body.spec.triggers.kafka.attributes.accessKey, '[redacted]');
});

test('a configured but missing project node fails closed instead of using default', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, { project: 'missing-project-node' }));
    const fn = helper.getNode('fn');
    assert.equal(fn.configError, true);
    assert.equal(fn.configErrorReason, 'Project config node not found');
    assert.equal(mock.requests.some(request => isDeployWrite(request)), false);
});

test('status summary and details are selectively returned', async () => {
    mock = await startMockNuclio();
    const flow = baseFlow(mock, {
        deploymentVariables: [{ name: 'S3_SECRET_ACCESS_KEY', type: 'cred', value: 'shh-cred', secret: true }],
        configCode: 'spec:\n  env:\n    - name: FUNCTION_SECRET\n      value: ${S3_SECRET_ACCESS_KEY}\n',
    });
    await load(flow, {
        fn: { deploymentVariables: JSON.stringify(flow[1].deploymentVariables) },
    });
    await waitReady(helper.getNode('fn'));

    const statusReadsBeforeSummary = mock.requests.filter(r => r.method === 'GET' && r.url === `/api/functions/${FN}`).length;
    const summary = await helper.request().get('/nuclio/api/functions?id=fn&view=summary').expect(200);
    await helper.request().get('/nuclio/api/functions?id=fn&view=summary').expect(200);
    assert.equal(summary.body.metadata.name, FN);
    assert.equal(summary.body.status.state, 'ready');
    assert.equal(summary.body.status.activeReplicas, 2);
    assert.equal(summary.body.spec.build, undefined);
    assert.equal(summary.body.spec.runtime, 'python:3.12');
    assert.equal(summary.body.invocation.preference, 'internal');
    assert.deepEqual(summary.body.invocation.internalUrls, [`http://127.0.0.1:${mock.port}`]);
    assert.deepEqual(summary.body.invocation.externalUrls, []);
    assert.deepEqual(summary.body.invocation.serviceUrls, [`http://nuclio-${FN}:8080`]);
    assert.equal(
        mock.requests.filter(r => r.method === 'GET' && r.url === `/api/functions/${FN}`).length,
        statusReadsBeforeSummary,
    );

    const spec = await helper.request().get('/nuclio/api/functions?id=fn&view=spec').expect(200);
    assert.equal(spec.body.spec.env[0].value, '[redacted]');

    const logs = await helper.request().get('/nuclio/api/functions?id=fn&view=logs').expect(200);
    assert.deepEqual(logs.body, { logs: [] });
});

test('status summary reports replica-health failures without inventing capacity', async () => {
    mock = await startMockNuclio();
    mock.replicaStatus = 503;
    await load(baseFlow(mock));
    const fn = helper.getNode('fn');
    await waitReady(fn);
    await waitUntil(() => fn.statusSnapshot?.status?.replicaStatusError === 'HTTP 503');

    const summary = await helper.request().get('/nuclio/api/functions?id=fn&view=summary').expect(200);
    assert.equal(summary.body.status.replicaStatusError, 'HTTP 503');
    assert.equal(summary.body.status.activeReplicas, undefined);
});

test('replica status is coalesced, cached, and marked stale after a refresh failure', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    const fn = helper.getNode('fn');
    await waitReady(fn);

    // Use a short test-only cache window so the refresh behavior is observable
    // without making the production cache more eager.
    fn.server.replicaPollMs = 250;
    mock.requests.length = 0;
    await new Promise(resolve => setTimeout(resolve, 300));

    const results = await Promise.all([getReplicaStatus(fn), getReplicaStatus(fn)]);
    const replicaReads = () => mock.requests.filter(
        r => r.method === 'GET' && r.url.endsWith('/replicas'),
    );
    assert.equal(replicaReads().length, 1);
    assert.deepEqual(results[0], { activeReplicas: 2 });
    assert.deepEqual(results[1], results[0]);

    // A failed refresh keeps the last observed count for display but marks it
    // stale. It must not be interpreted as zero replicas.
    mock.replicaStatus = 503;
    await new Promise(resolve => setTimeout(resolve, 300));
    const stale = await getReplicaStatus(fn);
    assert.equal(replicaReads().length, 2);
    assert.deepEqual(stale, {
        activeReplicas: 2,
        replicaStatusError: 'HTTP 503',
        replicaStatusStale: true,
    });
});

test('metrics endpoint returns authenticated Prometheus-compatible metrics', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    await waitUntil(() => mock.requests.some(r => r.method === 'GET' && r.url === `/api/functions/${FN}`));

    const response = await helper.request()
        .get('/nuclio/api/metrics?id=fn')
        .expect(200);
    assert.match(response.headers['content-type'], /text\/plain/);
    assert.match(response.text, /nuclio_dashboard_requests_total/);
    assert.match(response.text, /nuclio_reconcile_steps_total/);
    assert.doesNotMatch(response.text, /127\.0\.0\.1|password|token/i);
});

test('admin errors do not expose dashboard response bodies', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock));
    await waitReady(helper.getNode('fn'));

    mock.failStatus = 500;
    const res = await helper.request().get('/nuclio/api/functions?id=fn&view=full').expect(500);
    assert.deepEqual(res.body, { error: 'Nuclio dashboard returned HTTP 500' });
    assert.equal(JSON.stringify(res.body).includes('simulated 500'), false);
});

test('failed deploy does not wedge the node (redeploying clears, retries continue)', async () => {
    // regression: a 5xx during deploy used to leave `redeploying` stuck forever
    mock = await startMockNuclio();
    mock.failDeploys = true;
    await load(baseFlow(mock));

    await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
    const fn = helper.getNode('fn');
    await waitUntil(() => fn.redeploying === false, { msg: 'redeploying cleared' });

    // the reconcile loop schedules another attempt (5s backoff)
    const attempts = () => mock.requests.filter(r => r.method === 'POST' && r.url === '/api/functions').length;
    await waitUntil(() => attempts() >= 2, { timeout: 8000, msg: 'deploy retry' });

    // and once the server recovers, the function deploys (after the 5s backoff)
    mock.failDeploys = false;
    await waitReady(fn, { timeout: 10000 });
});

test('opt-in unhealthy recovery redeploys after consecutive observations', async () => {
    mock = await startMockNuclio();
    await load(baseFlow(mock, {
        autoRedeployOnUnhealthy: 'true',
        autoRedeployOnUnhealthyType: 'bool',
    }));
    const fn = helper.getNode('fn');
    await waitReady(fn);

    mock.requests.length = 0;
    mock.state = 'unhealthy';
    // config is unchanged, so recovery is a desiredState PATCH
    const patch = await mock.waitFor(r => r.method === 'PATCH', { timeout: 10000 });
    assert.deepEqual(patch.body, { desiredState: 'ready' });
});

test('Nuclio can recover an unhealthy function without a Node-RED redeploy', async () => {
    mock = await startMockNuclio();
    const flow = baseFlow(mock);
    flow[0].pollMs = '25';
    flow[0].readyPollMs = '50';
    await load(flow);
    const fn = helper.getNode('fn');
    await waitReady(fn);

    mock.requests.length = 0;
    mock.setFnState(FN, 'ready', ['unhealthy', 'ready']);

    await waitUntil(() => fn.fnState === 'unhealthy', { timeout: 3000, msg: 'Nuclio unhealthy observation' });
    assert.equal(mock.requests.filter(isDeployWrite).length, 0);

    await waitUntil(() => fn.fnState === 'ready', { timeout: 3000, msg: 'Nuclio recovery to ready' });
    assert.equal(mock.requests.filter(isDeployWrite).length, 0);
});

/* -------------------------------------------------------------------------- */
/*                             Tuning via Config                              */
/* -------------------------------------------------------------------------- */

test('server cadence + function recovery resolve from node config', async () => {
    mock = await startMockNuclio();
    const flow = baseFlow(mock);
    Object.assign(flow[0], {
        pollMs: '250',
        backoffMs: '750',
        requestTimeoutMs: '4000',
        invocationUrlPreference: 'external',
        externalInvocationProtocol: 'http',
    });  // server node
    Object.assign(flow[1], {
        maxSelfHealAttempts: '9',
        redeployDeadlineMs: '30000',
        autoRedeployOnUnhealthy: 'true',
        autoRedeployOnUnhealthyType: 'bool',
        autoRedeployOnError: 'true',
        autoRedeployOnErrorType: 'bool',
    });  // function node
    await load(flow);

    const srv = helper.getNode('srv');
    assert.equal(srv.pollMs, 250);
    assert.equal(srv.backoffMs, 750);
    assert.equal(srv.requestTimeoutMs, 4000);
    assert.equal(srv.invocationUrlPreference, 'external');
    assert.equal(srv.externalInvocationProtocol, 'http');

    const fn = helper.getNode('fn');
    assert.equal(fn.maxSelfHealAttempts, 9);
    assert.equal(fn.redeployDeadlineMs, 30000);
    assert.equal(fn.autoRedeployOnUnhealthy, true);
    assert.equal(fn.autoRedeployOnError, true);
});

test('blank config fields use built-in defaults, not process environment fallbacks', async () => {
    const envFallbacks = {
        NUCLIO_POLL_MS: '1234',
        NUCLIO_INTERNAL_INVOCATION_SERVICE_HOST: 'from-process',
        NUCLIO_INVOCATION_URL_PREFERENCE: 'external',
        NUCLIO_PROJECT_NAME: 'from-process',
        NUCLIO_MAX_SELF_HEAL_ATTEMPTS: '99',
        NUCLIO_REDEPLOY_DEADLINE_MS: '1',
        NUCLIO_AUTO_REDEPLOY_ON_ERROR: 'true',
        NUCLIO_INVOCATION_TIMEOUT_MS: '99',
        NUCLIO_INVOKE_RETRIES: '3',
        NUCLIO_INVOKE_RETRY_DELAY_MS: '1',
    };
    const previous = Object.fromEntries(Object.keys(envFallbacks).map(key => [key, process.env[key]]));
    Object.assign(process.env, envFallbacks);
    try {
        mock = await startMockNuclio();
        const flow = baseFlow(mock);
        for (const field of Object.keys(TEST_SERVER_DEFAULTS)) delete flow[0][field];
        delete flow[0].invocationUrlPreference;
        delete flow[0].internalInvocationServiceHost;
        await load(flow);
        const srv = helper.getNode('srv');
        assert.equal(srv.pollMs, 1000);
        assert.equal(srv.readyPollMs, 5000);
        assert.equal(srv.invocationUrlPreference, 'service');
        assert.equal(srv.internalInvocationServiceHost, 'nuclio-{function}');
        assert.equal(helper.getNode('fn').project.name, 'default');
        assert.equal(helper.getNode('fn').maxSelfHealAttempts, 5);
        assert.equal(helper.getNode('fn').redeployDeadlineMs, 120000);
        assert.equal(helper.getNode('fn').autoRedeployOnUnhealthy, false);
        assert.equal(helper.getNode('fn').autoRedeployOnError, false);
        assert.equal(helper.getNode('inv').timeoutMs, 30000);
        assert.equal(helper.getNode('inv').maxInFlight, 0);
        assert.equal(helper.getNode('inv').retries, 0);
        assert.equal(helper.getNode('inv').retryDelayMs, 500);
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('an env-typed config field reads the named env var at deploy time', async () => {
    process.env.MY_BACKOFF = '4321';
    try {
        mock = await startMockNuclio();
        const flow = baseFlow(mock);
        Object.assign(flow[0], { backoffMs: 'MY_BACKOFF', backoffMsType: 'env' });
        await load(flow);
        assert.equal(helper.getNode('srv').backoffMs, 4321);
    } finally {
        delete process.env.MY_BACKOFF;
    }
});

test('function deployment variables interpolate YAML and preserve secret paths', async () => {
    process.env.NUCLIO_TEST_ARCH_PREFIX = 'arm64v8/';
    try {
        mock = await startMockNuclio();
        const flow = baseFlow(mock, {
            configCode: [
                'apiVersion: "nuclio.io/v1"',
                'kind: NuclioFunction',
                'spec:',
                '  build:',
                '    baseImage: gcr.io/iguazio/${ARCH_PREFIX:-arm64v8/}alpine:3.23',
                '  env:',
                '    - name: FUNCTION_TOKEN',
                '      value: ${FUNCTION_TOKEN}',
            ].join('\n'),
        });
        flow[1].deploymentVariables = [
            { name: 'ARCH_PREFIX', type: 'env', value: 'NUCLIO_TEST_ARCH_PREFIX' },
            { name: 'FUNCTION_TOKEN', type: 'str', value: 'secret-value', secret: true },
        ];
        await load(flow, {
            fn: {
                deploymentVariables: JSON.stringify(flow[1].deploymentVariables),
            },
        });

        const req = await mock.waitFor(r => r.method === 'POST' && r.url === '/api/functions');
        assert.equal(req.body.spec.build.baseImage, 'gcr.io/iguazio/arm64v8/alpine:3.23');
        assert.equal(req.body.spec.env.find(entry => entry.name === 'FUNCTION_TOKEN').value, 'secret-value');
        await waitReady(helper.getNode('fn'));

        const status = await helper.request().get('/nuclio/api/functions?id=fn&view=spec').expect(200);
        assert.equal(status.body.spec.env.find(entry => entry.name === 'FUNCTION_TOKEN').value, '[redacted]');
        assert.ok(helper.getNode('fn').secretVarPaths.includes('spec.env.0.value'));
    } finally {
        delete process.env.NUCLIO_TEST_ARCH_PREFIX;
    }
});

test('disabled deployment policy prevents startup writes and manual deploys', async () => {
    mock = await startMockNuclio();
    const flow = baseFlow(mock);
    Object.assign(flow[0], { deploymentPolicy: 'disabled', deploymentPolicyType: 'str' });
    await load(flow);

    const server = helper.getNode('srv');
    const fn = helper.getNode('fn');
    assert.equal(server.deploymentPolicy, 'disabled');
    assert.equal(server.deploymentEnabled, false);
    assert.equal(fn.lastStatus.text, 'Deployment disabled');
    assert.deepEqual(mock.requests, []);

    const response = await helper.request().post('/nuclio/api/functions/deploy?id=fn').expect(409);
    assert.match(response.body.error, /deployment is disabled/i);
    assert.deepEqual(mock.requests, []);

    const fallback = nextMsg(helper.getNode('out2'));
    helper.getNode('inv').receive({ nuclio: { command: 'deploy' }, payload: 'control' });
    const command = await fallback;
    assert.match(command.error.message, /deployment is disabled/i);
    assert.deepEqual(mock.requests, []);
});

test('deployment policy can be disabled by an explicitly typed environment value', async () => {
    process.env.MY_DEPLOYMENT_POLICY = 'disabled';
    try {
        mock = await startMockNuclio();
        const flow = baseFlow(mock);
        Object.assign(flow[0], { deploymentPolicy: 'MY_DEPLOYMENT_POLICY', deploymentPolicyType: 'env' });
        await load(flow);

        assert.equal(helper.getNode('srv').deploymentPolicy, 'disabled');
        assert.equal(helper.getNode('fn').lastStatus.text, 'Deployment disabled');
        assert.deepEqual(mock.requests, []);
    } finally {
        delete process.env.MY_DEPLOYMENT_POLICY;
    }
});

test('invoke numeric settings can explicitly reference environment variables', async () => {
    Object.assign(process.env, {
        MY_TIMEOUT: '4321',
        MY_MAX_IN_FLIGHT: '7',
        MY_RETRIES: '2',
        MY_RETRY_DELAY: '17',
    });
    try {
        mock = await startMockNuclio();
        await load(baseFlow(mock, {}, {
            timeoutMs: 'MY_TIMEOUT', timeoutMsType: 'env',
            maxInFlight: 'MY_MAX_IN_FLIGHT', maxInFlightType: 'env',
            retries: 'MY_RETRIES', retriesType: 'env',
            retryDelayMs: 'MY_RETRY_DELAY', retryDelayMsType: 'env',
        }));
        const inv = helper.getNode('inv');
        assert.equal(inv.timeoutMs, 4321);
        assert.equal(inv.maxInFlight, 7);
        assert.equal(inv.retries, 2);
        assert.equal(inv.retryDelayMs, 17);
    } finally {
        delete process.env.MY_TIMEOUT;
        delete process.env.MY_MAX_IN_FLIGHT;
        delete process.env.MY_RETRIES;
        delete process.env.MY_RETRY_DELAY;
    }
});

/* -------------------------------------------------------------------------- */
/*                           Guard & Edge Scenarios                           */
/* -------------------------------------------------------------------------- */

test('non-JSON 404 (proxy) backoffs instead of deploying', async () => {
    mock = await startMockNuclio();
    // use a fast poll so the reconcile loop fires quickly after we delete the fn
    const flow = baseFlow(mock);
    flow[0].pollMs = '250'; flow[0].readyPollMs = '500';
    await load(flow);
    await waitReady(helper.getNode('fn'));

    // simulate: the function is deleted externally and the dashboard
    // returns HTML (a reverse proxy is misconfigured). the content-type
    // guard in reconcileStep must prevent a deploy against a likely-wrong server.
    delete mock.functions[FN];
    mock.fn404ContentType = 'text/html';
    mock.requests.length = 0;

    // let a reconcile poll fire; it should back off, not POST a new function
    await new Promise(r => setTimeout(r, 1000));
    assert.ok(!mock.requests.some(r => r.method === 'POST' && r.url === '/api/functions'));
});

test('multiple functions deploy independently on the same server', async () => {
    mock = await startMockNuclio();
    const flow = [
        { id: 'srv', type: 'nuclio-config', address: mock.url, addressType: 'str', publicAddress: '', publicAddressType: 'str', invocationUrlPreference: 'internal' },
        { id: 'fnA', type: 'nuclio-function', server: 'srv', name: 'fn-a', runtime: 'python:3.12', code: 'x = 1', configCode: '', env_vars: [] },
        { id: 'fnB', type: 'nuclio-function', server: 'srv', name: 'fn-b', runtime: 'golang', code: 'y = 1', configCode: '', env_vars: [] },
        { id: 'invA', type: 'nuclio', function: 'fnA', timeoutMs: '', maxInFlight: '', headers: [], wires: [['out1A'], ['out2A']] },
        { id: 'invB', type: 'nuclio', function: 'fnB', timeoutMs: '', maxInFlight: '', headers: [], wires: [['out1B'], ['out2B']] },
        { id: 'out1A', type: 'helper' }, { id: 'out2A', type: 'helper' },
        { id: 'out1B', type: 'helper' }, { id: 'out2B', type: 'helper' },
    ];
    await load(flow);

    const postA = await mock.waitFor(r => r.method === 'POST' && r.body?.metadata?.name === 'fn-a');
    const postB = await mock.waitFor(r => r.method === 'POST' && r.body?.metadata?.name === 'fn-b');
    assert.equal(postA.body.spec.runtime, 'python:3.12');
    assert.equal(postB.body.spec.runtime, 'golang');
    assert.equal(postB.body.spec.handler, 'main:Handler');

    const fnA = helper.getNode('fnA');
    const fnB = helper.getNode('fnB');
    await waitReady(fnA);
    await waitReady(fnB);
    assert.equal(fnA.fnState, 'ready');
    assert.equal(fnB.fnState, 'ready');
    const listReads = mock.requests.filter(r => r.method === 'GET' && r.url === '/api/functions');
    assert.ok(listReads.length >= 1, 'shared project status should use the function list endpoint');
    assert.equal(
        mock.requests.filter(r => r.method === 'GET' && r.url === '/api/functions/fn-a').length,
        1,
        'status polling should not add per-function reads once batching is active',
    );
    assert.equal(
        mock.requests.filter(r => r.method === 'GET' && r.url === '/api/functions/fn-b').length,
        1,
        'status polling should not add per-function reads once batching is active',
    );
    // both functions are on the same server so invocation host:port match;
    // verify they're independent by checking runtime/handler and invocation output

    // invoke each one independently
    const replyA = nextMsg(helper.getNode('out1A'));
    helper.getNode('invA').receive({ payload: { func: 'a' } });
    const msgA = await replyA;
    assert.deepEqual(msgA.payload, { echo: { func: 'a' } });

    const replyB = nextMsg(helper.getNode('out1B'));
    helper.getNode('invB').receive({ payload: { func: 'b' } });
    const msgB = await replyB;
    assert.deepEqual(msgB.payload, { echo: { func: 'b' } });
});

test('status lookups are isolated by project', async () => {
    mock = await startMockNuclio();
    const flow = [
        { id: 'srv', type: 'nuclio-config', address: mock.url, addressType: 'str', publicAddress: '', publicAddressType: 'str', invocationUrlPreference: 'internal' },
        { id: 'projA', type: 'nuclio-project', name: 'project-a', nameType: 'str' },
        { id: 'projB', type: 'nuclio-project', name: 'project-b', nameType: 'str' },
        { id: 'fnA', type: 'nuclio-function', server: 'srv', project: 'projA', name: 'fn-a', runtime: 'python:3.12', code: 'x = 1', configCode: '', env_vars: [] },
        { id: 'fnB', type: 'nuclio-function', server: 'srv', project: 'projB', name: 'fn-b', runtime: 'golang', code: 'y = 1', configCode: '', env_vars: [] },
        { id: 'invA', type: 'nuclio', function: 'fnA', timeoutMs: '', maxInFlight: '', headers: [], wires: [['out1A'], ['out2A']] },
        { id: 'invB', type: 'nuclio', function: 'fnB', timeoutMs: '', maxInFlight: '', headers: [], wires: [['out1B'], ['out2B']] },
        { id: 'out1A', type: 'helper' }, { id: 'out2A', type: 'helper' },
        { id: 'out1B', type: 'helper' }, { id: 'out2B', type: 'helper' },
    ];
    await load(flow);
    await mock.waitFor(r => r.method === 'POST' && r.body?.metadata?.name === 'fn-a');
    await mock.waitFor(r => r.method === 'POST' && r.body?.metadata?.name === 'fn-b');
    await waitReady(helper.getNode('fnA'));
    await waitReady(helper.getNode('fnB'));

    const projectHeaders = new Set(
        mock.requests
            .filter(r => r.method === 'GET' && ['/api/functions/fn-a', '/api/functions/fn-b'].includes(r.url))
            .map(r => r.headers['x-nuclio-project-name'])
    );
    assert.deepEqual(projectHeaders, new Set(['project-a', 'project-b']));
});
