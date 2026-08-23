const AUTH_TYPES = new Set(['none', 'basic', 'bearer']);

// These headers are either controlled by the client or affect the transport
// itself. Allowing a flow to replace them would make requests ambiguous or
// allow the project/namespace scope to be bypassed.
const RESERVED_HEADERS = new Set([
    'connection',
    'content-length',
    'content-type',
    'host',
    'transfer-encoding',
    'x-nuclio-function-namespace',
    'x-nuclio-project-name',
    'x-nuclio-project-namespace',
]);

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const buildAuthHeaders = ({
    authType = 'none',
    username = '',
    password = '',
    token = '',
    requestHeaders = [],
} = {}) => {
    if (!AUTH_TYPES.has(authType)) {
        throw new Error(`Unknown authentication mode "${authType}"`);
    }

    const headers = {};
    for (const entry of requestHeaders || []) {
        const name = `${entry?.name || ''}`.trim();
        if (!name) continue;
        if (!HEADER_NAME.test(name)) throw new Error(`Invalid request header name "${name}"`);
        const normalizedName = name.toLowerCase();
        if (RESERVED_HEADERS.has(normalizedName)) {
            throw new Error(`Request header "${name}" is reserved`);
        }
        if (authType !== 'none' && normalizedName === 'authorization') {
            throw new Error('Authorization must be configured through the authentication mode');
        }
        headers[name] = `${entry?.value ?? ''}`;
    }

    if (authType === 'basic') {
        if (!username || !password) throw new Error('Basic authentication requires a username and password');
        headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    } else if (authType === 'bearer') {
        if (!token) throw new Error('Bearer authentication requires a token');
        headers.Authorization = `Bearer ${token}`;
    }

    return headers;
};

module.exports = {
    AUTH_TYPES,
    RESERVED_HEADERS,
    buildAuthHeaders,
};
