var _ = require('lodash');

var Discord = require('./discord');

var Settings = function (config) {
    this.config = config;
};

Settings.prototype.getPublicSettings = function () {
    var settings = _.pick(this.config, ['game', 'path', 'type']);

    // A derived boolean, never the raw config.discord: this object is broadcast over socket.io to
    // every connected browser, and config.discord holds the bot token.
    settings.discordEnabled = Discord.isConfigured(this.config.discord);

    return settings;
};

module.exports = Settings;
