const axios = require('axios');
const {
    retryBackoff,
    isTransientErrorCode,
    isTransientError,
} = require('./util');
const { getMetrics } = require('./nuclio-metrics');

// Transient invocation failures: connectivity errors plus the gateway signals
// of a function scaling/redeploying. These only warn (never Catch nodes) and
// are the only errors eligible for retry.
const sleep = (ms, signal) => new Promise(resolve => {
    let timer;
    const finish = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        resolve();
    };
    timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted) finish();
});

// Invoke a function with endpoint failover and transient-error retries. The
// caller remains responsible for readiness checks and routing the final result
// to Node-RED outputs.
const invokeWithRetry = async ({ node, fnNode, msg, headers, getHeaders, request = axios.post.bind(axios) }) => {
    let error;
    let transientError = false;
    let response;
    let retryCount = 0;
    const startedAt = Date.now();

    const candidates = Array.isArray(fnNode.invocationUrls) && fnNode.invocationUrls.length
        ? fnNode.invocationUrls
        : [fnNode.invocationUrl];
    let candidateIndex = Math.max(0, candidates.indexOf(fnNode.invocationUrl));

    node.counter++;
    try {
        const requestHeaders = getHeaders ? getHeaders() : headers;
        for (let attempt = 0; ; attempt++) {
            if (node.closed) break;
            try {
                response = await request(fnNode.invocationUrl, msg.payload, {
                    headers: requestHeaders,
                    timeout: node.timeoutMs,
                    signal: node.abortController?.signal,
                });
                msg.payload = response.data;
                fnNode.fnInvocationStatus = response.status;
                fnNode.lastInvocationAt = Date.now();
                error = null;
                transientError = false;
                break;
            } catch (err) {
                error = err;
                response = err?.response;
                transientError = isTransientError(err);
                fnNode.fnInvocationStatus = response?.status ?? 0;
                fnNode.lastInvocationAt = Date.now();

                // A connection failure can indicate that this endpoint is no
                // longer reachable. Try the next reported endpoint first.
                const canFailover = isTransientErrorCode(err?.code)
                    && candidateIndex < candidates.length - 1
                    && !node.closed;
                if (canFailover) {
                    candidateIndex++;
                    fnNode.invocationUrl = candidates[candidateIndex];
                    node.warn(`Function invocation endpoint unavailable (${err.code}); trying ${fnNode.invocationUrl}`);
                    continue;
                }

                if (transientError && attempt < node.retries && !node.closed) {
                    retryCount++;
                    const delayMs = retryBackoff(
                        attempt + 1,
                        node.retryDelayMs,
                        response?.headers?.['retry-after'],
                    );
                    node.warn(`Function invocation error[${err?.code || response?.status}]: ${fnNode.invocationUrl} ${fnNode.fnConfigSpec?.name} ${fnNode.fnState} - ${err.message} (retry ${attempt + 1}/${node.retries} in ${delayMs}ms)`);
                    await sleep(delayMs, node.abortController?.signal);
                    if (node.closed) break;
                    continue;
                }

                if (transientError) {
                    node.warn(`Function invocation error[${err?.code || response?.status}]: ${fnNode.invocationUrl} ${fnNode.fnConfigSpec?.name} ${fnNode.fnState} - ${err.message}`);
                }
                break;
            }
        }
    } finally {
        node.counter--;
        getMetrics(fnNode.server).recordInvocation(
            fnNode,
            node.closed ? 'cancelled' : error ? 'error' : 'success',
            Date.now() - startedAt,
            retryCount,
        );
        if (!fnNode.redeploying) {
            const queued = node.counter > 1 ? `${node.counter}` : '';
            node.statusDebounced(error
                ? { fill: "red", shape: "dot", text: `${error.code ?? fnNode.fnInvocationStatus ?? 'error'} ${queued} ${fnNode.fnConfigSpec?.name}`.trim() }
                : { fill: "green", shape: "dot", text: queued });
        }
    }

    return { error, transientError, response };
};

module.exports = { invokeWithRetry };
