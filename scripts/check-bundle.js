// One-shot webpack compile check: builds the frontend bundle into a temp directory and fails on
// any error. Uses only the Node API that webpack 1 and webpack 5 share.
var fs = require('fs');
var os = require('os');
var path = require('path');
var webpack = require('webpack');

var webpackConfig = require('../webpack.config.js');

var outputPath = fs.mkdtempSync(path.join(os.tmpdir(), 'arma-check-bundle-'));

var removeOutput = function () {
    try {
        fs.rmSync(outputPath, {recursive: true, force: true});
    } catch (e) {
        console.error('check-bundle: could not remove ' + outputPath + ': ' + e.message);
    }
};

var finish = function (code) {
    removeOutput();
    process.exitCode = code;
};

// Webpack 1 reports errors and warnings as strings, webpack 5 as objects with a message.
var describe = function (entry) {
    return entry && typeof entry === 'object' && entry.message ? entry.message : String(entry);
};

// Copy every nested object webpack's options defaulter writes into (all except the plugins array),
// so the original config object is not mutated.
var config = Object.assign({}, webpackConfig, {
    output: Object.assign({}, webpackConfig.output, {path: outputPath}),
    resolve: Object.assign({}, webpackConfig.resolve),
    module: Object.assign({}, webpackConfig.module)
});

webpack(config, function (err, stats) {
    if (err) {
        console.error('check-bundle: failed');
        console.error(err.stack || err);
        return finish(1);
    }

    var info = stats.toJson();

    if (stats.hasErrors()) {
        console.error('check-bundle: failed');
        (info.errors || []).forEach(function (error) {
            console.error(describe(error));
        });
        return finish(1);
    }

    var warnings = info.warnings || [];

    warnings.forEach(function (warning) {
        console.log('warning: ' + describe(warning));
    });

    console.log('check-bundle: ok (' + warnings.length + ' warnings)');
    finish(0);
});
