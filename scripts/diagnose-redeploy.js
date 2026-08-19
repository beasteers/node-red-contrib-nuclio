#!/usr/bin/env node

/*
 * Capture the state transition caused by a Nuclio redeploy.
 *
 * This intentionally uses the public Docker, Nuclio, and Node-RED APIs rather
 * than importing package internals. The goal is to compare independently
 * observed state and identify whether an endpoint changed in Docker, in the
 * dashboard response, or only inside Node-RED.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const args = process.argv.slice(2);

const option = (name, fallback = undefined) => {
    const index = args.indexOf(`--${name}`);
    if (index === -1) return fallback;
    const value = args[index + 1];
    return value && !value.startsWith('--') ? value : true;
};

const required = option('function');
if (!required) {
    console.error('Usage: node scripts/diagnose-redeploy.js --function <name> [options]');
    console.error('Options: --node-id <id> --duration <seconds> --interval <ms> --rebuild --report <path>');
    process.exit(2);
}

const targetName = required;
const nodeRedUrl = String(option('nodered-url', process.env.NODERED_URL || 'http://127.0.0.1:1882')).replace(/\/$/, '');
const nuclioUrl = String(option('nuclio-url', process.env.NUCLIO_URL || 'http://127.0.0.1:8072')).replace(/\/$/, '');
const projectName = String(option('project', process.env.NUCLIO_PROJECT || 'default'));
const durationMs = Math.max(1000, Number(option('duration', 90)) * 1000);
const intervalMs = Math.max(250, Number(option('interval', 1000)));
const probeIntervalMs = Math.max(intervalMs, Number(option('probe-interval', 2000)));
const containerPrefix = String(option('container-prefix', process.env.NUCLIO_CONTAINER_PREFIX || 'nuclio-nuclio-'));
const reportPath = option('report', path.join(process.cwd(), `redeploy-diagnostic-${targetName}-${Date.now()}.json`));
const authToken = option('token', process.env.NODERED_TOKEN || process.env.NUCLIO_TOKEN);
const requestedNodeId = option('node-id');
const rebuild = args.includes('--rebuild');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const request = (url, { method = 'GET', headers = {}, body, timeoutMs = 10000 } = {}) => new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const requestHeaders = { Accept: 'application/json', ...headers };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) requestHeaders['Content-Type'] = 'application/json';
    const req = transport.request(parsed, { method, headers: requestHeaders, timeout: timeoutMs }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => {
            let data = text;
            try { data = text ? JSON.parse(text) : null; } catch { /* preserve non-JSON response */ }
            resolve({ status: res.statusCode || 0, headers: res.headers, data });
        });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
});

const run = (command, commandArgs) => new Promise((resolve) => {
    const child = spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
});

const docker = async (commandArgs) => {
    const result = await run('docker', commandArgs);
    if (result.code !== 0) return { error: result.stderr.trim() || `docker exited ${result.code}` };
    return result.stdout.trim();
};

const jsonRequest = async (url, options = {}) => {
    try {
        const response = await request(url, options);
        if (response.status < 200 || response.status >= 300) {
            return { error: `HTTP ${response.status}`, status: response.status, body: response.data };
        }
        return response.data;
    } catch (error) {
        return { error: error.message };
    }
};

const asArray = (value) => Array.isArray(value) ? value : [];

const functionNodes = (flows) => asArray(flows?.flows || flows)
    .filter(node => node?.type === 'nuclio-function' && node.name)
    .map(node => ({ name: node.name, id: node.id }));

const getFlows = async () => {
    const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
    return jsonRequest(`${nodeRedUrl}/flows`, { headers });
};

const findFunctionNodes = async () => {
    if (requestedNodeId) return [{ name: targetName, id: requestedNodeId }];
    const flows = await getFlows();
    const nodes = functionNodes(flows);
    if (!nodes.length) throw new Error('Could not discover Node-RED function nodes from GET /flows; pass --node-id <id>.');
    const target = nodes.find(node => node.name === targetName);
    if (!target) throw new Error(`No Node-RED nuclio-function named "${targetName}" was found; pass --node-id <id>.`);
    return nodes;
};

const dashboardFunction = (name) => jsonRequest(
    `${nuclioUrl}/api/functions/${encodeURIComponent(name)}`,
    { headers: { 'x-nuclio-project-name': projectName } }
);

const nodeRedFunction = (id) => jsonRequest(
    `${nodeRedUrl}/nuclio/api/functions?id=${encodeURIComponent(id)}&view=summary`,
    { headers: authToken ? { Authorization: `Bearer ${authToken}` } : {} }
);

const listDashboardFunctions = async () => {
    const data = await jsonRequest(`${nuclioUrl}/api/functions`, {
        headers: { 'x-nuclio-project-name': projectName },
    });
    const entries = Array.isArray(data) ? data : asArray(data?.functions);
    return entries.map(entry => entry?.metadata?.name || entry?.name).filter(Boolean);
};

