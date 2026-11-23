var _ = require('underscore');
var Marionette = require('marionette');

var tpl = require('tpl/settings.html');

module.exports = Marionette.View.extend({
    template: _.template(tpl),

    modelEvents: {
        change: 'render'
    },

    templateContext: {
        isTypeChecked: function (type) {
            return this.type === type ? 'checked' : '';
        }
    }
});
