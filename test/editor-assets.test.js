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
});
