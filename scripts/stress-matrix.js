#!/usr/bin/env node

/* Run a sequential matrix of stress-test cases and offered rates. */

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, runBenchmark } = require('./stress-test');
const { optionValue, toStressArgs } = require('./stress-cli');

const parseCli = argv => {
    if (argv.includes('--help') || argv.includes('-h')) return { help: true };
    const config = optionValue(argv, 'config');
    if (!config) throw new Error('--config is required');
    const rates = optionValue(argv, 'rates');
    return {
        config,
        rates: rates ? rates.split(',').map(value => Number(value)) : undefined,
        output: optionValue(argv, 'output'),
        overrides: Object.fromEntries([
            ['duration', optionValue(argv, 'duration')],
            ['concurrency', optionValue(argv, 'concurrency')],
            ['timeout', optionValue(argv, 'timeout')],
            ['warmup', optionValue(argv, 'warmup')],
            ['endpoint', optionValue(argv, 'endpoint')],
        ].filter(([, value]) => value !== undefined)),
        failFast: argv.includes('--fail-fast'),
    };
};

const usage = () => `Usage:
  node scripts/stress-matrix.js --config scripts/stress-matrix.example.json \\
    --rates 10,100,500 --output stress-matrix.json

Options:
  --config <path>             JSON matrix definition (required)
  --rates <a,b,c>             Override the config's offered rates
  --duration <seconds>        Override every case's duration
  --concurrency <count>       Override every case's client limit
  --timeout <ms>              Override every case's timeout
  --warmup <count>            Override every case's warmup count
  --endpoint external|internal Override HTTP endpoint family
  --output <path>             Write the complete JSON result
  --fail-fast                 Stop after the first failed case
`;

const runMatrix = async ({ config, rates, overrides, failFast }, { benchmark = runBenchmark } = {}) => {
    const matrixPath = path.resolve(config);
    const definition = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
    if (!Array.isArray(definition.cases) || definition.cases.length === 0) throw new Error('matrix config must contain a non-empty cases array');
    const selectedRates = rates || definition.rates || [10];
    if (!selectedRates.every(value => Number.isFinite(value) && value >= 0)) throw new Error('matrix rates must be non-negative numbers');
    const results = [];
    for (const entry of definition.cases) {
        const caseDefaults = { ...(definition.defaults || {}), ...(entry.options || entry) };
        delete caseDefaults.name;
        for (const rate of selectedRates) {
            const args = toStressArgs({ ...caseDefaults, ...overrides }, rate);
            const options = parseArgs(args);
            const started = new Date().toISOString();
            try {
                const result = await benchmark(options);
                results.push({ name: entry.name || `${options.trigger}-${options.function || options.subject || options.inputTopic}`, rate, started, result });
            } catch (error) {
                results.push({ name: entry.name || options.trigger, rate, started, error: error.message });
                if (failFast) return results;
            }
        }
    }
    return results;
};

const main = async () => {
    let cli;
    try { cli = parseCli(process.argv.slice(2)); } catch (error) {
        console.error(`Error: ${error.message}\n\n${usage()}`);
        process.exitCode = 2;
        return;
    }
    if (cli.help) { console.log(usage()); return; }
    try {
        const results = await runMatrix(cli);
        if (cli.output) fs.writeFileSync(cli.output, `${JSON.stringify({ results }, null, 2)}\n`);
        console.log(JSON.stringify(results.map(entry => ({
            name: entry.name,
            rate: entry.rate,
            completed: entry.result?.summary?.completed || 0,
            errors: entry.result?.summary?.errors || 0,
            p95: entry.result?.summary?.latencyMs?.p95 ?? null,
            error: entry.error,
        })), null, 2));
        if (results.some(entry => entry.error || entry.result?.summary?.errors)) process.exitCode = 1;
    } catch (error) {
        console.error(`Stress matrix failed: ${error.stack || error.message}`);
        process.exitCode = 1;
    }
};

if (require.main === module) main();

module.exports = { parseCli, runMatrix, toStressArgs };
