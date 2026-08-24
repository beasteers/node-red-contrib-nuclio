const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('function editor inline scripts remain syntactically valid JavaScript', () => {
    const file = path.join(__dirname, '..', 'lib', 'nodes', 'nuclio-function.html');
    const html = fs.readFileSync(file, 'utf8');
    const scripts = [...html.matchAll(/<script\s+type=["']text\/javascript["'][^>]*>([\s\S]*?)<\/script>/gi)]
        .map(match => match[1])
        .filter(script => script.trim());

    assert.ok(scripts.length > 0, 'expected at least one inline editor script');
    for (const [index, script] of scripts.entries()) {
        assert.doesNotThrow(() => new Function(script), `inline editor script ${index + 1}`);
    }
    const serverHtml = fs.readFileSync(path.join(__dirname, '..', 'lib', 'nodes', 'nuclio-config.html'), 'utf8');
    assert.match(html, /deploymentVariables:\s*\{\s*type:\s*["']text["']/,
        'deployment variables must be declared in the editor credential definition');
    assert.match(serverHtml, /authPasswordType:\s*\{\s*value:\s*["']cred["']\s*\}/,
        'dashboard passwords must expose a typed-input mode');
    assert.match(serverHtml, /authTokenType:\s*\{\s*value:\s*["']cred["']\s*\}/,
        'dashboard tokens must expose a typed-input mode');
    assert.match(serverHtml, /authPasswordValue:\s*\{\s*value:\s*["']{2}\s*\}/,
        'dashboard literal password values must use an ordinary value property');
    assert.match(serverHtml, /authTokenValue:\s*\{\s*value:\s*["']{2}\s*\}/,
        'dashboard literal token values must use an ordinary value property');
    assert.match(serverHtml, /types:\s*\[["']str["'],\s*["']env["'],\s*["']cred["']\]/,
        'dashboard credentials must support literal, environment, and credential values');
    assert.match(serverHtml, /this\[\x60\$\{field\}Type\x60\]\s*=\s*type/,
        'dashboard auth typed-input modes must be persisted explicitly');
    assert.match(serverHtml, /value !== ["']__PWRD__["']/,
        'dashboard auth save handling must preserve Node-RED password sentinels');
    assert.match(serverHtml, /typedInput\('value',\s*nuclioServerAuthValue\(this, 'authPassword'\)\)/,
        'dashboard password values must be restored through typedInput');
    assert.match(serverHtml, /delete this\[field\]/,
        'dashboard auth save handling must remove legacy ordinary auth properties');
    assert.doesNotMatch(html, /secret_vars|Credential Overrides/,
        'deprecated credential override fields must not remain in the editor');
});

test('function editor restores stored typed-input types on open', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'nodes', 'nuclio-function.html'), 'utf8');
    assert.match(html, /const typeFieldSelector = '#node-config-input-' \+ field \+ 'Type'/,
        'function typed inputs must use their companion type fields');
    for (const field of [
        'executionBatchSize', 'executionBatchTimeout', 'executionWorkers', 'executionEventTimeout',
        'scalingReplicas', 'scalingMinReplicas', 'scalingMaxReplicas', 'scalingTargetCPU',
        'resourceRequestsCpu', 'resourceRequestsMemory', 'resourceLimitsCpu', 'resourceLimitsMemory',
    ]) {
        assert.match(html, new RegExp(`id=["']node-config-input-${field}Type["']`),
            `${field} must have a persisted type field`);
    }
});

test('function editor validates scaling values through field validators', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'nodes', 'nuclio-function.html'), 'utf8');
    assert.doesNotMatch(html, /scalingError/,
        'save-time scaling validation that Node-RED ignores must be removed');
    assert.match(html, /scalingReplicas:\s*\{\s*value:\s*['"]['"],\s*validate:\s*validateScalingField\(['"]scalingReplicas['"]\)/,
        'scalingReplicas must declare a field validator');
    assert.match(html, /scalingMinReplicas:\s*\{\s*value:\s*['"]['"],\s*validate:\s*validateScalingField\(['"]scalingMinReplicas['"]\)/,
        'scalingMinReplicas must declare a field validator');
    assert.match(html, /scalingMaxReplicas:\s*\{\s*value:\s*['"]['"],\s*validate:\s*validateScalingField\(['"]scalingMaxReplicas['"]\)/,
        'scalingMaxReplicas must declare a field validator');
    assert.match(html, /scalingTargetCPU:\s*\{\s*value:\s*['"]['"],\s*validate:\s*validateScalingField\(['"]scalingTargetCPU['"]\)/,
        'scalingTargetCPU must declare a field validator');
    assert.match(html, /const scalingFieldError = \(node, field, value\) =>/,
        'a shared scaling validator must exist');
});

test('function editor handles stored credentials without leaking the sentinel', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'nodes', 'nuclio-function.html'), 'utf8');
    assert.match(html, /codeEntryPassword === ['"]__PWRD__['"] \?/,
        'the editor must not display the __PWRD__ sentinel in the password field');
    assert.match(html, /node\.credentials\.codeEntryPassword !== ['"]__PWRD__['"]\) delete node\.credentials\.codeEntryPassword/,
        'clearing the password field must preserve an existing stored credential');
});

test('function editor only links to validated dashboard addresses', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'nodes', 'nuclio-function.html'), 'utf8');
    assert.match(html, /\/\^https\?:/,
        'the dashboard link must only allow http(s) addresses');
    assert.match(html, /\.test\(base\)/,
        'the scheme guard must be applied before linking');
    assert.match(html, /encodeURIComponent\(project\)/,
        'the dashboard link must encode the project segment');
    assert.match(html, /encodeURIComponent\(name\)/,
        'the dashboard link must encode the function name segment');
});

test('nuclio-config editor uses typeField for top-level typed fields', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'nodes', 'nuclio-config.html'), 'utf8');
    assert.match(html, /typeField: typeFieldSelector/,
        'top-level typed inputs must delegate type persistence to Node-RED');
    for (const field of [
        'address', 'publicAddress', 'namespace', 'internalInvocationServiceHost',
        'deploymentPolicy', 'authUsername', 'authPassword', 'authToken',
        'requestTimeoutMs', 'deployTimeoutMs', 'pollMs', 'readyPollMs',
        'backoffMs', 'backoffMaxMs', 'startStaggerMs',
    ]) {
        assert.match(html, new RegExp(`id=["']node-config-input-${field}Type["']`),
            `${field} must have a persisted type field`);
    }
    assert.doesNotMatch(html, /this\[field \+ ['"]Type['"]\] = input\.typedInput\(['"]type['"]\)/,
        'ordinary typed-input types should not be copied manually in oneditsave');
});

test('nuclio invoke editor uses typeField for top-level typed settings', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'nodes', 'nuclio.html'), 'utf8');
    assert.match(html, /typeField: typeFieldSelector/,
        'invoke settings must delegate type persistence to Node-RED');
    for (const field of ['timeoutMs', 'maxInFlight', 'retries', 'retryDelayMs']) {
        assert.match(html, new RegExp(`id=["']node-input-${field}Type["']`),
            `${field} must have a persisted type field`);
    }
    assert.doesNotMatch(html, /this\[field \+ ['"]Type['"]\] = input\.typedInput\(['"]type['"]\)/,
        'ordinary typed-input types should not be copied manually in oneditsave');
});

test('dynamic credential lists declare credential storage and sanitize flow values', () => {
    const invokeHtml = fs.readFileSync(path.join(__dirname, '..', 'lib', 'nodes', 'nuclio.html'), 'utf8');
    const functionHtml = fs.readFileSync(path.join(__dirname, '..', 'lib', 'nodes', 'nuclio-function.html'), 'utf8');
    assert.match(invokeHtml, /headerCredentials:\s*\{\s*type:\s*['"]text['"]\s*\}/,
        'invoke headers must have a Node-RED credential field');
    assert.match(functionHtml, /environmentVariables:\s*\{\s*type:\s*['"]text['"]\s*\}/,
        'function environment variables must have a Node-RED credential field');
    assert.match(invokeHtml, /nuclio-credential-list\.js/,
        'invoke editor must load the credential list helper');
    assert.match(functionHtml, /nuclio-credential-list\.js/,
        'function editor must load the credential list helper');
    assert.match(invokeHtml, /NUCLIO_CREDENTIAL_LIST\.saveEntries/,
        'invoke editor must sanitize credential values before saving flow metadata');
    assert.match(functionHtml, /NUCLIO_CREDENTIAL_LIST\.saveEntries/,
        'function editor must sanitize credential values before saving flow metadata');
});

test('nuclio-project editor uses a typeField-backed config-node input', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'nodes', 'nuclio-project.html'), 'utf8');
    assert.match(html, /node-config-input-name/,
        'the project name field must use the config-node input id');
    assert.doesNotMatch(html, /node-project-input-name/,
        'the old non-config input id must be gone');
    assert.match(html, /typeField: '#node-config-input-nameType'/,
        'the project name type must be persisted by typedInput');
    assert.match(html, /id=["']node-config-input-nameType["']/,
        'the project name must have a persisted type field');
    assert.doesNotMatch(html, /oneditsave:/,
        'the project editor should not need manual type persistence');
});

test('function editor dirty tracking binds to the config-node dialog form', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'nodes', 'nuclio-function.html'), 'utf8');
    assert.match(html, /\$\(['"]#node-config-dialog-edit-form['"]\)/,
        'dirty tracking must bind to the config-node dialog form');
    assert.doesNotMatch(html, /#dialog-form/,
        'the regular node dialog form selector must not be used');
    assert.match(html, /#node-config-input-env_secret_refs-x button/,
        'secret reference list edits must mark the editor dirty');
});

test('function editor uses typeField for recovery-policy types', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'nodes', 'nuclio-function.html'), 'utf8');
    assert.match(html, /typeField: typeFieldSelector/,
        'function typed inputs must delegate type persistence to Node-RED');
    for (const field of ['maxSelfHealAttempts', 'redeployDeadlineMs', 'autoRedeployOnError']) {
        assert.match(html, new RegExp(`id=["']node-config-input-${field}Type["']`),
            `${field} must have a persisted type field`);
    }
    assert.doesNotMatch(html, /this\.autoRedeployOnErrorType = .*typedInput\(['"]type['"]\)/,
        'recovery policy types should not be copied manually in oneditsave');
});

test('function editor marks an auto-generated name as dirty', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'nodes', 'nuclio-function.html'), 'utf8');
    assert.match(html, /node\.name = generateUniqueName\(\)/,
        'auto-naming must happen in oneditprepare, not in the validator');
    assert.doesNotMatch(html, /this\.name = v/,
        'the name validator must not mutate node state');
    assert.match(html, /node\.nuclioEditorDirty = true/,
        'an auto-generated name must mark the editor dirty');
});

test('function editor resets async mode when switching to a non-Python runtime', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'nodes', 'nuclio-function.html'), 'utf8');
    assert.match(html, /executionMode\.val\(\) === ['"]async['"]/,
        'the runtime change handler must detect a stale async selection');
    assert.match(html, /executionMode\.val\(['"]inherit['"]\)/,
        'the runtime change handler must reset async to inherit');
});

test('function editor leaves no stale cleanup or debug logging', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'nodes', 'nuclio-function.html'), 'utf8');
    assert.doesNotMatch(html, /delete this\.secretList|resolvedSecretVars|redactSecrets/,
        'dead cleanup and redaction helpers must not remain');
    assert.doesNotMatch(html, /console\.log\("Changing runtime/,
        'runtime change debug logging must not remain');
});

test('demo flow includes a direct MQTT trigger path', () => {
    const flows = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'flows.json'), 'utf8'));
    const tab = flows.find(node => node.type === 'tab' && node.label === '05 Direct MQTT trigger');
    const broker = flows.find(node => node.type === 'mqtt-broker' && node.broker === 'mosquitto');
    const fn = flows.find(node => node.type === 'nuclio-function' && node.name === 'demo-mqtt-transform');
    const input = flows.find(node => node.type === 'mqtt out' && node.topic === 'demo/mqtt/input');
    const output = flows.find(node => node.type === 'mqtt in' && node.topic === 'demo/mqtt/output');

    assert.ok(tab, 'expected the direct MQTT demo tab');
    assert.ok(broker, 'expected the Mosquitto broker configuration');
    assert.ok(fn, 'expected the MQTT-triggered Nuclio function');
    assert.match(fn.configCode, /kind:\s*mqtt/);
    assert.match(fn.configCode, /url:\s*mosquitto:1883/);
    assert.ok(input, 'expected the MQTT input publisher');
    assert.ok(output, 'expected the MQTT output subscriber');
});

test('demo flow includes a Nuclio-owned Cron trigger', () => {
    const flows = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'flows.json'), 'utf8'));
    const tab = flows.find(node => node.type === 'tab' && node.label === '06 Cron trigger');
    const fn = flows.find(node => node.type === 'nuclio-function' && node.name === 'demo-cron-timestamp');

    assert.ok(tab, 'expected the Cron demo tab');
    assert.ok(fn, 'expected the Cron-triggered Nuclio function');
    assert.match(fn.configCode, /kind:\s*cron/);
    assert.match(fn.configCode, /interval:\s*30s/);
    assert.match(fn.configCode, /body:/);
});

