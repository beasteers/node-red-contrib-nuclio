const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMetrics } = require('../lib/nuclio-metrics');

test('metrics render counters and summaries without sensitive request data', () => {
    const metrics = createMetrics();
    const node = { name: 'demo/function', project: { name: 'project-a' } };

    metrics.recordDashboardRequest('getFunction', 25, 'success', 200);
    metrics.recordCircuitTrip();
    metrics.recordDeployment(node, 'accepted', 100);
    metrics.recordReconcile(node);
    metrics.recordInvocation(node, 'success', 50, 1);

    const output = metrics.toPrometheus();
    assert.match(output, /nuclio_dashboard_requests_total\{operation="getFunction",outcome="success",status="200"\} 1/);
    assert.match(output, /nuclio_dashboard_circuit_trips_total 1/);
    assert.match(output, /nuclio_deployments_total\{function="demo\/function",outcome="accepted",project="project-a"\} 1/);
    assert.match(output, /nuclio_invocation_retries_total\{function="demo\/function",project="project-a"\} 1/);
    assert.doesNotMatch(output, /password|token|http:\/\//i);
});
