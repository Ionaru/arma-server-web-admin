var path = require('path');

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
            tpl: path.join(__dirname, 'public', 'js', 'tpl')
        }
    },

    module: {
        rules: [
            {test: /\.css$/, use: ['style-loader', 'css-loader']},
            // The templates are required as plain text for _.template
            {test: /\.html$/, type: 'asset/source'},
            // Icon font (bootstrap-icons), emitted next to the bundle; the ?hash in its CSS is matched on the path alone
            {test: /\.(woff2?|ttf|eot|svg)$/, type: 'asset/resource'}
        ]
    },

    devtool: 'inline-source-map'
};
