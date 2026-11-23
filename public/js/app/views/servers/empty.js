var _ = require('underscore');
var Marionette = require('marionette');

var tpl = require('tpl/servers/empty.html');

module.exports = Marionette.View.extend({
    tagName: 'tr',
    template: _.template(tpl)
});
