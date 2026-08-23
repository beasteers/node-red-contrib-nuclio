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
    assert.match(serverHtml, /types:\s*\[["']str["'],\s*["']env["'],\s*["']cred["']\]/,
        'dashboard credentials must support literal, environment, and credential values');
    assert.doesNotMatch(html, /secret_vars|Credential Overrides/,
        'deprecated credential override fields must not remain in the editor');
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

    assert.ok(tab, 'expected the NATS demo tab');
    assert.ok(fn, 'expected the NATS-triggered Nuclio function');
    assert.match(fn.configCode, /kind:\s*nats/);
    assert.match(fn.configCode, /url:\s*nats:\/\/nats:4222/);
    assert.match(fn.configCode, /topic:\s*demo\.nats\.input/);
    assert.match(fn.configCode, /reply:\s*true/);
});
