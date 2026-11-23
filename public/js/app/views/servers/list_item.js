var _ = require('underscore');
var Marionette = require('marionette');
var dialogs = require('app/dialogs');

var tpl = require('tpl/servers/list_item.html');

var template = _.template(tpl);

module.exports = Marionette.ItemView.extend({
    tagName: 'tr',
    template: template,

    events: {
        'click .clone': 'clone',
        'click .delete': 'delete',
        'click .start': 'start',
        'click .stop': 'stop'
    },

    modelEvents: {
        change: 'serverUpdated'
    },

    clone: function (e) {
        var title = this.model.get('title') + ' Clone';
        var clone = this.model.clone();
        clone.set({id: null, title: title, auto_start: false});
        clone.save();
    },

    delete: function (event) {
        var self = this;
        dialogs.confirm({
            title: 'Are you sure?',
            text: 'Your server configuration will be deleted!',
            confirmText: 'Yes, delete it!',
            danger: true
        }, function () {
            self.model.destroy();
        });
    },

    start: function (event) {
        var self = this;
        event.preventDefault();
        this.model.start(function (err) {
            if (err) {
                dialogs.alert('error', 'Error', err.responseText);
                return;
            }

            self.render();
        });
    },

    stop: function (event) {
        var self = this;
        event.preventDefault();
        dialogs.confirm({
            title: 'Are you sure?',
            text: 'The server will stopped.',
            confirmText: 'Yes, stop it!',
            danger: false
        }, function () {
            self.model.stop(function (err) {
                if (err) {
                    dialogs.alert('error', 'Error', err.responseText);
                    return;
                }

                self.render();
            });
        });
    },

    serverUpdated: function (event) {
        this.render();
    }
});
