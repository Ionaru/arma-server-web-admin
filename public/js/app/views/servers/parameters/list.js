var _ = require('underscore');
var CollectionView = require('app/views/collection-view');

var Parameter = require('app/models/parameter');
var Parameters = require('app/collections/parameters');
var ListItemView = require('app/views/servers/parameters/list_item');
var tpl = require('tpl/servers/parameters/list.html');

module.exports = CollectionView.extend({
    childView: ListItemView,
    childViewContainer: 'tbody',
    template: _.template(tpl),

    events: {
        'click .add-parameter': 'addParameter'
    },

    modelEvents: {
        change: 'serverChanged'
    },

    initialize: function (options) {
        this.collection = new Parameters();
        this.serverUpdated();
    },

    addParameter: function (e) {
        e.preventDefault();
        this.collection.add(new Parameter());
    },

    serialize: function () {
        return {
            parameters: this.collection.map(function (parameter) {
                return parameter.get('parameter');
            })
        };
    },

    serverChanged: function () {
        if (this.model.hasConfigChange()) {
            this.serverUpdated();
        }
    },

    serverUpdated: function () {
        this.collection.reset(this.model.get('parameters').map(function (parameter) {
            return new Parameter({
                parameter: parameter
            });
        }));
    }
});
