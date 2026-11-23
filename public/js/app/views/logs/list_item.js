var _ = require('underscore');
var Marionette = require('marionette');
var dialogs = require('app/dialogs');

var tpl = require('tpl/logs/list_item.html');

var template = _.template(tpl);

module.exports = Marionette.View.extend({
    tagName: 'tr',
    template: template,

    events: {
        'click .destroy': 'deleteLog'
    },

    templateContext: function () {
        var role = this.model.get('role');
        var roleLabel = role;
        var roleClass = 'label-info';

        if (role === 'server') {
            roleLabel = 'Server';
            roleClass = 'label-primary';
        } else if (role === 'HC') {
            roleLabel = 'Headless client';
        }

        return {
            encodedId: encodeURIComponent(this.model.id),
            roleClass: roleClass,
            roleLabel: roleLabel,
            serverTitles: this.model.get('servers').join(', ')
        };
    },

    deleteLog: function (event) {
        var self = this;
        dialogs.confirm({
            title: 'Are you sure?',
            text: 'The log will be deleted from the server!',
            confirmText: 'Yes, delete it!',
            danger: true
        }, function () {
            self.model.destroy();
        });
    }
});
