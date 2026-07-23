var https = require('https');

var pkg = require('../package.json');

// The User-Agent Discord requires; a missing or invalid one gets the request blocked by Cloudflare
// (JSON error 40333). Format is mandated by the API reference: "DiscordBot ($url, $versionNumber)".
var userAgent = 'DiscordBot (https://github.com/Ionaru/arma-server-web-admin, ' + pkg.version + ')';

var Discord = function (config) {
    this.config = config || {};

    // Injectable so tests never open a socket.
    this.request = https.request;
};

// One definition of "configured", shared with lib/settings.js so the UI flag and the actual
// behaviour can never disagree.
Discord.isConfigured = function (config) {
    return !!(config && config.token && config.channelId);
};

Discord.prototype.isConfigured = function () {
    return Discord.isConfigured(this.config);
};

// send(content, cb). cb(err) on: not configured, transport error, or non-2xx. cb(null) on success.
// Never throws: a Discord outage must never look like an op mode failure to the caller.
Discord.prototype.send = function (content, cb) {
    cb = cb || function () {};

    if (!this.isConfigured()) {
        return cb(new Error('Discord is not configured'));
    }

    // Discord rejects content over 2000 characters with a 400. An operator-set title or an error
    // message could push a message over, so clip it rather than lose the whole notification on the
    // one run that needed attention.
    if (content && content.length > 2000) {
        content = content.slice(0, 1997) + '...';
    }

    var payload = JSON.stringify({
        content: content,
        // The op server title is operator-editable and interpolated into every message, so a title
        // containing @everyone or a role mention would otherwise ping the channel. This feature
        // never mentions anyone; one choke point covers every current and future caller.
        allowed_mentions: {parse: []}
    });

    var options = {
        hostname: 'discord.com',
        path: '/api/v10/channels/' + this.config.channelId + '/messages',
        method: 'POST',
        headers: {
            'Authorization': 'Bot ' + this.config.token,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'User-Agent': userAgent
        }
    };

    var req = this.request(options, function (res) {
        var body = '';

        res.on('data', function (chunk) {
            body += chunk;
        });

        res.on('end', function () {
            if (res.statusCode >= 200 && res.statusCode < 300) {
                return cb(null);
            }

            cb(new Error('Discord responded ' + res.statusCode + ': ' + body));
        });
    });

    req.on('error', function (err) {
        cb(err);
    });

    req.write(payload);
    req.end();
};

module.exports = Discord;
