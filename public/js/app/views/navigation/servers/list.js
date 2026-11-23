var CollectionView = require('app/views/collection-view');

var ListItemView = require('app/views/navigation/servers/list_item');

module.exports = CollectionView.extend({
    tagName: 'ul',
    childView: ListItemView
});
