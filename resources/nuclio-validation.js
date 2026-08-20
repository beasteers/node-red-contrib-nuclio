(function(root, factory) {
    const validation = factory();
    if (typeof module === 'object' && module.exports) module.exports = validation;
    if (root) root.NUCLIO_VALIDATION = validation;
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function() {
    const functionNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

    const validateFunctionName = (name) => {
        if (typeof name !== 'string' || !name.trim()) return 'Function name is required';
        const value = name;
        if (value.length > 63) return 'Function name must be 63 characters or fewer';
        if (!functionNamePattern.test(value)) {
            return 'Function name must use lowercase letters, numbers, and hyphens, and start and end with a letter or number';
        }
        return null;
    };

    const validateSourcePath = (sourceType, path) => {
        if (!['image', 'git', 'archive'].includes(sourceType)) return null;
        if (typeof path !== 'string' || !path.trim()) return `${sourceType} source path is required`;
        if (/[\s\u0000-\u001f\u007f]/.test(path)) return `${sourceType} source path must not contain whitespace or control characters`;
        return null;
    };

    return Object.freeze({ validateFunctionName, validateSourcePath });
}));
