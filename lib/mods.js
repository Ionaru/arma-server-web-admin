var events = require('events');
var fs = require('fs');
var path = require('path');
var util = require('util');

const getMods = (directory, mods = []) => {

    const collectionFolderCharacter = '!';
    const modFolderCharacter = '@';

    const directoryEntities = fs.readdirSync(directory, {withFileTypes: true});

    for (const directoryEntity of directoryEntities) {
        if (!directoryEntity.isDirectory()) {
            continue;
        }

        if (directoryEntity.name.startsWith(modFolderCharacter)) {
            mods.push(path.join(directory, directoryEntity.name));
        }

        if (directoryEntity.name.startsWith(collectionFolderCharacter)) {
            mods.push(...getMods(path.join(directory, directoryEntity.name)));
        }
    }

    return mods;
};

var Mods = function (config) {
    events.EventEmitter.call(this);

    this.config = config;
    this.mods = [];
};

util.inherits(Mods, events.EventEmitter);

Mods.prototype.delete = function (mod, cb) {
    var self = this;

    // resolve the name only from the current listing, never join client input into a path
    var listed = this.mods.find(function (entry) {
        return entry.name === mod;
    });

    if (!listed) {
        var notFound = new Error('Mod not found');
        notFound.status = 404;
        return cb(notFound);
    }

    // the listed name is already the full path (config.path included)
    // maxRetries and retryDelay keep the Windows retry for transient locks (EBUSY, ENOTEMPTY).
    fs.rm(listed.name, {recursive: true, force: true, maxRetries: 3, retryDelay: 100}, function (err) {
        cb(err);

        if (!err) {
            self.updateMods();
        }
    });
};

Mods.prototype.updateMods = function () {
    var self = this;

    const mods = getMods(self.config.path).map((mod) => {
        return {name: mod};
    });
    self.mods = mods;
    self.emit('mods', mods);
};

module.exports = Mods;