const inspectContainer = async (name) => {
    const names = await docker(['ps', '-a', '--format', '{{.Names}}']);
    if (typeof names !== 'string') return { error: names.error };
    const candidates = names.split('\n').filter(Boolean);
    const exact = `${containerPrefix}${name}`;
    const containerName = candidates.includes(exact)
        ? exact
        : candidates.find(candidate => candidate.endsWith(`-${name}`) && candidate.includes('nuclio'));
    if (!containerName) return { error: `container not found (expected ${exact})` };

    const result = await docker(['inspect', containerName]);
    if (typeof result !== 'string') return { name: containerName, error: result.error };
    try {
        const [container] = JSON.parse(result);
        const networks = Object.values(container.NetworkSettings?.Networks || {});
        const ports = Object.entries(container.NetworkSettings?.Ports || {}).flatMap(([key, bindings]) =>
            asArray(bindings).map(binding => ({ container: key, host: binding.HostPort, hostIp: binding.HostIp }))
        );
        return {
            name: containerName,
            id: container.Id,
            shortId: container.Id?.slice(0, 12),
            created: container.Created,
            status: container.State?.Status,
            startedAt: container.State?.StartedAt,
            finishedAt: container.State?.FinishedAt,
            restartCount: container.RestartCount,
            ips: networks.map(network => network.IPAddress).filter(Boolean),
            networks: networks.map(network => network.NetworkID).filter(Boolean),
            ports,
        };
    } catch (error) {
        return { name: containerName, error: `invalid docker inspect output: ${error.message}` };
    }
};

const probeFromNodeRed = async (name) => {
    const host = `${containerPrefix}${name}`;
    const command = [
        'exec', 'nodered-nuclio', 'sh', '-lc',
        `curl -sS -o /dev/null -w '%{http_code} %{remote_ip} %{time_total}' --max-time 3 http://${host}:8080/`,
    ];
    const result = await run('docker', command);
    if (result.code !== 0) return { error: result.stderr.trim() || `docker exec exited ${result.code}` };
    const [status, remoteIp, seconds] = result.stdout.trim().split(/\s+/);
    return { status: Number(status), remoteIp, seconds: Number(seconds) };
};

const parseUrlHost = (value) => {
    try { return new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`).hostname; } catch { return null; }
};

const parseUrlPort = (value) => {
    try { return Number(new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`).port || 80); } catch { return null; }
};

const endpointAnalysis = (dashboard, container) => {
    const status = dashboard?.status || {};
    const internals = asArray(status.internalInvocationUrls);
    const externals = asArray(status.externalInvocationUrls);
    const actualIps = asArray(container?.ips);
    const hostPorts = asArray(container?.ports).map(port => Number(port.host)).filter(Number.isFinite);
    const internalHosts = internals.map(parseUrlHost).filter(Boolean);
    const externalPorts = externals.map(parseUrlPort).filter(Boolean);
    return {
        internalHosts,
        externalPorts,
        actualIps,
        actualHostPorts: hostPorts,
        internalHostMatchesContainer: !actualIps.length || internalHosts.some(host => actualIps.includes(host)),
        externalPortMatchesContainer: !hostPorts.length || externalPorts.some(port => hostPorts.includes(port)),
    };
};

const snapshot = async (nodes, previousProbeAt, previousEntries = []) => {
    const dashboardNames = await listDashboardFunctions();
    const names = [...new Set([targetName, ...nodes.map(node => node.name), ...dashboardNames])];
    const nodeByName = new Map(nodes.map(node => [node.name, node]));
    const previousByName = new Map(previousEntries.map(entry => [entry.name, entry]));
    const shouldProbe = Date.now() - previousProbeAt >= probeIntervalMs;
    const entries = await Promise.all(names.map(async name => {
        const node = nodeByName.get(name);
        const previous = previousByName.get(name);
        const [dashboard, container] = await Promise.all([
            dashboardFunction(name),
            inspectContainer(name),
        ]);
        const nodeRed = node ? await nodeRedFunction(node.id) : null;
        const probe = shouldProbe ? await probeFromNodeRed(name) : previous?.probe;
        return {
            name,
            nodeId: node?.id,
            dashboard: dashboard?.error ? dashboard : {
                state: dashboard?.status?.state,
                internalInvocationUrls: dashboard?.status?.internalInvocationUrls,
                externalInvocationUrls: dashboard?.status?.externalInvocationUrls,
            },
            nodeRed: nodeRed?.error ? nodeRed : {
                state: nodeRed?.status?.state,
                internalInvocationUrls: nodeRed?.status?.internalInvocationUrls,
                externalInvocationUrls: nodeRed?.status?.externalInvocationUrls,
            },
            container,
            endpointAnalysis: endpointAnalysis(dashboard, container),
            probe,
        };
    }));
    return { names, entries, probeAt: shouldProbe ? Date.now() : previousProbeAt };
};

