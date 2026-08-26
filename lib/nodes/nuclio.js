const { invokeWithRetry } = require('../nuclio-invoke');
const registerAdminRoutes = require('./nuclio-admin');
const { pruneOrphan } = require('../nuclio-status');
const { debounced, numSetting, asString } = require('../util');
const { decorateStatus } = require('../nuclio-node-status');
const { getCredentialEntries, resolveTypedValue } = require('../nuclio-credential-entries');

const COMMANDS = new Set(['deploy', 'undeploy', 'redeploy', 'rebuild', 'status', 'prune']);

module.exports = function(RED) {
    registerAdminRoutes(RED);

    /* ----------------------------- Nuclio Invoke ----------------------------- */

    function NuclioInvokeNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        /* ----------------------------- Node Parameters ---------------------------- */

        node.function = RED.nodes.getNode(config.function);
        node.abortController = new AbortController();
        if (node.function) {
            node.function.childNodes.push(node);
            // catch up on the function's current status (config nodes construct first)
            if (node.function.lastStatus) node.status(decorateStatus(node.function.lastStatus, node.function, node));
        }
        node.on("close", function() {
            node.closed = true;
            node.abortController.abort();
            // deregister - with partial deploys the config node can outlive us
            const fn = node.function;
            if (fn?.childNodes) fn.childNodes = fn.childNodes.filter(cn => cn !== node);
        });
        try {
            node.headers = getCredentialEntries(node, config.headers, 'headerCredentials');
            node.headerConfigError = '';
        } catch (err) {
            node.headers = [];
            node.headerConfigError = err.message;
            node.warn(`Invalid invocation headers: ${err.message}`);
        }
        node.maxInFlight = numSetting(RED, node, config, 'maxInFlight', 0);
        node.timeoutMs = numSetting(RED, node, config, 'timeoutMs', 30000);
        node.retries = numSetting(RED, node, config, 'retries', 0);
        node.retryDelayMs = numSetting(RED, node, config, 'retryDelayMs', 500);

        node.statusDebounced = debounced((status) => {
            node.status(decorateStatus(status, node.function, node));
        }, 100, 500);
        node.counter = 0;

        /* ---------------------------- Request Headers ----------------------------- */

        const buildHeaders = (msg) => {
            const headers = { 'Content-Type': 'application/json' };
            for (const { name, value, type } of (node.headers || [])) {
                if (!name) continue;
                const resolved = resolveTypedValue(RED, node, msg, { name, value, type });
                headers[name] = asString(resolved);
            }
            // Nuclio's scale-to-zero DLX uses this header to route a request
            // from the function Service to the correct target after its
            // processor deployment has reached zero replicas.
            if (node.function?.name) headers['X-Nuclio-Target'] = node.function.name;
            return headers;
        };

        /* ------------------------------- Node Events ------------------------------ */

        const ring = (text) => ({ fill: "yellow", shape: "ring", text });

        const getCommand = (msg) => {
            const command = msg?.nuclio?.command;
            return typeof command === 'string' ? command.trim().toLowerCase() : null;
        };

        const setCommandResult = (msg, command, result) => {
            const metadata = msg.nuclio && typeof msg.nuclio === 'object' && !Array.isArray(msg.nuclio)
                ? msg.nuclio
                : {};
            msg.nuclio = { ...metadata, command, result };
        };

        const waitForReady = (fnNode) => new Promise((resolve, reject) => {
            const timeoutMs = Math.max(1000, fnNode.redeployDeadlineMs || 120000);
            const started = Date.now();
            let timer;
            let settled = false;
            const onClose = () => finish(reject, new Error('Node is closing'));
            const cleanup = () => {
                if (timer) clearTimeout(timer);
                node.removeListener('close', onClose);
            };
            const finish = (handler, value) => {
                if (settled) return;
                settled = true;
                cleanup();
                handler(value);
            };
            const check = () => {
                if (node.closed || fnNode.closed) return finish(reject, new Error('Node is closing'));
                if (fnNode.configError) return finish(reject, new Error(fnNode.configErrorReason || 'Function configuration is invalid'));
                if (fnNode.server?.deploymentEnabled === false) return finish(reject, new Error('Function deployment is disabled for this Nuclio server'));
                if (fnNode.fnState === 'ready' && !fnNode.redeploying) return finish(resolve);
                if (Date.now() - started >= timeoutMs) return finish(reject, new Error(`Function did not become ready within ${timeoutMs}ms`));
                timer = setTimeout(check, 100);
            };
            node.once('close', onClose);
            check();
        });

        const commandStatus = (fnNode) => ({
            state: fnNode.fnState || null,
            ready: fnNode.fnState === 'ready' && !fnNode.redeploying,
            deploying: Boolean(fnNode.redeploying),
            deploymentMode: fnNode.deploymentMode || 'eager',
            activated: fnNode.lazyActivated !== false,
        });

        const executeCommand = async (command, msg, send, done) => {
            const fnNode = node.function;
            const finish = (result) => {
                setCommandResult(msg, command, result);
                send([msg, null]);
                if (done) done();
            };
            const fail = (err) => {
                const message = err?.message || `${command} failed`;
                if (node.closed) {
                    if (done) done();
                    return;
                }
                setCommandResult(msg, command, { accepted: false, error: message });
                msg.error = { message, code: err?.code };
                // Keep the command payload out of Node-RED's error log; the
                // original message is still available on the fallback output.
                node.error(`Nuclio command ${command} failed: ${message}`);
                send([null, msg]);
                if (done) done();
            };

            try {
                if (!fnNode) throw new Error('No function configured');
                if (!COMMANDS.has(command)) throw new Error(`Unknown command "${command}"`);
                if (command === 'status') return finish(commandStatus(fnNode));
                if (command === 'prune') {
                    const target = msg?.nuclio?.target || msg?.nuclio?.function || msg?.nuclio?.name;
                    return finish(await pruneOrphan(fnNode, target));
                }
                if (fnNode.server?.deploymentEnabled === false) {
                    throw new Error('Function deployment is disabled for this Nuclio server');
                }

                // Rebuild/redeploy must not be swallowed by an earlier ordinary
                // deploy that is still in flight. Wait for it, then run the
                // stronger explicit command.
                if (command !== 'deploy' && fnNode.deployPromise) {
                    try { await fnNode.deployPromise; } catch { /* retry the explicit command below */ }
                }

                if (command === 'undeploy') {
                    const result = await fnNode.deactivateDeployment();
                    return finish({ ...result, ...commandStatus(fnNode) });
                }

                const options = command === 'rebuild'
                    ? { force: true, rebuild: true }
                    : command === 'redeploy'
                        ? { force: true }
                        : {};
                const accepted = await fnNode.activateDeployment(options);
                if (accepted === false) throw new Error('Function deployment could not be started');
                await waitForReady(fnNode);
                return finish({ accepted: true, ...commandStatus(fnNode) });
            } catch (err) {
                return fail(err);
            }
        };

        const queueCommand = (fnNode, command, msg, send, done) => {
            const previous = fnNode?.commandPromise || Promise.resolve();
            const next = previous.then(
                () => executeCommand(command, msg, send, done),
                () => executeCommand(command, msg, send, done),
            );
            if (fnNode) fnNode.commandPromise = next.catch(() => {});
            return next;
        };

        node.on("input", async function(msg, send, done) {
            const fnNode = node.function;

            const command = getCommand(msg);
            if (command) return queueCommand(fnNode, command, msg, send, done);

            /* ---------------- Check if Function is Ready to be Invoked ---------------- */
            // Not ready? Pass the message through unchanged to the fallback output.

            const drop = (status) => {
                if (status) node.statusDebounced(status);
                if (done) done();
                return send([null, msg]);
            };

            if (!fnNode) return drop(ring("No function"));
            if (fnNode.configErrorReason === 'No server configured') return drop(ring("No server"));
            if (node.headerConfigError) return drop(ring("Invalid headers"));
            if (fnNode.lazyActivated === false) return drop(ring("Waiting for deploy"));
            if (fnNode.redeploying) return drop(ring("Redeploying"));
            if (fnNode.fnState === 'error') return drop(ring('Error'));
            if (!fnNode.invocationUrl) return drop(ring("No HTTP trigger"));
            if (node.maxInFlight > 0 && node.counter >= node.maxInFlight) return drop(ring("Backpressure"));

            /* ----------------------------- Invoke Function ---------------------------- */

            const startTime = Date.now();
            const result = await invokeWithRetry({ node, fnNode, msg, getHeaders: () => buildHeaders(msg) });
            const { error, transientError, response } = result;

            // A close can happen while axios or the retry delay is in flight.
            // Do not emit a message or call done on a node that is shutting down.
            if (node.closed) return;

            // Add response details to message
            msg.requestDurationMs = Date.now() - startTime;
            if (response) {
                // Keep response details useful without copying Axios' request
                // config back into the flow. Axios config includes the
                // request headers, which may contain credential-backed values.
                msg.response = {
                    data: response.data,
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers,
                };
                msg.headers = response?.headers;
                msg.statusCode = response?.status;
                msg.statusText = response?.statusText;
            }
            // Fallback output carries the error so downstream flows can branch on it
            if (error) {
                msg.error = { message: error.message, code: error.code };
                if (msg.statusCode === undefined) msg.statusCode = error.code;
            }

            // Non-transient errors go to Catch nodes exactly once (transient ones
            // only warned above). Reported after msg is populated so Catch sees
            // the same details the fallback output carries.
            if (error && !transientError) {
                const detail = response?.data || response?.body;
                node.error(`Function invocation error[${error.code}]: ${detail ? JSON.stringify(detail) : error.message}`, msg);
            }

            // Send response to output 1, errors to output 2
            if (error) send([null, msg]);
            else send([msg, null]);
            if (done) done();
        });
    }
    RED.nodes.registerType("nuclio", NuclioInvokeNode, {
        credentials: {
            headerCredentials: { type: 'text' },
        },
    });
};
