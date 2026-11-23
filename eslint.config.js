const js = require('@eslint/js');
const globals = require('globals');

const rules = {
    'no-unused-vars': 'off',
    semi: ['error', 'always']
};

const nodeFiles = [
    'app.js',
    'webpack.config.js',
    'eslint.config.js',
    'config.js.example',
    'config.js',
    'lib/**/*.js',
    'routes/**/*.js',
    'scripts/**/*.js',
    'smoke/**/*.js'
];

module.exports = [
    {ignores: ['node_modules/**']},
    js.configs.recommended,
    {
        files: nodeFiles,
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: {...globals.node}
        },
        rules
    },
    {
        files: ['test/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: {...globals.node, ...globals.mocha}
        },
        rules
    },
    {
        // Bundled by webpack, kept to ES5/ES2015. The four globals below are the
        // ProvidePlugin keys in webpack.config.js.
        files: ['public/js/**/*.js'],
        languageOptions: {
            ecmaVersion: 2015,
            sourceType: 'commonjs',
            globals: {
                ...globals.browser,
                ...globals.commonjs,
                _: 'readonly',
                $: 'readonly',
                Backbone: 'readonly',
                jQuery: 'readonly'
            }
        },
        rules
    }
];
