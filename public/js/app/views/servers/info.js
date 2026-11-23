var _ = require('underscore');
var Marionette = require('marionette');
var dialogs = require('app/dialogs');

var tpl = require('tpl/servers/info.html');

module.exports = Marionette.LayoutView.extend({
    template: _.template(tpl),

    events: {
        'click #start': 'start',
        'click #stop': 'stop'
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
            event.preventDefault();

            self.model.stop(function (err) {
                if (err) {
                    dialogs.alert('error', 'Error', err.responseText);
                    return;
                }

                self.render();
            });
        });
    }
});
