var _ = require('underscore');
var CollectionView = require('app/views/collection-view');

var ListItemView = require('app/views/missions/list_item');
var tpl = require('tpl/missions/list.html');

var template = _.template(tpl);

module.exports = CollectionView.extend({
    childView: ListItemView,
    childViewContainer: 'tbody',
    template: template,

    initialize: function (options) {
        this.filterValue = options.filterValue;
    },

    viewFilter: function (view) {
        return view.model.get('name').toLowerCase().indexOf(this.filterValue.toLowerCase()) >= 0;
    }
});
