var $ = require('jquery');
var _ = require('underscore');
var Marionette = require('marionette');
var Ladda = require('ladda');

var tpl = require('tpl/missions/upload.html');

module.exports = Marionette.ItemView.extend({
    template: _.template(tpl),

    events: {
        'submit form': 'submit'
    },

    submit: function (event) {
        event.preventDefault();

        var self = this;
        var $form = this.$el.find('form');

        var files = $form.find(':file').get(0).files;
        if (!files || files.length === 0) {
            return;
        }

        var $uploadBtn = $form.find('button[type=submit]');
        var laddaBtn = Ladda.create($uploadBtn.get(0));
        laddaBtn.start();

        $.ajax({
            url: '/api/missions',
            type: 'POST',
            data: new FormData($form.get(0)),
            processData: false,
            contentType: false,
            dataType: 'json',
            success: function (data) {
                laddaBtn.stop();
                self.render();
            },
            error: function () {
                laddaBtn.stop();
            }
        });
    }
});
