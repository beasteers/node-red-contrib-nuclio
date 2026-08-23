#!/usr/bin/env node

/*
 * Run a controlled load test against an already deployed Nuclio function.
 *
 * This intentionally does not deploy or mutate functions. That keeps the
 * measured path focused on invocation and makes it safe to run against a
 * function managed by Node-RED, nuctl, or Kubernetes. Use --function with
 * --dashboard to resolve a Nuclio-reported invocation URL, or pass --url
 * directly when the function endpoint is exposed through a port-forward.
 */

const fs = require('node:fs');
const { performance } = require('node:perf_hooks');

const DEFAULTS = Object.freeze({
    broker: 'mqtt://127.0.0.1:1883',
    dashboard: 'http://127.0.0.1:8072',
    endpoint: 'external',
    concurrency: 100,
    duration: 10,
    namespace: 'nuclio',
    inputTopic: 'demo/mqtt/input',
    outputTopic: 'demo/mqtt/output',
    rate: 10,
    sampleInterval: 1000,
    server: 'nats://127.0.0.1:4222',
    timeout: 10000,
    warmup: 1,
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const parseNumber = (value, name, { integer = false, min = 0 } = {}) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min || (integer && !Number.isInteger(parsed))) {
        throw new Error(`--${name} must be a ${integer ? 'non-negative integer' : 'non-negative number'}`);
    }
    return parsed;
};

const parseArgs = argv => {
    const options = { ...DEFAULTS, trigger: 'http' };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--help' || argument === '-h') options.help = true;
        else if (argument === '--quiet') options.quiet = true;
        else if (argument.startsWith('--')) {
            const [rawName, inlineValue] = argument.slice(2).split('=', 2);
            const name = rawName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
            const value = inlineValue === undefined ? argv[++index] : inlineValue;
            if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${rawName}`);
            options[name] = value;
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }

    if (options.help) return options;
    if (!['http', 'mqtt', 'nats'].includes(options.trigger)) {
        throw new Error('--trigger must be http, mqtt, or nats');
    }
    if (!['external', 'internal'].includes(options.endpoint)) {
        throw new Error('--endpoint must be external or internal');
    }
    options.concurrency = parseNumber(options.concurrency, 'concurrency', { integer: true, min: 1 });
    options.duration = parseNumber(options.duration, 'duration', { min: 0 });
    options.rate = parseNumber(options.rate, 'rate', { min: 0 });
    options.sampleInterval = parseNumber(options.sampleInterval, 'sample-interval', { integer: true, min: 100 });
    options.timeout = parseNumber(options.timeout, 'timeout', { integer: true, min: 1 });
    options.warmup = parseNumber(options.warmup, 'warmup', { integer: true, min: 0 });
    options.payloadSize = parseNumber(options.payloadSize || 0, 'payload-size', { integer: true, min: 0 });
    if (options.requests !== undefined) options.requests = parseNumber(options.requests, 'requests', { integer: true, min: 1 });
    if (options.trigger === 'http' && !options.url && !options.function) throw new Error('HTTP tests require --url or --function');
    if (options.trigger === 'nats' && !options.subject) options.subject = 'demo.nats.input';
    return options;
};

const usage = () => `Usage:
  node scripts/stress-test.js --trigger http --url http://function:8080 \\
    --rate 100 --duration 30 --concurrency 64

Triggers:
  http   --url or --function + --dashboard
  mqtt   --broker --input-topic --output-topic
  nats   --server --subject

Common options:
  --rate <messages/sec>       Offered load (default: 10)
  --duration <seconds>        Measurement duration (default: 10)
  --requests <count>          Override rate × duration
  --concurrency <count>       Client-side in-flight limit (default: 100)
  --timeout <ms>              Per-message timeout (default: 10000)
  --warmup <count>            Unrecorded warmup messages (default: 1)
  --payload-size <bytes>      Add deterministic padding to each payload
  --dashboard <url>           Dashboard URL for function/status lookup
  --function <name>           Function name for URL/status lookup
  --endpoint external|internal Invocation URL family to resolve (default: external)
  --project <name>            Dashboard project header
  --output <path>             Write the complete JSON result
  --quiet                     Suppress progress output
`;

const requestJson = async (url, options = {}) => {
    const response = await fetch(url, {
        ...options,
        headers: { Accept: 'application/json', ...(options.headers || {}) },
        signal: AbortSignal.timeout(options.timeout || 10000),
    });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200)}`);
    return body;
};

const normalizeEndpoint = value => /^https?:\/\//i.test(value) ? value : `http://${value}`;

