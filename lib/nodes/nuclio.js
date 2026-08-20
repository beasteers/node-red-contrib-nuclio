const { invokeWithRetry } = require('../nuclio-invoke');
const registerAdminRoutes = require('./nuclio-admin');
const { debounced, numSetting, asString } = require('../util');

module.exports = function(RED) {
    registerAdminRoutes(RED);

    /* ----------------------------- Nuclio Invoke ----------------------------- */

    function NuclioInvokeNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        /* ----------------------------- Node Parameters ---------------------------- */

        node.function = RED.nodes.getNode(config.function);
        if (node.function) {
            node.function.childNodes.push(node);
            // catch up on the function's current status (config nodes construct first)
            if (node.function.lastStatus) node.status(node.function.lastStatus);
        }
        node.on("close", function() {
            node.closed = true;
            // deregister - with partial deploys the config node can outlive us
            const fn = node.function;
            if (fn?.childNodes) fn.childNodes = fn.childNodes.filter(cn => cn !== node);
        });
        node.headers = config.headers || [];
        node.maxInFlight = numSetting(RED, node, config, 'maxInFlight', 0);
        node.timeoutMs = numSetting(RED, node, config, 'timeoutMs', 30000);
        node.retries = numSetting(RED, node, config, 'retries', 0);
        node.retryDelayMs = numSetting(RED, node, config, 'retryDelayMs', 500);

        node.statusDebounced = debounced((status) => { node.status(status) }, 100, 500);
        node.counter = 0;

        /* ---------------------------- Request Headers ----------------------------- */

        const buildHeaders = (msg) => {
            const headers = { 'Content-Type': 'application/json' };
            for (const { name, value, type } of (node.headers || [])) {
                if (!name) continue;
                const resolved = RED.util.evaluateNodeProperty(value, type || 'str', node, msg);
                headers[name] = asString(resolved);
            }
            return headers;
        };

        /* ------------------------------- Node Events ------------------------------ */

        const ring = (text) => ({ fill: "yellow", shape: "ring", text });

        node.on("input", async function(msg, send, done) {
            const fnNode = node.function;

            /* ---------------- Check if Function is Ready to be Invoked ---------------- */
            // Not ready? Pass the message through unchanged to the fallback output.

            const drop = (status) => {
                if (status) node.statusDebounced(status);
                if (done) done();
                return send([null, msg]);
            };

            if (!fnNode) return drop(ring("No function"));
            if (fnNode.configErrorReason === 'No server configured') return drop(ring("No server"));
            if (fnNode.redeploying) return drop(ring("Redeploying"));
            if (fnNode.fnState === 'error') return drop(ring(fnNode.fnState || 'Not ready'));
            if (!fnNode.invocationUrl) return drop();
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
                msg.response = response;
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
    RED.nodes.registerType("nuclio", NuclioInvokeNode);
};
