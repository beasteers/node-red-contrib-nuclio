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

const getInvocationUrlOptions = (func, node = {}) => {
    const server = node.server || {};
    const preference = INVOCATION_URL_PREFERENCES.has(server.invocationUrlPreference)
        ? server.invocationUrlPreference
        : 'service';
    const externalProtocol = server.externalInvocationProtocol === 'http' ? 'http' : 'https';
    const serviceUrl = serviceInvocationUrl(node.name, server);
    const serviceUrls = serviceUrl ? [serviceUrl] : [];
    const internals = (func?.status?.internalInvocationUrls || [])
        .map(url => normalizeInvocationUrl(url, 'http'))
        .filter(Boolean);
    const externals = (func?.status?.externalInvocationUrls || [])
        .map(url => normalizeInvocationUrl(url, externalProtocol))
        .filter(Boolean);
    const ordered = preference === 'service'
        ? serviceUrls
        : preference === 'internal'
            ? internals
            : externals;
    const urls = [...new Set(ordered)];
    return {
        preference,
        urls: urls.length ? urls : (node.invocationUrl ? [node.invocationUrl] : []),
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
    serviceInvocationUrl,
};