const resolveHttpTarget = async options => {
    if (options.url) return options.url;
    const dashboard = String(options.dashboard).replace(/\/$/, '');
    const functionName = encodeURIComponent(options.function);
    const body = await requestJson(`${dashboard}/api/functions/${functionName}`, {
        headers: {
            'x-nuclio-function-namespace': options.namespace,
            'x-nuclio-project-name': options.project || 'default',
        },
    });
    const urls = options.endpoint === 'internal'
        ? (body?.status?.internalInvocationUrls || [])
        : (body?.status?.externalInvocationUrls || []);
    if (!urls.length) throw new Error(`Function ${options.function} has no reported invocation URL`);
    return normalizeEndpoint(urls[0]);
};

const parseResponseBody = text => {
    try { return text ? JSON.parse(text) : null; } catch { return text; }
};

const correlationId = body => {
    if (!body || typeof body !== 'object') return undefined;
    if (body.id !== undefined) return body.id;
    if (body.correlationId !== undefined) return body.correlationId;
    if (body.received && typeof body.received === 'object') return correlationId(body.received);
    if (body.payload && typeof body.payload === 'object') return correlationId(body.payload);
    return undefined;
};

const createPayload = (runId, index, payloadSize) => ({
    id: `${runId}-${index}`,
    sentAt: new Date().toISOString(),
    data: payloadSize ? 'x'.repeat(payloadSize) : undefined,
});

const createHttpTransport = async options => {
    const url = await resolveHttpTarget(options);
    return {
        description: `HTTP ${url}`,
        send: async payload => {
            const started = performance.now();
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(options.timeout),
            });
            const body = parseResponseBody(await response.text());
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return { body, latencyMs: performance.now() - started };
        },
        close: async () => {},
    };
};

const createNatsTransport = async options => {
    const { connect } = require('@nats-io/transport-node');
    const connection = await connect({ servers: options.server });
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    return {
        description: `NATS ${options.server} ${options.subject}`,
        send: async payload => {
            const started = performance.now();
            const response = await connection.request(options.subject, encoder.encode(JSON.stringify(payload)), { timeout: options.timeout });
            return { body: parseResponseBody(decoder.decode(response.data)), latencyMs: performance.now() - started };
        },
        close: async () => connection.drain(),
    };
};

const createMqttTransport = async options => {
    const mqtt = require('mqtt');
    const client = mqtt.connect(options.broker);
    const pending = new Map();
    let unmatched = 0;
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`MQTT connection timed out: ${options.broker}`)), options.timeout);
        client.once('connect', () => { clearTimeout(timer); resolve(); });
        client.once('error', error => { clearTimeout(timer); reject(error); });
    });
    await new Promise((resolve, reject) => client.subscribe(options.outputTopic, error => error ? reject(error) : resolve()));
    client.on('message', (topic, message) => {
        if (topic !== options.outputTopic) return;
        const body = parseResponseBody(message.toString());
        const id = correlationId(body);
        const request = pending.get(id);
        if (!request) { unmatched += 1; return; }
        pending.delete(id);
        clearTimeout(request.timer);
        request.resolve({ body, latencyMs: performance.now() - request.started });
    });
    client.on('error', error => {
        for (const request of pending.values()) request.reject(error);
        pending.clear();
    });
    return {
        description: `MQTT ${options.broker} ${options.inputTopic} → ${options.outputTopic}`,
        unmatched: () => unmatched,
        send: payload => new Promise((resolve, reject) => {
            const started = performance.now();
            const timer = setTimeout(() => {
                pending.delete(payload.id);
                reject(new Error('MQTT response timeout'));
            }, options.timeout);
            pending.set(payload.id, { started, timer, resolve, reject });
            client.publish(options.inputTopic, JSON.stringify(payload), { qos: 0 }, error => {
                if (error) {
                    pending.delete(payload.id);
                    clearTimeout(timer);
                    reject(error);
                }
            });
        }),
        close: async () => new Promise(resolve => client.end(false, {}, resolve)),
    };
};

const createTransport = options => options.trigger === 'http'
    ? createHttpTransport(options)
    : options.trigger === 'mqtt' ? createMqttTransport(options) : createNatsTransport(options);

const percentile = (values, fraction) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
};

const summarize = (metrics, durationMs) => ({
    offered: metrics.attempted + metrics.rejectedByClient,
    attempted: metrics.attempted,
    completed: metrics.completed,
    errors: metrics.errors,
    rejectedByClient: metrics.rejectedByClient,
    timeouts: metrics.timeouts,
    unmatchedResponses: metrics.unmatchedResponses,
    durationMs,
    wallDurationMs: metrics.wallDurationMs,
    completedPerSecond: durationMs ? metrics.completed / (durationMs / 1000) : 0,
    latencyMs: {
        p50: percentile(metrics.latencies, 0.5),
        p95: percentile(metrics.latencies, 0.95),
        p99: percentile(metrics.latencies, 0.99),
        max: metrics.latencies.length ? Math.max(...metrics.latencies) : null,
    },
});

