var _ = require('lodash');
var async = require('async');
var crypto = require('crypto');
var fs = require('fs.extra');
var filesize = require('filesize');
var path = require('path');
var userhome = require('userhome');

var profiles = require('./profiles');

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
// arma-server appends -client after the whole -mod= list, so the command line can run past 5 KB.
// 65536 is above the 32,767-character Windows command-line limit.
var HEADER_BYTES = 65536;
// The command line sits in the first lines of the header; later lines are log output.
var HEADER_LINES = 10;
// Headless clients are started with a bare -client parameter; `@ace-client` and the like are not.
var CLIENT_PARAMETER = /(^|[\s"])-client(?=[\s"]|$)/im;
// Header reads are capped so a folder of hundreds of .rpt files is not opened all at once.
var HEADER_READ_LIMIT = 8;

// Windows paths are case-insensitive, so two spellings of one folder must collapse there.
var pathKey = function (folder) {
    return process.platform === 'win32' ? folder.toLowerCase() : folder;
};

var hasExtension = function (name, extensions) {
    return extensions.indexOf(path.extname(name).toLowerCase()) !== -1;
};

var isProfileLog = function (name) {
    return hasExtension(name, PROFILE_LOG_EXTENSIONS);
};

var acceptAll = function () {
    return true;
};

// Servers are added, edited and renamed at runtime, so the list is asked for on every use.
Logs.prototype.setServers = function (getServers) {
    this.getServers = getServers;
};

// Under wine a Windows drive path is a symlink below the prefix's dosdevices folder, and the host's
// path.resolve would treat `C:\...` as a relative name.
Logs.prototype.resolveProfiles = function (profilesFolder) {
    if (this.config.type !== 'wine') {
        return path.resolve(this.config.path, profilesFolder);
    }

    var drive = /^([A-Za-z]):(.*)$/.exec(profilesFolder);

    if (drive) {
        var parts = drive[2].split(/[\\/]+/).filter(Boolean);
        return path.join.apply(path, [userhome('.wine'), 'dosdevices', drive[1].toLowerCase() + ':'].concat(parts));
    }

    return path.resolve(this.config.path, profilesFolder.replace(/\\/g, '/'));
};

Logs.prototype.logDirectories = function () {
    var servers = (this.getServers && this.getServers()) || [];
    var entries = [];
    var byKey = {};
    var anyWithoutProfiles = false;
    var self = this;

    servers.forEach(function (server) {
        var profilesFolder = profiles.profilesPath(server.getParameters());

        if (profilesFolder === null) {
            anyWithoutProfiles = true;
            return;
        }

        var resolved = self.resolveProfiles(profilesFolder);
        var key = pathKey(resolved);

        if (!byKey[key]) {
            byKey[key] = {path: resolved, kind: 'profiles', servers: []};
            entries.push(byKey[key]);
        }

        byKey[key].servers.push(server.title);
    });

    var defaultPath = this.logsPath();

    if (defaultPath !== null &&
        (this.config.type === 'linux' || this.config.type === 'wine' || servers.length === 0 || anyWithoutProfiles)) {
        var resolvedDefault = path.resolve(defaultPath);

        if (!byKey[pathKey(resolvedDefault)]) {
            entries.push({path: resolvedDefault, kind: 'default', servers: []});
        }
    }

    return entries;
};

// The regular files among `names` in `folder`, with their size. Anything unreadable is skipped.
var statFiles = function (folder, names, callback) {
    async.map(names, function (name, cb) {
        var filePath = path.join(folder, name);

        fs.stat(filePath, function (err, stat) {
            if (err || !stat.isFile()) {
                return cb(null, null);
            }

            cb(null, {name: name, path: filePath, size: stat.size});
        });
    }, function (err, files) {
        callback(null, _.compact(files));
    });
};

// Regular files directly inside a folder. A missing folder, or a file in its place, lists nothing.
var listFolder = function (folder, accept, callback) {
    fs.readdir(folder, function (err, names) {
        if (err) {
            return callback(null, []);
        }

        statFiles(folder, names.filter(accept), callback);
    });
};

