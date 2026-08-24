(function(root, factory) {
    const credentialList = factory();
    if (typeof module === 'object' && module.exports) module.exports = credentialList;
    if (root) root.NUCLIO_CREDENTIAL_LIST = credentialList;
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function() {
    const PASSWORD_SENTINEL = '__PWRD__';

    const parse = raw => {
        if (!raw || raw === PASSWORD_SENTINEL) return null;
        const entries = JSON.parse(raw);
        if (!Array.isArray(entries)) throw new Error('Credential entries must be a list');
        return entries;
    };

    const getEntries = (node, fallback, field) => {
        const stored = parse(node?.credentials?.[field]);
        return stored || (Array.isArray(fallback) ? fallback : []);
    };

    const sanitize = entries => entries.map(entry => entry?.type === 'cred'
        ? { ...entry, value: PASSWORD_SENTINEL }
        : { ...entry });

    const saveEntries = (node, field, entries, normalizeName = name => name) => {
        const existing = parse(node?.credentials?.[field]) || [];
        const existingByName = new Map(existing
            .filter(entry => entry?.type === 'cred' && entry.name)
            .map(entry => [normalizeName(entry.name), entry]));
        const merged = entries.map(entry => {
            if (entry?.type !== 'cred' || entry.value !== PASSWORD_SENTINEL) return { ...entry };
            const oldEntry = existingByName.get(normalizeName(entry.name));
            return oldEntry ? { ...entry, value: oldEntry.value } : { ...entry };
        });
        const hasCredentialEntries = merged.some(entry => entry?.type === 'cred');
        const hasUnresolvedCredentials = merged.some(entry =>
            entry?.type === 'cred' && entry.value === PASSWORD_SENTINEL);

        node.credentials = node.credentials || {};
        if (hasCredentialEntries && !hasUnresolvedCredentials) {
            node.credentials[field] = JSON.stringify(merged);
        } else if (!hasCredentialEntries) {
            delete node.credentials[field];
        }

        return sanitize(merged);
    };

    return Object.freeze({
        PASSWORD_SENTINEL,
        getEntries,
        saveEntries,
        sanitize,
    });
}));
