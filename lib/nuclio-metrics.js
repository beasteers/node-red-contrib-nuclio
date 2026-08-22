const metricsByServer = new WeakMap();

const HELP = Object.freeze({
    nuclio_dashboard_requests_total: 'Dashboard API requests made by operation and outcome.',
    nuclio_dashboard_request_duration_seconds: 'Dashboard API request duration.',
    nuclio_dashboard_circuit_trips_total: 'Times the dashboard circuit breaker opened.',
    nuclio_dashboard_circuit_rejections_total: 'Dashboard requests rejected by an open circuit.',
    nuclio_deployments_total: 'Function deployment attempts by outcome.',
    nuclio_deployment_duration_seconds: 'Function deployment duration.',
    nuclio_reconcile_steps_total: 'Function reconciliation cycles.',
    nuclio_invocations_total: 'Function invocations by outcome.',
    nuclio_invocation_retries_total: 'Transient invocation retries.',
    nuclio_invocation_duration_seconds: 'Function invocation duration.',
});

const labelsKey = labels => JSON.stringify(Object.entries(labels || {}).sort(([a], [b]) => a.localeCompare(b)));
const escapeLabel = value => `${value}`
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll('"', '\\"');
const formatLabels = labels => {
    const entries = Object.entries(labels || {}).sort(([a], [b]) => a.localeCompare(b));
    if (!entries.length) return '';
    return `{${entries.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(',')}}`;
};

const functionLabels = node => ({
    function: node?.name || 'unknown',
    project: node?.project?.name || 'default',
});

const createMetrics = () => {
    const counters = new Map();
    const gauges = new Map();
    const summaries = new Map();

    const add = (collection, name, labels, value) => {
        const key = `${name}\u0000${labelsKey(labels)}`;
        const current = collection.get(key);
        if (current) current.value += value;
        else collection.set(key, { name, labels: { ...labels }, value });
    };

    const increment = (name, labels, value = 1) => add(counters, name, labels, value);
    const set = (name, labels, value) => {
        const key = `${name}\u0000${labelsKey(labels)}`;
        gauges.set(key, { name, labels: { ...labels }, value });
    };
    const observe = (name, labels, value) => {
        const key = `${name}\u0000${labelsKey(labels)}`;
        const current = summaries.get(key);
        if (current) {
            current.count++;
            current.sum += value;
        } else {
            summaries.set(key, { name, labels: { ...labels }, count: 1, sum: value });
        }
    };

    const recordDashboardRequest = (operation, durationMs, outcome, status) => {
        const labels = { operation, outcome };
        if (status !== undefined && status !== null) labels.status = status;
        increment('nuclio_dashboard_requests_total', labels);
        observe('nuclio_dashboard_request_duration_seconds', { operation }, durationMs / 1000);
    };

    return {
        increment,
        set,
        observe,
        recordDashboardRequest,
        recordCircuitTrip: () => increment('nuclio_dashboard_circuit_trips_total', {}),
        recordCircuitRejection: () => increment('nuclio_dashboard_circuit_rejections_total', {}),
        recordDeployment: (node, outcome, durationMs) => {
            const labels = { ...functionLabels(node), outcome };
            increment('nuclio_deployments_total', labels);
            observe('nuclio_deployment_duration_seconds', functionLabels(node), durationMs / 1000);
        },
        recordReconcile: node => increment('nuclio_reconcile_steps_total', functionLabels(node)),
        recordInvocation: (fnNode, outcome, durationMs, retries) => {
            const labels = { ...functionLabels(fnNode), outcome };
            increment('nuclio_invocations_total', labels);
            if (retries) increment('nuclio_invocation_retries_total', functionLabels(fnNode), retries);
            observe('nuclio_invocation_duration_seconds', functionLabels(fnNode), durationMs / 1000);
        },
        toPrometheus() {
            const lines = [];
            const metricNames = new Set([
                ...[...counters.values()].map(metric => metric.name),
                ...[...gauges.values()].map(metric => metric.name),
                ...[...summaries.values()].map(metric => metric.name),
            ]);

            for (const name of [...metricNames].sort()) {
                const type = counters.values().some(metric => metric.name === name)
                    ? 'counter'
                    : gauges.values().some(metric => metric.name === name) ? 'gauge' : 'summary';
                lines.push(`# HELP ${name} ${HELP[name] || name}`);
                lines.push(`# TYPE ${name} ${type}`);
                for (const metric of [...counters.values()].filter(item => item.name === name)) {
                    lines.push(`${name}${formatLabels(metric.labels)} ${metric.value}`);
                }
                for (const metric of [...gauges.values()].filter(item => item.name === name)) {
                    lines.push(`${name}${formatLabels(metric.labels)} ${metric.value}`);
                }
                for (const metric of [...summaries.values()].filter(item => item.name === name)) {
                    lines.push(`${name}_count${formatLabels(metric.labels)} ${metric.count}`);
                    lines.push(`${name}_sum${formatLabels(metric.labels)} ${metric.sum}`);
                }
            }
            return `${lines.join('\n')}\n`;
        },
    };
};

const getMetrics = server => {
    if (!server || typeof server !== 'object') return createMetrics();
    let metrics = metricsByServer.get(server);
    if (!metrics) {
        metrics = createMetrics();
        metricsByServer.set(server, metrics);
    }
    return metrics;
};

module.exports = { createMetrics, getMetrics, functionLabels };
