const _ = require('lodash');
const crypto = require('crypto');


// treat missing/empty containers as equal (e.g. {} vs undefined vs ''), but never
// scalars - _.isEmpty(2) === true, which would swallow numeric/boolean changes
const isEmptyish = (x) => x == null || ((_.isObject(x) || _.isString(x)) && _.isEmpty(x));

function diff(a,b) {
    const r = {};
    _.each(a, function(v,k) {
        if(b?.[k] === v) return;
        let v2 = _.isObject(v) ? diff(v, b?.[k]) : v;
        if(_.isObject(v2) && _.isEmpty(v2)) return;
        if(isEmptyish(v) && isEmptyish(b?.[k])) return;
        r[k] = v2;
    });
    return r;
}

function merge(...args) {
    return _.mergeWith(...args, function(a, b) {
        if (_.isArray(b)) {
            return b;
        }
    });
}

// keys that would walk into (or overwrite) the prototype chain instead of the
// object itself - a path like `__proto__.polluted` would otherwise pollute
// Object.prototype
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Secret paths historically omitted the `spec.` prefix in the editor. Keep
// accepting those paths while making the generated Nuclio spec unambiguous.
// Metadata paths are already rooted at the function document and must not be
// rewritten.
const normalizeConfigPath = (path) => {
    const value = `${path || ''}`;
    return value.startsWith('spec.') || value.startsWith('metadata.')
        ? value
        : `spec.${value}`;
};

function nestedAssign(obj, path, value) {
    const normalizedPath = normalizeConfigPath(path);
    const keys = splitByDotWithEscape(normalizedPath);
    const lastKey = keys.pop();
    let current = obj;
    for (const key of [ ...keys, lastKey ]) {
        if (UNSAFE_KEYS.has(key)) throw new Error(`Unsafe key "${key}" in path "${path}"`);
    }
    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(current, key) || typeof current[key] !== 'object' || current[key] === null) {
            current[key] = {};
        }
        current = current[key];
    }
    current[lastKey] = value;
}

// Return a copy with configured secret paths replaced, so admin/status
// responses never expose credential-backed values. Paths use the same escaped
// dot notation as nestedAssign (for example, `spec.env.0.value`).
function redactPaths(obj, paths, replacement = '[redacted]') {
    if (obj == null || typeof obj !== 'object') return obj;
    const redacted = _.cloneDeep(obj);
    for (const path of paths || []) {
        if (!path) continue;
        const keys = splitByDotWithEscape(normalizeConfigPath(path));
        if (keys.some(key => UNSAFE_KEYS.has(key))) continue;
        const lastKey = keys.pop();
        let current = redacted;
        for (const key of keys) {
            if (current == null || typeof current !== 'object') {
                current = null;
                break;
            }
            current = current[key];
        }
        if (current && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, lastKey)) {
            current[lastKey] = replacement;
        }
    }
    return redacted;
}


// debounce with a hard ceiling so rapid status churn still renders periodically
const debounced = (fn, delay, maxWait) => _.debounce(fn, delay, { maxWait });

const parseIntFallback = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
};

// Node-RED setting resolution: node config (literal or env-typed) -> built-in
// default. Environment values must be selected explicitly with typedInput.
const numSetting = (RED, node, config, field, fallback) => {
    const raw = config[field];
    if (raw !== undefined && raw !== null && raw !== '') {
        const value = Number(
            RED.util.evaluateNodeProperty(raw, config[`${field}Type`] || 'num', node),
        );
        if (Number.isFinite(value) && value >= 0) return Math.trunc(value);
    }
    return fallback;
};

const boolSetting = (RED, node, config, field, fallback) => {
    const raw = config[field];
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = RED.util.evaluateNodeProperty(raw, config[`${field}Type`] || 'bool', node);
    return value === true || value === 'true';
};

const stripTrailingSlash = (url) => typeof url === 'string' ? url.replace(/\/+$/, '') : url;


const asString = (value) => {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function splitByDotWithEscape(str) {
    return str.split(/(?<!\\)\./).map(part => part.replace(/\\\./g, '.'));
}


// Deterministic JSON: object keys sorted recursively, array order preserved
// (it's meaningful, e.g. env vars). Same logical config -> same string.
const stableStringify = (value) => {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
};

const hashConfig = (value) => crypto.createHash('sha256').update(stableStringify(value)).digest('hex');


// Exponential backoff for invoke retries: base * 2^(attempt-1), capped. A
// numeric Retry-After (seconds) wins when it's larger - also capped, so a
// bogus or hostile header can't stall a flow.
const RETRY_BACKOFF_MAX_MS = 10000;
const RETRY_AFTER_MAX_MS = 30000;
const retryBackoff = (attempt, baseMs, retryAfter) => {
    const backoffMs = Math.min(baseMs * 2 ** (attempt - 1), RETRY_BACKOFF_MAX_MS);
    const retryAfterMs = Number.parseFloat(retryAfter) * 1000;
    return (Number.isFinite(retryAfterMs) && retryAfterMs > backoffMs)
        ? Math.min(retryAfterMs, RETRY_AFTER_MAX_MS)
        : backoffMs;
};


// Transient failure classification — shared across invoke retries, deploy
// error handling, and reconcile-step backoff so a single change propagates.
const TRANSIENT_ERR_CODES = Object.freeze(['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']);
const TRANSIENT_HTTP_STATUSES = Object.freeze([429, 502, 503, 504]);
const TRANSIENT_ERR_CODE_SET = new Set(TRANSIENT_ERR_CODES);
const TRANSIENT_HTTP_STATUS_SET = new Set(TRANSIENT_HTTP_STATUSES);
const isTransientErrorCode = (code) => TRANSIENT_ERR_CODE_SET.has(code);
const isTransientHttpStatus = (status) => TRANSIENT_HTTP_STATUS_SET.has(status);
const isTransientError = (err) => isTransientErrorCode(err?.code) || isTransientHttpStatus(err?.response?.status);

module.exports = {
    diff, merge,
    debounced,
    parseIntFallback,
    numSetting,
    boolSetting,
    stripTrailingSlash,
    asString,
    splitByDotWithEscape,
    normalizeConfigPath,
    nestedAssign,
    redactPaths,
    stableStringify,
    hashConfig,
    retryBackoff,
    RETRY_BACKOFF_MAX_MS,
    RETRY_AFTER_MAX_MS,
    TRANSIENT_ERR_CODES,
    TRANSIENT_HTTP_STATUSES,
    isTransientErrorCode,
    isTransientHttpStatus,
    isTransientError,
};
