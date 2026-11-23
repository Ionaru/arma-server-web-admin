var _ = require('underscore');
var CollectionView = require('app/views/collection-view');

var MissionRotation = require('app/models/mission_rotation');
var ListItemView = require('app/views/servers/missions/rotation/list_item');
var tpl = require('tpl/servers/missions/rotation/list.html');

module.exports = CollectionView.extend({
    childView: ListItemView,
    childViewContainer: 'tbody',
    template: _.template(tpl),

    events: {
        'click .add-mission': 'addMission'
    },

    addMission: function (e) {
        e.preventDefault();
        this.collection.add(new MissionRotation());
    }
});
