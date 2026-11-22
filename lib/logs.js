var async = require('async');
var crypto = require('crypto');
var fs = require('fs.extra');
var filesize = require('filesize');
var path = require('path');
var userhome = require('userhome');

var profilesPath = require('./profiles').profilesPath;

var gamesLogFolder = {
    arma1: 'ArmA',
    arma2: 'ArmA 2',
    arma2oa: 'ArmA 2 OA',
    arma3: 'Arma 3',
    arma3_x64: 'Arma 3'
};

var Logs = function (config) {
    this.config = config;

    if (this.config.type === 'linux') {
        fs.mkdirp(this.logsPath());
    }
};

// The optional suffix keeps names apart when several processes of one server log in the same second.
Logs.generateLogFileName = function (suffix) {
    var dateStr = new Date().toISOString()
        .replace(/:/g, '-') // Replace time dividers with dash
        .replace(/T/, '_') // Remove date and time divider
        .replace(/\..+/, ''); // Remove milliseconds
    return 'arma3server_' + dateStr + (suffix ? '_' + suffix : '') + '.log';
};

Logs.prototype.delete = function (id, callback) {
    this.getLogFile(id, function (err, logFile) {
        if (err) {
            if (callback) {
                return callback(err);
            }
        } else {
            if (logFile && logFile.path) {
                fs.unlink(logFile.path, callback);
            } else {
                if (callback) {
                    return callback(new Error('File not found'));
                }
            }
        }
    });
};

Logs.prototype.generateLogFilePath = function (suffix) {
    return path.join(this.logsPath(), Logs.generateLogFileName(suffix));
};

Logs.prototype.logsPath = function () {
    if (this.config.type === 'linux') {
        return path.join(this.config.path, 'logs');
    }

    var gameLogFolder = gamesLogFolder[this.config.game];

    if (!gameLogFolder) {
        return null;
    }

    if (this.config.type === 'windows') {
        return userhome('AppData', 'Local', gameLogFolder);
    }

    if (this.config.type === 'wine') {
        var username = process.env.USER;
        return userhome('.wine', 'drive_c', 'users', username, 'Local Settings', 'Application Data', gameLogFolder);
    }

    return null;
};

// Profile folders hold much more than logs (configs, user profiles, caches), so only these
// extensions are listed from them.
var PROFILE_LOG_EXTENSIONS = ['.rpt', '.log', '.mdmp', '.bidmp'];
var HC_FOLDER = /^HC_\d+$/;
var HEADER_BYTES = 4096;
// Headless clients are started with a bare -client parameter; `@ace-client` and the like are not.
var CLIENT_PARAMETER = /(^|[\s"])-client(?=[\s"]|$)/im;

// Windows paths are case-insensitive, so two spellings of one folder must collapse there.
var pathKey = function (folder) {
    return process.platform === 'win32' ? folder.toLowerCase() : folder;
};

var hasExtension = function (name, extensions) {
    return extensions.indexOf(path.extname(name).toLowerCase()) !== -1;
};

// Servers are added, edited and renamed at runtime, so the list is asked for on every use.
Logs.prototype.setServers = function (getServers) {
    this.getServers = getServers;
};

Logs.prototype.logDirectories = function () {
    var servers = (this.getServers && this.getServers()) || [];
    var entries = [];
    var byKey = {};
    var anyWithoutProfiles = false;
    var self = this;

    servers.forEach(function (server) {
        var profiles = profilesPath(server.getParameters());

        if (profiles === null) {
            anyWithoutProfiles = true;
            return;
        }

        var resolved = path.resolve(self.config.path, profiles);
        var key = pathKey(resolved);

        if (!byKey[key]) {
            byKey[key] = {path: resolved, kind: 'profiles', servers: []};
            entries.push(byKey[key]);
        }

        byKey[key].servers.push(server.title);
    });

    var defaultPath = this.logsPath();

    if (defaultPath !== null &&
        (this.config.type === 'linux' || servers.length === 0 || anyWithoutProfiles)) {
        var resolvedDefault = path.resolve(defaultPath);

        if (!byKey[pathKey(resolvedDefault)]) {
            entries.push({path: resolvedDefault, kind: 'default', servers: []});
        }
    }

    return entries;
};

