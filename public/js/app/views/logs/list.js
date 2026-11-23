var _ = require('underscore');
var CollectionView = require('app/views/collection-view');

var ListItemView = require('app/views/logs/list_item');
var tpl = require('tpl/logs/list.html');

var template = _.template(tpl);

module.exports = CollectionView.extend({
    childView: ListItemView,
    childViewContainer: 'tbody',
    template: template
});
