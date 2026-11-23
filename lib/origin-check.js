// Refuses cross-origin state-changing requests, so a page on another site cannot use an admin's
// browser as a confused deputy. It is not authentication: a request with neither Sec-Fetch-Site nor
// Origin is not from a browser (curl, node clients) and passes. The algorithm is the one Go's
// http.CrossOriginProtection uses. The scheme is never compared, because behind a TLS proxy the
// panel cannot know it.

var SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

// A header counts as absent when it is missing or the empty string.
function getHeader(req, name) {
    var value = req && req.headers && req.headers[name];
    if (value === undefined || value === null || value === '') {
        return undefined;
    }

    return value;
}

// The opaque origin ('null' for a file: URL, for instance) must never match an allowed entry.
function isAllowedOrigin(config, origin) {
    var allowedOrigins = config && config.allowedOrigins;
    if (!Array.isArray(allowedOrigins)) {
        return false;
    }

    var requested;
    try {
        requested = new URL(origin).origin;
    } catch (e) {
        return false;
    }

    if (requested === 'null') {
        return false;
    }

    return allowedOrigins.some(function (entry) {
        if (typeof entry !== 'string') {
            return false;
        }

        try {
            return new URL(entry).origin === requested;
        } catch (e) {
            return false;
        }
    });
}

function check(config, req) {
    var origin = getHeader(req, 'origin');
    var fetchSite = getHeader(req, 'sec-fetch-site');

    if (origin !== undefined && isAllowedOrigin(config, origin)) {
        return true;
    }

    // Sent by browsers to HTTPS and localhost origins only, so over plain HTTP on a LAN name the
    // Origin and Host comparison below is what decides.
    if (fetchSite !== undefined) {
        return fetchSite === 'same-origin' || fetchSite === 'none';
    }

    if (origin === undefined) {
        return true;
    }

    var parsedOrigin;
    try {
        parsedOrigin = new URL(origin);
    } catch (e) {
        return false;
    }

    var host = getHeader(req, 'host');
    if (typeof host !== 'string') {
        return false;
    }

    // Normalise with the Origin's scheme so the default port is dropped and the case is folded.
    var normalisedHost;
    try {
        normalisedHost = new URL(parsedOrigin.protocol + '//' + host).host;
    } catch (e) {
        return false;
    }

    return parsedOrigin.host === normalisedHost;
}

// Header logic only; the method is the middleware's business. Never throws: engine.io calls
// allowRequest, and a failure here must refuse rather than crash.
function isAllowed(config, req) {
    try {
        return check(config, req);
    } catch (e) {
        return false;
    }
}

module.exports = function (config) {
    return function (req, res, next) {
        if (SAFE_METHODS.indexOf(req.method) !== -1 || isAllowed(config, req)) {
            return next();
        }

        res.status(403).json({error: 'Cross-origin request refused'});
    };
};

module.exports.isAllowed = isAllowed;
