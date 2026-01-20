#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const inputPath = args.find(a => !a.startsWith('-')) || 'data/flows.json';
const inPlace = args.includes('--in-place');
const outputPath = inPlace ? inputPath : (args.find(a => a.startsWith('--out='))?.slice(6) || inputPath.replace(/\.json$/i, '.migrated.json'));

const genId = () => {
    const bytes = [];
    for (let i = 0; i < 8; i++) bytes.push(Math.floor(Math.random() * 256));
    return Buffer.from(bytes).toString('hex');
};

const readJson = (filePath) => {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
};

const writeJson = (filePath, data) => {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
};

const input = readJson(inputPath);
if (!Array.isArray(input)) {
    console.error(`Expected an array in ${inputPath}`);
    process.exit(1);
}

const configNodes = [];
const migrated = input.map(node => {
    if (!node || node.type !== 'nuclio') return node;

    const configId = genId();
    configNodes.push({
        id: configId,
        type: 'nuclio-function',
        name: node.name || '',
        runtime: node.runtime || 'python:3.12',
        code: node.code || '',
        configCode: node.configCode || '',
        env_vars: node.env_vars || [],
        secret_vars: node.secret_vars || [],
        server: node.server,
        project: node.project,
    });

    const updated = { ...node };
    updated.function = configId;
    delete updated.name;
    delete updated.runtime;
    delete updated.code;
    delete updated.configCode;
    delete updated.env_vars;
    delete updated.secret_vars;
    delete updated.server;
    delete updated.project;
    return updated;
});

const output = migrated.concat(configNodes);
writeJson(outputPath, output);

console.log(`Migrated ${configNodes.length} nuclio nodes -> config nodes.`);
console.log(`Wrote ${path.resolve(outputPath)}`);
