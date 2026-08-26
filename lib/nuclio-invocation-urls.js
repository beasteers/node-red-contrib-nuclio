const INVOCATION_URL_PREFERENCES = new Set(['service', 'internal', 'external']);

// Nuclio reports internal (cluster) and external URLs once ready. Service
// preference avoids container/pod IPs by constructing a stable hostname.
// The hostname varies by platform:
//   kubernetes: nuclio-{function}
//   docker:     nuclio-nuclio-{function}
const normalizeInvocationUrl = (value, defaultProtocol) => {
    if (typeof value !== 'string' || !value.trim()) return null;
    const url = value.trim();
    if (/^https?:\/\//i.test(url)) return url;
    if (url.startsWith('//')) return `${defaultProtocol}:${url}`;
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(url)) return null;
    return `${defaultProtocol}://${url}`;
};

const serviceInvocationUrl = (name, server = {}) => {
    if (typeof name !== 'string' || !name.trim()) return null;
    const template = typeof server.internalInvocationServiceHost === 'string'
        && server.internalInvocationServiceHost.trim()
        ? server.internalInvocationServiceHost.trim()
        : 'nuclio-{function}';
    const host = template.replace(/\{function\}/g, name.trim()).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (!host || /[\s/]/.test(host)) return null;
    return /:\d+$/.test(host) ? `http://${host}` : `http://${host}:8080`;
};

// A function may be triggered exclusively by NATS, Kafka, cron, or another
// non-HTTP trigger. In that case the dashboard can still report a service
// name, but it is not an invocation endpoint for this node. Older dashboard
// responses did not include the function spec, so retain the historical
// assumption when trigger metadata is absent.
const hasHttpTrigger = func => {
    if (typeof func?.httpTrigger === 'boolean') return func.httpTrigger;
    const triggers = func?.spec?.triggers;
    if (func?.spec?.disableDefaultHTTPTrigger === true
        && (!triggers || typeof triggers !== 'object')) return false;
    if (!triggers || typeof triggers !== 'object') return true;
    return Object.values(triggers).some(trigger => `${trigger?.kind || ''}`.toLowerCase() === 'http');
};

const getInvocationUrlOptions = (func, node = {}) => {
    const server = node.server || {};
    const preference = INVOCATION_URL_PREFERENCES.has(server.invocationUrlPreference)
        ? server.invocationUrlPreference
        : 'service';
    const externalProtocol = server.externalInvocationProtocol === 'http' ? 'http' : 'https';
    const httpTrigger = typeof func?.httpTrigger === 'boolean'
        ? func.httpTrigger
        : hasHttpTrigger(func);
    const serviceUrl = httpTrigger ? serviceInvocationUrl(node.name, server) : null;
    const serviceUrls = serviceUrl ? [serviceUrl] : [];
    const internals = httpTrigger
        ? (func?.status?.internalInvocationUrls || [])
            .map(url => normalizeInvocationUrl(url, 'http'))
            .filter(Boolean)
        : [];
    const externals = httpTrigger
        ? (func?.status?.externalInvocationUrls || [])
            .map(url => normalizeInvocationUrl(url, externalProtocol))
            .filter(Boolean)
        : [];
    const ordered = preference === 'service'
        ? serviceUrls
        : preference === 'internal'
            ? internals
            : externals;
    const urls = [...new Set(ordered)];
    return {
        preference,
        urls: urls.length ? urls : (httpTrigger && node.invocationUrl ? [node.invocationUrl] : []),
        httpTrigger,
        serviceUrls,
        internalUrls: internals,
        externalUrls: externals,
    };
};

const getInvocationUrls = (func, node = {}) => getInvocationUrlOptions(func, node).urls;

const getInvocationUrl = (func, node) => getInvocationUrls(func, node)[0];

module.exports = {
    getInvocationUrl,
    getInvocationUrlOptions,
    getInvocationUrls,
    hasHttpTrigger,
    serviceInvocationUrl,
};
