const http = require('http');

/* -------------------------------------------------------------------------- */
/*                            Mock Nuclio Dashboard                           */
/* -------------------------------------------------------------------------- */
// Minimal stand-in for the Nuclio dashboard API plus a function invocation
// endpoint (POST /). Records every request so tests can assert on the deploy
// pipeline, and exposes knobs for state/failure scenarios:
//
//   mock.functions    name -> last deployed config body (pre-populate to "exist")
//   mock.state        status.state reported for every function (default 'ready')
//   mock.failDeploys  POST/PUT /api/functions return 500
//   mock.invoke       (body, req) -> { status, body } for invocations
//   mock.requests     [{ method, url, headers, body }]
//   mock.waitFor(matchFn, { timeout }) -> Promise<request>

const startMockNuclio = ({ functions = {}, state = 'ready' } = {}) => new Promise((resolveServer) => {
    const waiters = [];
    const mock = {
        functions,
        state,
        failDeploys: false,
        requests: [],
        invoke: (body) => ({ status: 200, body: { echo: body } }),
        waitFor: (match, { timeout = 5000 } = {}) => {
            const found = mock.requests.find(match);
            if (found) return Promise.resolve(found);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`timed out waiting for request`)), timeout);
                waiters.push({ match, resolve: (entry) => { clearTimeout(timer); resolve(entry); } });
            });
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

    const fnStatus = () => ({ state: mock.state, internalInvocationUrls: [`127.0.0.1:${mock.port}`] });

    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', c => raw += c);
        req.on('end', async () => {
            let body = raw;
            try { body = raw ? JSON.parse(raw) : undefined; } catch { /* keep raw string */ }
            record(req, body);
            const send = (status, data) => {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(data ?? {}));
            };

            const fnMatch = req.url.match(/^\/api\/functions\/([^/?]+)/);

            /* ---------------------------- Dashboard API ---------------------------- */

            if (req.method === 'GET' && req.url === '/api/projects') return send(200, {});
            if (req.method === 'POST' && req.url === '/api/projects') return send(201, body);

            if (req.method === 'GET' && fnMatch && req.url.includes('/replicas')) {
                return send(200, { names: ['replica-1', 'replica-2'] });
            }
            if (req.method === 'GET' && fnMatch && req.url.includes('/logs/')) {
                const replica = decodeURIComponent(req.url.split('/logs/')[1].split('?')[0]);
                return send(200, `logs for ${replica}`);
            }
            if (req.method === 'GET' && fnMatch) {
                const fn = mock.functions[fnMatch[1]];
                if (!fn) return send(404, { error: 'Function not found' });
                return send(200, { ...fn, status: fnStatus() });
            }
            if (req.method === 'POST' && req.url === '/api/functions') {
                if (mock.failDeploys) return send(500, { error: 'deploy failed' });
                mock.functions[body?.metadata?.name] = body;
                return send(202, body);
            }
            if (req.method === 'PUT' && fnMatch) {
                if (mock.failDeploys) return send(500, { error: 'deploy failed' });
                mock.functions[fnMatch[1]] = body;
                return send(202, body);
            }
            if (req.method === 'PATCH' && fnMatch) return send(200, {});

            /* --------------------------- Function Invocation ------------------------ */

            if (req.method === 'POST') {
                const r = await mock.invoke(body, req);
                return send(r.status, r.body);
            }
            send(200, {});
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
