var _ = require('underscore');
var Marionette = require('marionette');

var tpl = require('tpl/login.html');

module.exports = Marionette.View.extend({
    template: _.template(tpl)
});
