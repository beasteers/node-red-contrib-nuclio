#!/usr/bin/env node

/* Run sequential load phases against one already deployed function. */

const fs = require('node:fs');
const path = require('node:path');
const {
    parseArgs,
    runBenchmark,
} = require('./stress-test');
const { optionValue, toStressArgs } = require('./stress-cli');

const parseCli = argv => {
    if (argv.includes('--help') || argv.includes('-h')) return { help: true };
    const config = optionValue(argv, 'config');
    if (!config) throw new Error('--config is required');
    return {
        config,
        output: optionValue(argv, 'output'),
        quiet: argv.includes('--quiet'),
        failFast: argv.includes('--fail-fast'),
        overrides: Object.fromEntries([
            ['trigger', optionValue(argv, 'trigger')],
            ['url', optionValue(argv, 'url')],
            ['function', optionValue(argv, 'function')],
            ['dashboard', optionValue(argv, 'dashboard')],
            ['namespace', optionValue(argv, 'namespace')],
            ['project', optionValue(argv, 'project')],
            ['endpoint', optionValue(argv, 'endpoint')],
            ['duration', optionValue(argv, 'duration')],
            ['concurrency', optionValue(argv, 'concurrency')],
            ['timeout', optionValue(argv, 'timeout')],
            ['sampleInterval', optionValue(argv, 'sample-interval')],
        ].filter(([, value]) => value !== undefined)),
    };
};

const usage = () => `Usage:
  node scripts/stress-scenario.js --config scripts/stress-scenario.compose.json --output stress-scenario.json

Options:
  --config <path>             JSON scenario definition (required)
  --output <path>             Write the complete JSON result
  --url <url>                 Override the HTTP target
  --function <name>           Override the function used for status samples
  --dashboard <url>           Override the dashboard used for status samples
  --namespace <name>          Override the dashboard namespace
  --project <name>            Override the dashboard project
  --endpoint external|internal Override the endpoint family
  --duration <seconds>        Override every phase duration
  --concurrency <count>       Override every phase client limit
  --timeout <ms>              Override every phase timeout
  --sample-interval <ms>      Override status sampling interval
  --quiet                     Suppress phase progress output
  --fail-fast                 Stop after the first failed phase

Each scenario has shared defaults and sequential phases. A phase can override
rate, duration, requests, concurrency, timeout, warmup, and payloadSize.
`;

const readDefinition = config => {
    const definition = JSON.parse(fs.readFileSync(path.resolve(config), 'utf8'));
    if (!Array.isArray(definition.phases) || definition.phases.length === 0) {
        throw new Error('scenario config must contain a non-empty phases array');
    }
    return definition;
};

const sum = (results, key) => results.reduce((total, result) => total + (result.summary?.[key] || 0), 0);

const runScenario = async ({ config, quiet = false, failFast = false, overrides = {} }, { benchmark = runBenchmark } = {}) => {
    const definition = readDefinition(config);
    const defaults = definition.defaults || definition.options || {};
    const phases = [];
    const startedAt = new Date().toISOString();
    let baseOptions;

    try {
        baseOptions = parseArgs(toStressArgs(defaults));
    } catch (error) {
        throw new Error(`Invalid scenario defaults: ${error.message}`);
    }

    for (const [index, phase] of definition.phases.entries()) {
        if (!phase || typeof phase !== 'object') throw new Error(`scenario phase ${index + 1} must be an object`);
        const name = phase.name || `phase-${index + 1}`;
        const phaseValues = { ...baseOptions, ...phase, ...overrides };
        delete phaseValues.name;
        if (phase.warmup === undefined) phaseValues.warmup = index === 0 ? baseOptions.warmup : 0;
        const options = parseArgs(toStressArgs(phaseValues));
        let result;
        try {
            result = await benchmark(options);
            result.samples = (result.samples || []).map(sample => ({ ...sample, phase: name }));
            phases.push({ name, target: result.target, options: result.options, summary: result.summary, errors: result.errors, samples: result.samples });
            if (!quiet) {
                console.log(`${name}: ${result.summary.completed}/${result.summary.offered} completed, p95 ${result.summary.latencyMs.p95 ?? 'n/a'} ms`);
            }
        } catch (error) {
            phases.push({ name, options, error: error.message });
            if (!quiet) console.error(`${name}: ${error.message}`);
            if (failFast) break;
        }
    }

    const successful = phases.filter(phase => phase.summary);
    const durationMs = sum(successful, 'durationMs');
    const wallDurationMs = sum(successful, 'wallDurationMs');
    const completed = sum(successful, 'completed');
    const aggregate = {
        phases: phases.length,
        successfulPhases: successful.length,
        failedPhases: phases.length - successful.length,
        offered: sum(successful, 'offered'),
        attempted: sum(successful, 'attempted'),
        completed,
        errors: sum(successful, 'errors'),
        rejectedByClient: sum(successful, 'rejectedByClient'),
        timeouts: sum(successful, 'timeouts'),
        unmatchedResponses: sum(successful, 'unmatchedResponses'),
        durationMs,
        wallDurationMs,
        completedPerSecond: durationMs ? completed / (durationMs / 1000) : 0,
    };

    return {
        scenario: definition.name || path.basename(config),
        startedAt,
        trigger: baseOptions.trigger,
        target: phases.find(phase => phase.target)?.target,
        summary: aggregate,
        phases,
    };
};

const printResult = result => {
    console.log(JSON.stringify({
        scenario: result.scenario,
        summary: result.summary,
        phases: result.phases.map(phase => ({
            name: phase.name,
            rate: phase.options?.rate,
            duration: phase.options?.duration,
            completed: phase.summary?.completed || 0,
            offered: phase.summary?.offered || 0,
            errors: phase.summary?.errors || 0,
            p95: phase.summary?.latencyMs?.p95 ?? null,
            error: phase.error,
        })),
    }, null, 2));
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
        const result = await runScenario(cli);
        if (cli.output) fs.writeFileSync(cli.output, `${JSON.stringify(result, null, 2)}\n`);
        if (!cli.quiet) printResult(result);
        if (result.summary.failedPhases || result.summary.errors || result.summary.timeouts) process.exitCode = 1;
    } catch (error) {
        console.error(`Stress scenario failed: ${error.stack || error.message}`);
        process.exitCode = 1;
    }
};

if (require.main === module && !process.execArgv.includes('--test')) main();

module.exports = { parseCli, readDefinition, runScenario, toStressArgs };
