var _ = require('underscore');
var Backbone = require('backbone');
var Marionette = require('marionette');

var tpl = require('tpl/navigation/servers/list_item.html');

var template = _.template(tpl);

module.exports = Marionette.View.extend({
    tagName: 'li',
    template: template,

    templateContext: function () {
        return {
            isActive: Backbone.history.fragment === 'servers/' + this.model.get('id')
        };
    }
});
