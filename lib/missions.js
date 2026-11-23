var async = require('async');
var events = require('events');
var formatSize = require('./format-size');
var fs = require('fs');
var moveFile = require('./move-file');
var path = require('path');
var util = require('util');

var Missions = function (config) {
    events.EventEmitter.call(this);

    this.config = config;
    this.missions = [];

    this.updateMissions();
};

util.inherits(Missions, events.EventEmitter);

Missions.prototype.missionsPath = function () {
    return path.join(this.config.path, 'mpmissions');
};

Missions.prototype.missionPath = function (name) {
    return path.join(this.missionsPath(), name);
};

Missions.prototype.updateMissions = function (cb) {
    var self = this;
    fs.readdir(this.missionsPath(), function (err, files) {
        if (err) {
            console.log(err);

            if (cb) {
                return cb(err);
            }

            return;
        }

        async.map(files, function (filename, cb) {
            fs.stat(self.missionPath(filename), function (err, stat) {
                if (err) {
                    console.log(err);
                    return cb(err);
                }

                var filenameWithoutPbo = path.basename(filename, '.pbo');
                var worldName = path.extname(filenameWithoutPbo);
                var missionName = path.basename(filenameWithoutPbo, worldName);
                worldName = worldName.replace('.', '');

                cb(null, {
                    dateCreated: new Date(stat.ctime),
                    dateModified: new Date(stat.mtime),
                    missionName: missionName,
                    name: filename,
                    size: stat.size,
                    sizeFormatted: formatSize(stat.size),
                    worldName: worldName
                });
            });
        }, function (err, missions) {
            if (!err) {
                self.missions = missions;
                self.emit('missions', missions);
            }

            if (cb) {
                cb(err, missions);
            }
        });
    });
};

var decodeName = function (name) {
    try {
        return decodeURI(name);
    } catch (e) {
        return name;
    }
};

Missions.prototype.handleUpload = function (uploadedFile, cb) {
    // keep only the last path segment: decodeURI turns %5C into a backslash after the upload parser stripped the path (a separator on Windows); '/' is split too as a guard
    // a name that does not decode (100%.pbo) is used as sent: a throw here would be a 500, or kill the process when called from an fs callback
    var filename = decodeName(uploadedFile.originalname).split(/[/\\]/).pop().toLowerCase();
    var self = this;
    moveFile(uploadedFile.path, path.join(this.missionsPath(), filename), function (err) {
        self.updateMissions();

        if (cb) {
            cb(err);
        }
    });
};

Missions.prototype.delete = function (missionName, cb) {
    var self = this;

    // resolve the name only from the current listing, never join client input into a path
    var mission = this.missions.find(function (entry) {
        return entry.name === missionName;
    });

    if (!mission) {
        var notFound = new Error('Mission not found');
        notFound.status = 404;

        if (cb) {
            cb(notFound);
        }

        return;
    }

    fs.unlink(this.missionPath(mission.name), function (err) {
        self.updateMissions();

        if (cb) {
            cb(err);
        }
    });
};

module.exports = Missions;