test('demo flow includes a direct NATS request/reply trigger', () => {
    const flows = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'flows.json'), 'utf8'));
    const tab = flows.find(node => node.type === 'tab' && node.label === '07 Direct NATS trigger');
    const fn = flows.find(node => node.type === 'nuclio-function' && node.name === 'demo-nats-request');
    const bridgeFn = flows.find(node => node.type === 'nuclio-function' && node.name === 'demo-nats-mqtt-transform');
    const broker = flows.find(node => node.type === 'mqtt-broker' && node.name === 'NATS MQTT');
    const input = flows.find(node => node.type === 'mqtt out' && node.topic === 'demo/nats/mqtt/input');
    const output = flows.find(node => node.type === 'mqtt in' && node.topic === 'demo/nats/mqtt/output');

    assert.ok(tab, 'expected the NATS demo tab');
    assert.ok(fn, 'expected the NATS-triggered Nuclio function');
    assert.match(fn.configCode, /kind:\s*nats/);
    assert.match(fn.configCode, /url:\s*nats:\/\/nats:4222/);
    assert.match(fn.configCode, /topic:\s*demo\.nats\.input/);
    assert.match(fn.configCode, /reply:\s*true/);
    assert.ok(bridgeFn, 'expected the NATS MQTT bridge function');
    assert.match(bridgeFn.configCode, /kind:\s*nats/);
    assert.match(bridgeFn.configCode, /topic:\s*demo\.nats\.mqtt\.input/);
    assert.match(bridgeFn.configCode, /reply:\s*false/);
    assert.match(bridgeFn.code, /nats\.aio\.client/);
    assert.match(bridgeFn.configCode, /pip install nats-py/);
    assert.ok(broker, 'expected the NATS MQTT broker configuration');
    assert.ok(input, 'expected the NATS MQTT input publisher');
    assert.equal(input.broker, broker.id);
    assert.ok(output, 'expected the NATS MQTT output subscriber');
    assert.equal(output.broker, broker.id);
});
