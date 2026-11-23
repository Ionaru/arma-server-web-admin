var fs = require('fs');
var path = require('path');
var stream = require('stream');

var DEFAULT_API_URL = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';
var DEFAULT_TIMEOUT = 30000;
var DEFAULT_DOWNLOAD_TIMEOUT = 600000;

// Downloads Steam Workshop files (legacy file items only: mods have no file_url) into a folder.
var SteamWorkshop = function (folder, options) {
    options = options || {};

    this.folder = folder;
    this.apiUrl = options.apiUrl || DEFAULT_API_URL;
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
    this.downloadTimeout = options.downloadTimeout || DEFAULT_DOWNLOAD_TIMEOUT;
};

function describe(err) {
    var message = err && err.message ? err.message : String(err);

    if (err && err.cause && err.cause.message) {
        message += ' (' + err.cause.message + ')';
    }

    return message;
}

function fail(message) {
    return Promise.reject(new Error(message));
}

// Wraps a failed fetch (network error, timeout) in an Error that says which request failed.
function request(url, init, what) {
    return fetch(url, init).catch(function (err) {
        throw new Error(what + ' failed: ' + describe(err));
    });
}

// The last path segment of the name Steam reports, so the file can never leave the folder.
function safeFilename(filename) {
    var name = String(filename || '').split(/[\\/]/).pop();

    return name === '' || name === '.' || name === '..' ? null : name;
}

SteamWorkshop.prototype.getFileDetails = function (id) {
    var body = new URLSearchParams({
        'format': 'json',
        'itemcount': '1',
        'publishedfileids[0]': String(id)
    });

    return request(this.apiUrl, {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: body.toString(),
        signal: AbortSignal.timeout(this.timeout)
    }, 'Steam Workshop details request').then(function (res) {
        if (!res.ok) {
            return fail('Steam Workshop details request failed: HTTP ' + res.status);
        }

        return res.text().catch(function (err) {
            throw new Error('Steam Workshop details request failed: ' + describe(err));
        });
    }).then(function (text) {
        var data;

        try {
            data = JSON.parse(text);
        } catch (e) {
            data = null;
        }

        var details = data && data.response && data.response.publishedfiledetails;

        if (!Array.isArray(details) || !details[0]) {
            return fail('No data found for Steam Workshop ID ' + id);
        }

        return details[0];
    });
};

SteamWorkshop.prototype.saveFile = function (url, dest) {
    var tmp = dest + '.download';

    return request(url, {
        signal: AbortSignal.timeout(this.downloadTimeout)
    }, 'Steam Workshop file download').then(function (res) {
        if (!res.ok) {
            return fail('Steam Workshop file download failed: HTTP ' + res.status);
        }

        if (!res.body) {
            return fail('Steam Workshop file download failed: empty response');
        }

        return stream.promises.pipeline(
            stream.Readable.fromWeb(res.body),
            fs.createWriteStream(tmp)
        ).then(function () {
            return fs.promises.rename(tmp, dest);
        }).catch(function (err) {
            // Never leave a partial file behind, and never touch an existing file at dest.
            return fs.promises.rm(tmp, {force: true}).then(function () {
                throw new Error('Steam Workshop file download failed: ' + describe(err));
            }, function () {
                throw new Error('Steam Workshop file download failed: ' + describe(err));
            });
        });
    });
};

// Calls cb(err) or cb(null, {filename, path}), once and asynchronously.
SteamWorkshop.prototype.downloadFile = function (id, cb) {
    var self = this;

    if (!/^\d+$/.test(String(id))) {
        return process.nextTick(cb, new Error('Not a valid Steam Workshop ID: ' + id));
    }

    this.getFileDetails(id).then(function (details) {
        if (details.result !== 1) {
            return fail('Steam Workshop item ' + id + ' not found (result ' + details.result + ')');
        }

        if (!details.file_url) {
            return fail('Steam Workshop item ' + id + ' has no downloadable file');
        }

        var filename = safeFilename(details.filename);

        if (!filename) {
            return fail('Steam Workshop item ' + id + ' has no file name');
        }

        var dest = path.join(self.folder, filename);

        return self.saveFile(details.file_url, dest).then(function () {
            return {filename: filename, path: dest};
        });
    }).then(function (result) {
        cb(null, result);
    }, function (err) {
        cb(err);
    });
};

module.exports = SteamWorkshop;