const summarize = (record) => record.entries.map(entry => {
    const dashboardUrl = entry.dashboard?.internalInvocationUrls?.[0] || '—';
    const ip = entry.container?.ips?.[0] || '—';
    const probe = entry.probe ? `${entry.probe.status || entry.probe.error} ${entry.probe.remoteIp || ''}`.trim() : '—';
    return `${entry.name}: state=${entry.dashboard?.state || '—'} dashboard=${dashboardUrl} docker=${ip} container=${entry.container?.shortId || '—'} probe=${probe}`;
}).join('\n');

const changes = (before, after) => {
    const output = [];
    const beforeByName = new Map((before?.entries || []).map(entry => [entry.name, entry]));
    for (const entry of after.entries) {
        const old = beforeByName.get(entry.name);
        if (!old) {
            output.push(`${entry.name}: appeared`);
            continue;
        }
        const fields = [
            ['container', old.container?.shortId, entry.container?.shortId],
            ['docker IP', old.container?.ips?.join(','), entry.container?.ips?.join(',')],
            ['dashboard internal URL', old.dashboard?.internalInvocationUrls?.join(','), entry.dashboard?.internalInvocationUrls?.join(',')],
            ['Node-RED internal URL', old.nodeRed?.internalInvocationUrls?.join(','), entry.nodeRed?.internalInvocationUrls?.join(',')],
            ['dashboard state', old.dashboard?.state, entry.dashboard?.state],
            ['probe', JSON.stringify(old.probe), JSON.stringify(entry.probe)],
        ];
        for (const [label, previous, current] of fields) {
            if (previous !== current) output.push(`${entry.name}: ${label} ${previous ?? '—'} -> ${current ?? '—'}`);
        }
    }
    return output;
};

const runDiagnostic = async () => {
    const nodes = await findFunctionNodes();
    const target = nodes.find(node => node.name === targetName);
    if (!target) throw new Error(`Target ${targetName} was not found.`);
    console.log(`Target: ${targetName} (Node-RED node ${target.id})`);
    console.log(`Nuclio: ${nuclioUrl} | Node-RED: ${nodeRedUrl} | duration: ${durationMs / 1000}s`);

    const report = {
        startedAt: new Date().toISOString(),
        options: { targetName, projectName, nodeRedUrl, nuclioUrl, durationMs, intervalMs, probeIntervalMs, rebuild },
        targetNode: target,
        trigger: null,
        samples: [],
        changes: [],
    };

    let previousProbeAt = 0;
    let previous = await snapshot(nodes, previousProbeAt);
    previousProbeAt = previous.probeAt;
    report.samples.push({ at: new Date().toISOString(), phase: 'before-redeploy', ...previous });
    console.log('\nBEFORE REDEPLOY');
    console.log(summarize(previous));

    const query = `id=${encodeURIComponent(target.id)}${rebuild ? '&rebuild=true' : ''}`;
    const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
    // Deployment is asynchronous from the function's perspective, but the
    // Node-RED admin route waits for the dashboard's deploy request to finish.
    // Give that request the same generous window as the package deploy timeout.
    const triggerResponse = await request(`${nodeRedUrl}/nuclio/api/functions/deploy?${query}`, {
        method: 'POST',
        headers,
        timeoutMs: Number(option('trigger-timeout', 120000)),
    });
    report.trigger = { status: triggerResponse.status, body: triggerResponse.data };
    if (triggerResponse.status < 200 || triggerResponse.status >= 300) {
        throw new Error(`Redeploy trigger failed: HTTP ${triggerResponse.status}`);
    }
    console.log(`\nREDEPLOY TRIGGERED: HTTP ${triggerResponse.status}`);

    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
        await sleep(intervalMs);
        const current = await snapshot(nodes, previousProbeAt, previous.entries);
        previousProbeAt = current.probeAt;
        const at = new Date().toISOString();
        const delta = changes(previous, current);
        if (delta.length) {
            report.changes.push({ at, changes: delta });
            console.log(`\n${at}`);
            delta.forEach(line => console.log(`  ${line}`));
        }
        report.samples.push({ at, phase: 'after-redeploy', ...current });
        previous = current;
    }

    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nReport written to ${reportPath}`);
    console.log(`Samples: ${report.samples.length}; observed changes: ${report.changes.reduce((count, item) => count + item.changes.length, 0)}`);
};

runDiagnostic().catch(error => {
    console.error(`Diagnostic failed: ${error.message}`);
    process.exitCode = 1;
});
