var _ = require('underscore');
var Marionette = require('marionette');
var dialogs = require('app/dialogs');

var tpl = require('tpl/mods/list_item.html');

var template = _.template(tpl);

module.exports = Marionette.ItemView.extend({
    tagName: 'tr',
    template: template,

    events: {
        'click .destroy': 'deleteMod'
    },

    deleteMod: function (event) {
        var self = this;
        dialogs.confirm({
            title: 'Are you sure?',
            text: 'The mod will be deleted from the server!',
            confirmText: 'Yes, delete it!',
            danger: true
        }, function () {
            self.model.destroy();
        });
    }
});