const sampleFunctionStatus = async (options, samples) => {
    if (!options.function || !options.dashboard) return;
    const dashboard = String(options.dashboard).replace(/\/$/, '');
    try {
        const body = await requestJson(`${dashboard}/api/functions/${encodeURIComponent(options.function)}`, {
            headers: {
                'x-nuclio-function-namespace': options.namespace,
                'x-nuclio-project-name': options.project || 'default',
            },
            timeout: options.timeout,
        });
        samples.push({
            at: new Date().toISOString(),
            state: body?.status?.state || null,
            replicas: body?.status?.replicas ?? null,
            minReplicas: body?.spec?.minReplicas ?? null,
            maxReplicas: body?.spec?.maxReplicas ?? null,
        });
    } catch (error) {
        samples.push({ at: new Date().toISOString(), error: error.message });
    }
};

const runBenchmark = async (options, { transportFactory = createTransport } = {}) => {
    const transport = await transportFactory(options);
    const runId = `stress-${Date.now().toString(36)}`;
    const metrics = {
        attempted: 0,
        completed: 0,
        errors: 0,
        rejectedByClient: 0,
        timeouts: 0,
        unmatchedResponses: 0,
        latencies: [],
        errorMessages: {},
    };
    const samples = [];
    const pending = new Set();
    const warmupPayload = index => createPayload(`${runId}-warmup`, index, options.payloadSize);

    for (let index = 0; index < options.warmup; index += 1) {
        try { await transport.send(warmupPayload(index)); } catch { /* warmup failures are not measurement results */ }
    }

    let sampling = true;
    const sample = async () => {
        if (!sampling) return;
        await sampleFunctionStatus(options, samples);
        if (sampling) setTimeout(sample, options.sampleInterval);
    };
    void sample();

    const start = performance.now();
    const durationMs = options.duration * 1000;
    const total = options.requests || Math.max(1, Math.ceil(options.rate * options.duration));
    const intervalMs = options.rate ? 1000 / options.rate : 0;
    for (let index = 0; index < total; index += 1) {
        const dueAt = start + index * intervalMs;
        const waitMs = dueAt - performance.now();
        if (waitMs > 0) await sleep(waitMs);
        if (performance.now() - start > durationMs && !options.requests) break;
        if (pending.size >= options.concurrency) {
            metrics.rejectedByClient += 1;
            continue;
        }
        metrics.attempted += 1;
        const payload = createPayload(runId, index, options.payloadSize);
        const operation = transport.send(payload)
            .then(result => {
                metrics.completed += 1;
                metrics.latencies.push(result.latencyMs);
            })
            .catch(error => {
                metrics.errors += 1;
                if (/timeout/i.test(error.message)) metrics.timeouts += 1;
                metrics.errorMessages[error.message] = (metrics.errorMessages[error.message] || 0) + 1;
            })
            .finally(() => pending.delete(operation));
        pending.add(operation);
    }
    await Promise.all([...pending]);
    const end = performance.now();
    sampling = false;
    if (transport.unmatched) metrics.unmatchedResponses = transport.unmatched();
    await transport.close();
    return {
        runId,
        trigger: options.trigger,
        target: transport.description,
        options: {
            rate: options.rate,
            duration: options.duration,
            requests: options.requests || null,
            concurrency: options.concurrency,
            timeout: options.timeout,
            warmup: options.warmup,
            payloadSize: options.payloadSize,
        },
        summary: summarize({ ...metrics, wallDurationMs: end - start }, options.requests ? end - start : durationMs),
        errors: metrics.errorMessages,
        samples,
    };
};

const printResult = result => {
    console.log(`${result.trigger} ${result.target}`);
    console.log(JSON.stringify(result.summary, null, 2));
    if (Object.keys(result.errors).length) console.log(`Errors: ${JSON.stringify(result.errors)}`);
    if (result.samples.length) console.log(`Status samples: ${result.samples.length}`);
};

const main = async () => {
    let options;
    try { options = parseArgs(process.argv.slice(2)); } catch (error) {
        console.error(`Error: ${error.message}\n\n${usage()}`);
        process.exitCode = 2;
        return;
    }
    if (options.help) { console.log(usage()); return; }
    try {
        const result = await runBenchmark(options);
        if (options.output) fs.writeFileSync(options.output, `${JSON.stringify(result, null, 2)}\n`);
        if (!options.quiet) printResult(result);
        if (result.summary.errors || result.summary.timeouts) process.exitCode = 1;
    } catch (error) {
        console.error(`Stress test failed: ${error.stack || error.message}`);
        process.exitCode = 1;
    }
};

if (require.main === module && !process.execArgv.includes('--test')) main();

module.exports = {
    correlationId,
    parseArgs,
    percentile,
    runBenchmark,
    summarize,
};