// Regular files directly inside a folder, with their size. Anything unreadable is skipped.
var listFolder = function (folder, accept, callback) {
    fs.readdir(folder, function (err, names) {
        if (err) {
            return callback(null, []);
        }

        var wanted = names.filter(accept);

        async.map(wanted, function (name, cb) {
            var filePath = path.join(folder, name);

            fs.stat(filePath, function (err, stat) {
                if (err || !stat.isFile()) {
                    return cb(null, null);
                }

                cb(null, {name: name, path: filePath, size: stat.size});
            });
        }, function (err, files) {
            callback(null, (files || []).filter(Boolean));
        });
    });
};

var listEntry = function (entry, callback) {
    if (entry.kind === 'default') {
        return listFolder(entry.path, function () {
            return true;
        }, callback);
    }

    var isLog = function (name) {
        return hasExtension(name, PROFILE_LOG_EXTENSIONS);
    };

    fs.readdir(entry.path, function (err, names) {
        if (err) {
            return callback(null, []);
        }

        var hcFolders = names.filter(function (name) {
            return HC_FOLDER.test(name);
        });

        async.map(hcFolders, function (name, cb) {
            var folder = path.join(entry.path, name);

            fs.stat(folder, function (err, stat) {
                if (err || !stat.isDirectory()) {
                    return cb(null, []);
                }

                listFolder(folder, isLog, function (err, files) {
                    files.forEach(function (file) {
                        file.subfolder = name;
                    });
                    cb(null, files);
                });
            });
        }, function (err, nested) {
            listFolder(entry.path, isLog, function (err, files) {
                callback(null, files.concat([].concat.apply([], nested || [])));
            });
        });
    });
};

// Reads the start of an .rpt: the header holds the command line, which tells a headless client
// from a server. Null when the file is empty or unreadable.
var rptRole = function (filePath, callback) {
    fs.open(filePath, 'r', function (err, fd) {
        if (err) {
            return callback(null);
        }

        var buffer = Buffer.alloc(HEADER_BYTES);

        fs.read(fd, buffer, 0, HEADER_BYTES, 0, function (err, bytesRead) {
            fs.close(fd, function () {
                if (err || !bytesRead) {
                    return callback(null);
                }

                var text = buffer.toString('utf8', 0, bytesRead);
                callback(CLIENT_PARAMETER.test(text) ? 'HC' : 'server');
            });
        });
    });
};

Logs.prototype.logFiles = function (callback) {
    var self = this;

    async.map(this.logDirectories(), function (entry, cb) {
        listEntry(entry, function (err, files) {
            async.map(files, function (file, fileCb) {
                var isRpt = path.extname(file.name).toLowerCase() === '.rpt';
                var finish = function (role) {
                    fileCb(null, {
                        id: crypto.createHash('sha1').update(file.path).digest('hex').slice(0, 12) + '-' + file.name,
                        name: file.name,
                        path: file.path,
                        size: file.size,
                        formattedSize: filesize(file.size),
                        servers: entry.servers.slice(),
                        role: role
                    });
                };

                if (file.subfolder) {
                    return finish(file.subfolder);
                }

                if (isRpt) {
                    return rptRole(file.path, finish);
                }

                var lower = file.name.toLowerCase();

                if (entry.kind === 'default' && self.config.type === 'linux' && /\.log$/.test(lower)) {
                    var match = /_(HC_\d+)\.log$/.exec(file.name);
                    return finish(match ? match[1] : 'server');
                }

                finish(null);
            }, cb);
        });
    }, function (err, groups) {
        var files = [].concat.apply([], groups || []);

        files.sort(function (a, b) {
            var byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());

            if (byName !== 0) {
                return byName;
            }

            return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
        });

        callback(null, files);
    });
};

// Files are addressed by id, not name: two folders can hold the same name.
Logs.prototype.getLogFile = function (id, callback) {
    this.logFiles(function (err, files) {
        if (err) {
            callback(err);
        } else {
            var validLogs = files.filter(function (file) {
                return file.id === id;
            });

            if (validLogs.length > 0) {
                callback(null, validLogs[0]);
            } else {
                callback(null, null);
            }
        }
    });
};

Logs.prototype.readLogFile = function (filename, callback) {
    fs.readFile(filename, callback);
};

module.exports = Logs;
