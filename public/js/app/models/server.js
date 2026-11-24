var $ = require('jquery');
var Backbone = require('backbone');

module.exports = Backbone.Model.extend({
    defaults: {
        additionalConfigurationOptions: '',
        admin_password: '',
        allowed_file_patching: 1,
        auto_start: false,
        battle_eye: false,
        file_patching: false,
        forcedDifficulty: '',
        max_players: null,
        mods: [],
        motd: '',
        number_of_headless_clients: 0,
        parameters: [],
        password: '',
        persistent: false,
        port: 2302,
        state: null,
        title: '',
        von: false,
        verify_signatures: false
    },
    urlRoot: '/api/servers/',
    // The runtime fields of lib/server.js toJSON; every other attribute is configuration. The server
    // page re-renders its editable tabs only for a configuration change (hasConfigChange), so a new
    // runtime field must be listed here or every status push wipes unsaved edits again.
    statusAttributes: ['pid', 'state'],

    // Call from a 'change' listener: outside one, changedAttributes() still holds the last change set.
    hasConfigChange: function () {
        var changed = this.changedAttributes();
        if (!changed) {
            return false;
        }
        var statusAttributes = this.statusAttributes;
        return Object.keys(changed).some(function (key) {
            return statusAttributes.indexOf(key) === -1;
        });
    },
    start: function (cb) {
        var self = this;
        $.ajax({
            url: '/api/servers/' + self.get('id') + '/start',
            type: 'POST',
            success: function (resp) {
                self.set('pid', resp.pid);

                if (cb) {
                    cb();
                }
            },
            error: function (err) {
                if (cb) {
                    cb(err);
                }
            }
        });
    },

    stop: function (cb) {
        var self = this;
        $.ajax({
            url: '/api/servers/' + self.get('id') + '/stop',
            type: 'POST',
            success: function (resp) {
                self.set('pid', resp.pid);

                if (cb) {
                    cb();
                }
            },
            error: function (err) {
                if (cb) {
                    cb(err);
                }
            }
        });
    }
});
