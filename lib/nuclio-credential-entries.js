const PASSWORD_SENTINEL = '__PWRD__';

const getCredentialEntries = (node, fallback, field) => {
    const raw = node.credentials?.[field];
    if (!raw || raw === PASSWORD_SENTINEL) return Array.isArray(fallback) ? fallback : [];

    let entries;
    try {
        entries = JSON.parse(raw);
    } catch (err) {
        throw new Error(`Could not parse ${field} credentials: ${err.message}`);
    }
    if (!Array.isArray(entries)) throw new Error(`${field} credentials must be a list`);
    return entries;
};

const resolveTypedValue = (RED, node, msg, entry) => {
    const type = entry.type || 'str';
    if (type === 'cred') {
        if (entry.value === PASSWORD_SENTINEL || entry.value === undefined || entry.value === null) {
            throw new Error(`Credential "${entry.name}" is not available`);
        }
        return entry.value;
    }
    return RED.util.evaluateNodeProperty(entry.value ?? '', type, node, msg);
};

module.exports = {
    PASSWORD_SENTINEL,
    getCredentialEntries,
    resolveTypedValue,
};
