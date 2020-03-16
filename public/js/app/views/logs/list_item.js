var _ = require('underscore');
var Marionette = require('marionette');
var sweetAlert = require('sweet-alert');

var tpl = require('tpl/logs/list_item.html');

var template = _.template(tpl);

module.exports = Marionette.ItemView.extend({
    tagName: 'tr',
    template: template,

    events: {
        'click .destroy': 'deleteLog'
    },

    deleteLog: function (event) {
        var self = this;
        sweetAlert({
                title: 'Are you sure?',
                text: 'The log will be deleted from the server!',
                type: 'warning',
                showCancelButton: true,
                confirmButtonClass: 'btn-danger',
                confirmButtonText: 'Yes, delete it!'
            },
            function () {
                self.model.destroy();
            });
    }
});
