(function(root, factory) {
    const parser = factory();
    if (typeof module === 'object' && module.exports) module.exports = parser;
    if (root) root.NUCLIO_SOURCE_PARSER = parser;
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function() {
    const SOURCE_TYPE_LABELS = {
        sourceCode: 'Source code',
        image: 'Image',
        git: 'Git',
        archive: 'Archive',
        advanced: 'Advanced configuration',
    };

    // Scalar lookup that mirrors the server's escaped-dot path convention.
    // Returns the value of the first key that appears at exactly parentPath,
    // unquoting simple YAML scalars. Comment text after the value is dropped.
    const yamlScalarInPath = (text, parentPath, key) => {
        const stack = [];
        const lines = `${text || ''}`.split(/\r?\n/);
        for (const line of lines) {
            const match = line.match(/^(\s*)([A-Za-z0-9_.-]+):\s*(.*?)\s*$/);
            if (!match) continue;
            const indent = match[1].replace(/\t/g, '    ').length;
            while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();
            const currentPath = stack.map(item => item.key);
            let value = match[3].replace(/\s+#.*$/, '').trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            if (match[2] === key && currentPath.join('.') === parentPath.join('.')) return value;
            if (!value) stack.push({ key: match[2], indent });
        }
        return '';
    };

    // Infer the source selector state from the raw config YAML so legacy flows
    // (which predate the source selector fields) open with their settings
    // preserved. Git attributes live under `codeEntryAttributes`, not on the
    // build object itself.
    const sourceFromConfigCode = (text) => {
        const codeEntryType = yamlScalarInPath(text, ['spec', 'build'], 'codeEntryType');
        const normalizedType = codeEntryType === 'github' ? 'git' : codeEntryType;
        const gitAttributes = (key) => yamlScalarInPath(text, ['spec', 'build', 'codeEntryAttributes'], key);
        if (SOURCE_TYPE_LABELS[normalizedType]) {
            return {
                type: normalizedType,
                path: yamlScalarInPath(text, ['spec', 'build'], 'path'),
                branch: gitAttributes('branch'),
                tag: gitAttributes('tag'),
                reference: gitAttributes('reference'),
                username: gitAttributes('username'),
                workDir: gitAttributes('workDir'),
            };
        }
        if (codeEntryType || yamlScalarInPath(text, ['spec', 'build'], 'path')) return { type: 'advanced' };
        const image = yamlScalarInPath(text, ['spec'], 'image');
        return image ? { type: 'image', path: image } : { type: 'sourceCode' };
    };

    return Object.freeze({
        yamlScalarInPath,
        sourceFromConfigCode,
        SOURCE_TYPE_LABELS,
    });
}));
