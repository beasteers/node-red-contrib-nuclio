const http = require('http');

/* -------------------------------------------------------------------------- */
/*                            Mock Nuclio Dashboard                           */
/* -------------------------------------------------------------------------- */
// Minimal stand-in for the Nuclio dashboard API plus a function invocation
// endpoint (POST /). Records every request so tests can assert on the deploy
// pipeline, and exposes knobs for state/failure scenarios:
//
//   mock.functions      name -> stored config body (pre-populate to "exist")
//   mock.state          default status.state when no per-fn override is set
//   mock.functionStates per-fn current state (overrides mock.state)
//   mock.nextFnStates   per-fn queue of states to cycle through on GET polls
//   mock.failDeploys    POST/PUT /api/functions return 500
//   mock.functionCreateConflict  POST /api/functions stores then returns 409 once
//   mock.hideFunctionAfterWrite  next function GET after a write returns 404
//   mock.failStatus     if set, GET /api/functions/* returns this status code
//   mock.fn404ContentType  if set, 404s use this content-type instead of JSON
//   mock.invoke         (body, req) -> { status, body } for invocations
//   mock.invokeAddress  override the reported internal invocation host:port
//   mock.externalInvocationUrls override the reported external invocation URLs
//   mock.requests       [{ method, url, headers, body }]
//   mock.waitFor(matchFn, { timeout }) -> Promise<request>
//   mock.setFnState(name, state, [transitions])  convenience setter
//
// Server-enrichment mimics real Nuclio: stored bodies include filled-in
// defaults for triggers/resources/status, so hash-based change detection
// is actually tested against a server-enriched response rather than the
// verbatim POST/PUT body. GET adds live status alongside the stored config.
//
// State-transition support: after POST/PUT, a function enters the first
// state in mock.nextFnStates[name] (or 'ready' if none configured). Each
// subsequent GET poll consumes the next state, then stays at the terminal
// state. This lets tests drive the full building -> ready lifecycle.

const ENRICH_DEFAULTS = {
    triggers: {
        'default-http': { kind: 'http', maxWorkers: 1, attributes: { ingresses: {}, serviceType: 'ClusterIP' } },
    },
    resources: { requests: { cpu: '25m', memory: '1M' }, limits: { cpu: '1', memory: '512M' } },
    minReplicas: 1,
    maxReplicas: 1,
    version: -1,
};

const deepMergeDefaults = (spec) => {
    const merged = { ...ENRICH_DEFAULTS, ...spec };
    // top-level keys: shallow-merge sub-objects so user values win
    for (const key of ['triggers', 'resources']) {
        if (spec[key]) merged[key] = { ...ENRICH_DEFAULTS[key], ...spec[key] };
    }
    return merged;
};

