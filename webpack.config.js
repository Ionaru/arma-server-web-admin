var path = require('path');
var webpack = require('webpack');

module.exports = {
    mode: 'development',

    // Loaders are resolved from here, not from the working directory (the panel may be started from
    // anywhere, see "paths are relative to the working directory" in CLAUDE.md)
    context: __dirname,

    // Entry point for static analyzer
    entry: path.join(__dirname, 'public', 'js', 'app.js'),

    output: {
        // Where to build results
        path: path.join(__dirname, 'assets'),

        // Filename to use in HTML
        filename: 'bundle.js',

        // Path to use in HTML
        publicPath: '/'
    },

    resolve: {
        alias: {
            app: path.join(__dirname, 'public', 'js', 'app'),
            marionette: 'backbone.marionette',
            'sweet-alert': 'sweetalert',
            tpl: path.join(__dirname, 'public', 'js', 'tpl')
        }
    },

    plugins: [
        new webpack.ProvidePlugin({
            // The CommonJS/UMD build on purpose: require('underscore') resolves to the ES module build in
            // webpack 5, whose namespace object cannot be assigned to, and backbone.bootstrap-modal
            // assigns _.templateSettings on the global _ while it builds its template.
            _: 'underscore/underscore-umd.js',
            $: 'jquery',
            Backbone: 'backbone',
            jQuery: 'jquery'
        })
    ],

    module: {
        rules: [
            {test: /\.css$/, use: ['style-loader', 'css-loader']},
            // The templates are required as plain text for _.template
            {test: /\.html$/, type: 'asset/source'},
            // Glyphicons fonts, emitted as files next to the bundle
            {test: /\.(woff2?|ttf|eot|svg)$/, type: 'asset/resource'}
        ]
    },

    devtool: 'inline-source-map'
};
