const js = require('@eslint/js');

module.exports = [
    {
        ...js.configs.recommended,
        files: ['lib/**/*.js', 'test/**/*.js', 'scripts/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                require: 'readonly',
                module: 'writable',
                process: 'readonly',
                console: 'readonly',
                Buffer: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
                URL: 'readonly',
                __dirname: 'readonly',
            },
        },
        rules: {
            // `const { status, ...rest } = obj` is used to strip keys
            'no-unused-vars': ['error', { args: 'none', ignoreRestSiblings: true }],
        },
    },
];
