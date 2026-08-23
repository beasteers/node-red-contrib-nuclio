(function(root, factory) {
    const metadata = factory();
    if (typeof module === 'object' && module.exports) module.exports = metadata;
    if (root) root.NUCLIO_RUNTIME_METADATA = metadata;
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function() {
    return Object.freeze([
        { value: 'python:3.12', base: 'python', label: 'Python 3.12', language: 'python', handler: 'main:handler' },
        { value: 'python:3.11', base: 'python', label: 'Python 3.11', language: 'python', handler: 'main:handler' },
        { value: 'python:3.10', base: 'python', label: 'Python 3.10', language: 'python', handler: 'main:handler' },
        { value: 'python:3.9', base: 'python', label: 'Python 3.9', language: 'python', handler: 'main:handler' },
        { value: 'golang', base: 'golang', label: 'Go', language: 'go', handler: 'main:Handler' },
        { value: 'java', base: 'java', label: 'Java', language: 'java', handler: 'EmptyHandler' },
        { value: 'dotnetcore', base: 'dotnetcore', label: '.NET Core (amd64 only)', language: 'csharp', handler: 'nuclio:empty', architectures: ['amd64'] },
        { value: 'nodejs', base: 'nodejs', label: 'Node.js', language: 'javascript', handler: 'handler:handler' },
        { value: 'shell', base: 'shell', label: 'Shell', language: 'shell', handler: 'main.sh:handler' },
    ]);
}));
