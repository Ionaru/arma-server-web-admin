var basicAuth = require('express-basic-auth');

function getBasicAuthUsers(configAuth) {
    var basicAuthUsers = {};
    if (configAuth.username && configAuth.password) {
        configAuth = [configAuth];
    }

    configAuth.forEach(function (user) {
        basicAuthUsers[user.username] = user.password;
    });

    return basicAuthUsers;
}

// The one rule for "is auth on", shared by the middleware and isAuthorized so they cannot disagree.
function isAuthConfigured(config) {
    if (!config.auth) {
        return false;
    }

    return !!(config.auth.username || config.auth.password || Array.isArray(config.auth));
}

// Reads `Basic <base64 user:password>` from the request, splitting on the first colon only so a
// password may contain one. Returns undefined for a missing, non-Basic or malformed header.
function parseBasicHeader(req) {
    var header = req.headers && req.headers.authorization;
    if (typeof header !== 'string') {
        return undefined;
    }

    var match = /^ *basic +([A-Za-z0-9._~+/-]+=*) *$/i.exec(header);
    if (!match) {
        return undefined;
    }

    var credentials = /^([^:]*):(.*)$/.exec(Buffer.from(match[1], 'base64').toString());
    if (!credentials) {
        return undefined;
    }

    return {name: credentials[1], pass: credentials[2]};
}

// For code that runs before Express (engine.io answers /socket.io/ on the http.Server), where the
// middleware cannot be used. Compares like express-basic-auth's default authorizer: safeCompare for
// both parts, combined with a bitwise & so neither comparison is skipped.
function isAuthorized(config, req) {
    if (!isAuthConfigured(config)) {
        return true;
    }

    var credentials = parseBasicHeader(req);
    if (!credentials) {
        return false;
    }

    var users = getBasicAuthUsers(config.auth);
    for (var username in users) {
        // A non-string password (a number, or a missing one) would make safeCompare throw, and
        // engine.io calls allowRequest without a try, so skip it and fail closed.
        if (typeof users[username] !== 'string') {
            continue;
        }

        if (basicAuth.safeCompare(credentials.name, username) & basicAuth.safeCompare(credentials.pass, users[username])) {
            return true;
        }
    }

    return false;
}

module.exports = function (config, app) {
    if (!isAuthConfigured(config)) {
        return;
    }

    app.use(basicAuth({
        challenge: true,
        users: getBasicAuthUsers(config.auth)
    }));
};

module.exports.isAuthorized = isAuthorized;
