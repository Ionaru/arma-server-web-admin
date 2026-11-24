var _ = require('underscore');
var CollectionView = require('app/views/collection-view');

var Server = require('app/models/server');
var AddServerView = require('app/views/servers/form');
var ModalView = require('app/views/modal');
var EmptyView = require('app/views/servers/empty');
var ListItemView = require('app/views/servers/list_item');
var tpl = require('tpl/servers/list.html');

var template = _.template(tpl);

module.exports = CollectionView.extend({
    childView: ListItemView,
    childViewContainer: 'tbody',
    template: template,

    emptyView: EmptyView,

    events: {
        'click #add-server': 'addServer'
    },

    addServer: function () {
        var view = new AddServerView({model: new Server(), servers: this.collection});
        new ModalView({content: view}).open();
    }
});
