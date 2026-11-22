// Preload module (node --require) for the smoke run. app.js requires './config' and lib/server.js
// requires '../config.js'; both resolve against the repo directory, not process.cwd(), so the only
// way to point them at a temp config without touching <repo>/config.js is to redirect the resolver.
var Module = require('module');
var path = require('path');

var repoRoot = path.resolve(__dirname, '..');
var smokeConfig = process.env.SMOKE_CONFIG;

if (smokeConfig) {
    var originalResolveFilename = Module._resolveFilename;

    Module._resolveFilename = function (request, parent) {
        if (typeof request === 'string' && parent && parent.filename && (request.charAt(0) === '.' || path.isAbsolute(request))) {
            var resolved = path.resolve(path.dirname(parent.filename), request);

            if (resolved === path.join(repoRoot, 'config') || resolved === path.join(repoRoot, 'config.js')) {
                return smokeConfig;
            }
        }

        return originalResolveFilename.apply(this, arguments);
    };
}