var listEntry = function (entry, callback) {
    if (entry.kind === 'default') {
        return listFolder(entry.path, acceptAll, callback);
    }

    fs.readdir(entry.path, function (err, names) {
        if (err) {
            return callback(null, []);
        }

        var hcFolders = names.filter(function (name) {
            return profiles.HEADLESS_CLIENT_NAME.test(name);
        });

        async.parallel([
            function (cb) {
                statFiles(entry.path, names.filter(isProfileLog), cb);
            },
            function (cb) {
                async.map(hcFolders, function (name, folderCb) {
                    listFolder(path.join(entry.path, name), isProfileLog, function (err, files) {
                        files.forEach(function (file) {
                            file.subfolder = name;
                        });
                        folderCb(null, files);
                    });
                }, cb);
            }
        ], function (err, results) {
            callback(null, results[0].concat(_.flatten(results[1])));
        });
    });
};

// Reads the start of an .rpt: the header holds the command line, which tells a headless client
// from a server. Only its first lines are searched, so a `-client` in the log body is ignored. Null
// when the file is empty or unreadable.
var rptRole = function (filePath, callback) {
    fs.open(filePath, 'r', function (err, fd) {
        if (err) {
            return callback(null);
        }

        // Unsafe is fine: only the bytesRead bytes that were filled are decoded.
        var buffer = Buffer.allocUnsafe(HEADER_BYTES);

        fs.read(fd, buffer, 0, HEADER_BYTES, 0, function (err, bytesRead) {
            fs.close(fd, function () {
                if (err || !bytesRead) {
                    return callback(null);
                }

                var text = buffer.toString('utf8', 0, bytesRead).split('\n').slice(0, HEADER_LINES).join('\n');
                callback(CLIENT_PARAMETER.test(text) ? 'HC' : 'server');
            });
        });
    });
};

// Every file the log view may serve, with the role its folder or name gives away. Telling an .rpt's
// role needs a header read, which is left to logFiles(), so resolving an id opens no file.
Logs.prototype.listLogFiles = function (callback) {
    var type = this.config.type;

    async.map(this.logDirectories(), function (entry, cb) {
        listEntry(entry, function (err, files) {
            cb(null, files.map(function (file) {
                var role = file.subfolder || null;

                if (!role && entry.kind === 'default' && type === 'linux' && /\.log$/i.test(file.name)) {
                    var capture = /_(HC_\d+)\.log$/.exec(file.name);
                    role = capture ? capture[1] : 'server';
                }

                return {
                    id: crypto.createHash('sha1').update(file.path).digest('hex').slice(0, 12) + '-' + file.name,
                    name: file.name,
                    path: file.path,
                    size: file.size,
                    formattedSize: filesize(file.size),
                    servers: entry.servers.slice(),
                    role: role
                };
            }));
        });
    }, function (err, groups) {
        callback(null, _.flatten(groups));
    });
};

Logs.prototype.logFiles = function (callback) {
    this.listLogFiles(function (err, files) {
        var unknownRpts = files.filter(function (file) {
            return file.role === null && hasExtension(file.name, ['.rpt']);
        });

        async.eachLimit(unknownRpts, HEADER_READ_LIMIT, function (file, cb) {
            rptRole(file.path, function (role) {
                file.role = role;
                cb();
            });
        }, function () {
            files.sort(function (a, b) {
                var byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());

                if (byName !== 0) {
                    return byName;
                }

                return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
            });

            callback(null, files);
        });
    });
};

// Files are addressed by id, not name: two folders can hold the same name. The listing used here
// leaves an .rpt's role unread, so the file it returns may have a null role.
Logs.prototype.getLogFile = function (id, callback) {
    this.listLogFiles(function (err, files) {
        if (err) {
            return callback(err);
        }

        callback(null, _.find(files, {id: id}) || null);
    });
};

Logs.prototype.readLogFile = function (filename, callback) {
    fs.readFile(filename, callback);
};

module.exports = Logs;
