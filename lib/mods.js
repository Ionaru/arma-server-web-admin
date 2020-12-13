var events = require('events');
var fs = require('fs.extra');
var path = require('path');

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
    this.config = config;
    this.mods = [];
};

Mods.prototype = new events.EventEmitter();

Mods.prototype.delete = function (mod, cb) {
    var self = this;
    fs.rmrf(path.join(this.config.path, mod), function (err) {
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