const startMockNuclio = ({ functions = {}, state = 'ready', projectCreateConflict = false, functionCreateConflict = false, hideFunctionAfterWrite = false } = {}) => new Promise((resolveServer) => {
    const waiters = [];
    const mock = {
        functions,
        state,
        projectCreateConflict,
        functionCreateConflict,
        hideFunctionAfterWrite,
        hiddenFunctionReads: 0,
        functionStates: {},
        nextFnStates: {},
        failDeploys: false,
        failStatus: null,
        fn404ContentType: null,
        invokeAddress: null,
        externalInvocationUrls: [],
        requests: [],
        invoke: (body) => ({ status: 200, body: { echo: body } }),
        waitFor: (match, { timeout = 5000 } = {}) => {
            const found = mock.requests.find(match);
            if (found) return Promise.resolve(found);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('timed out waiting for request')), timeout);
                waiters.push({ match, resolve: (entry) => { clearTimeout(timer); resolve(entry); } });
            });
        },
        setFnState: (name, fnState, transitions = []) => {
            mock.functionStates[name] = fnState;
            mock.nextFnStates[name] = [...transitions];
        },
    };

    const record = (req, body) => {
        const entry = { method: req.method, url: req.url, headers: req.headers, body };
        mock.requests.push(entry);
        for (const w of waiters.filter(w => w.match(entry))) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(entry);
        }
        return entry;
    };

    const currentState = (name) => {
        if (mock.nextFnStates[name]?.length) {
            mock.functionStates[name] = mock.nextFnStates[name].shift();
        }
        return mock.functionStates[name] || mock.state;
    };

    const fnStatus = (name) => ({
        state: currentState(name),
        internalInvocationUrls: [mock.invokeAddress || `127.0.0.1:${mock.port}`],
        externalInvocationUrls: mock.externalInvocationUrls,
    });

    const storeFunction = (name, body) => {
        const stored = {
            apiVersion: body.apiVersion || 'nuclio.io/v1',
            kind: body.kind || 'Function',
            metadata: {
                labels: { 'nuclio.io/project-name': 'default' },
                ...(body.metadata || {}),
                annotations: { ...(body.metadata?.annotations || {}) },
            },
            spec: deepMergeDefaults(body.spec || {}),
        };
        mock.functions[name] = stored;

        // Only seed per-function state when a transition queue was
        // configured ahead of time (caller wants lifecycle control).
        // Otherwise let currentState() fall through to mock.state so
        // tests can change mock.state mid-test for state-change scenarios
        // (e.g. unhealthy → self-heal → PATCH).
        if (mock.nextFnStates[name]?.length && !mock.functionStates[name]) {
            mock.functionStates[name] = mock.nextFnStates[name].shift();
        }
    };

    const projectRegistry = { default: { metadata: { name: 'default' } } };

    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', c => raw += c);
        req.on('end', async () => {
            let body = raw;
            try { body = raw ? JSON.parse(raw) : undefined; } catch {
                body = raw;  // pass raw string so tests see the bad payload
            }
            record(req, body);
            const send = (status, data) => {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(data ?? {}));
            };

            const fnMatch = req.url.match(/^\/api\/functions\/([^/?]+)/);

            /* ---------------------------- Dashboard API ---------------------------- */

            if (req.method === 'GET' && req.url === '/api/projects') {
                return send(200, projectRegistry);
            }
            if (req.method === 'POST' && req.url === '/api/projects') {
                if (mock.projectCreateConflict) {
                    mock.projectCreateConflict = false;
                    return send(409, { error: 'project already exists' });
                }
                const name = body?.metadata?.name;
                if (name) projectRegistry[name] = { metadata: { name } };
                return send(201, body);
            }

            if (req.method === 'GET' && fnMatch && req.url.includes('/replicas')) {
                return send(200, { names: ['replica-1', 'replica-2'] });
            }
            if (req.method === 'GET' && fnMatch && req.url.includes('/logs/')) {
                const replica = decodeURIComponent(req.url.split('/logs/')[1].split('?')[0]);
                return send(200, `logs for ${replica}`);
            }
            if (req.method === 'GET' && req.url === '/api/functions') {
                const projectName = req.headers['x-nuclio-project-name'] || 'default';
                const functionsForProject = Object.fromEntries(
                    Object.entries(mock.functions)
                        .filter(([, fn]) => fn?.metadata?.labels?.['nuclio.io/project-name'] === projectName)
                        .map(([name, fn]) => [name, { ...fn, status: fnStatus(name) }])
                );
                return send(200, functionsForProject);
            }
            if (req.method === 'GET' && fnMatch) {
                if (mock.failStatus) {
                    return send(mock.failStatus, { error: `simulated ${mock.failStatus}` });
                }
                const fn = mock.functions[fnMatch[1]];
                if (mock.hiddenFunctionReads > 0) {
                    mock.hiddenFunctionReads -= 1;
                    return send(404, { error: 'Function not yet readable' });
                }
                if (!fn) {
                    if (mock.fn404ContentType) {
                        res.writeHead(404, { 'Content-Type': mock.fn404ContentType });
                        res.end('<html><body>Not Found</body></html>');
                    } else {
                        send(404, { error: 'Function not found' });
                    }
                    return;
                }
                return send(200, { ...fn, status: fnStatus(fnMatch[1]) });
            }
            if (req.method === 'POST' && req.url === '/api/functions') {
                if (mock.failDeploys) return send(500, { error: 'deploy failed' });
                const name = body?.metadata?.name;
                storeFunction(name, body);
                if (mock.functionCreateConflict) {
                    mock.functionCreateConflict = false;
                    return send(409, { error: 'function already exists' });
                }
                return send(202, body);
            }
            if (req.method === 'PUT' && fnMatch) {
                if (mock.failDeploys) return send(500, { error: 'deploy failed' });
                storeFunction(fnMatch[1], body);
                if (mock.hideFunctionAfterWrite) mock.hiddenFunctionReads = 1;
                return send(202, body);
            }
            if (req.method === 'PATCH' && fnMatch) {
                if (mock.hideFunctionAfterWrite) mock.hiddenFunctionReads = 1;
                return send(200, {});
            }

            /* --------------------------- Function Invocation ------------------------ */

            if (req.method === 'POST') {
                const r = await mock.invoke(body, req);
                return send(r.status, r.body);
            }
            send(404, { error: `unmatched route ${req.method} ${req.url}` });
        });
    });

    server.listen(0, '127.0.0.1', () => {
        mock.port = server.address().port;
        mock.url = `http://127.0.0.1:${mock.port}`;
        mock.close = () => new Promise(r => server.close(r));
        resolveServer(mock);
    });
});

module.exports = { startMockNuclio };
