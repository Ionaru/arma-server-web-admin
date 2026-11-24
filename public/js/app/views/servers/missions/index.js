var _ = require('underscore');
var Marionette = require('marionette');

var MissionRotations = require('app/collections/mission_rotations');
var AvailableListView = require('app/views/servers/missions/available/list');
var RotationListView = require('app/views/servers/missions/rotation/list');
var tpl = require('tpl/servers/missions/index.html');

module.exports = Marionette.View.extend({
    template: _.template(tpl),
    templateContext: function () {
        return {
            filterValue: this.filterValue
        };
    },

    regions: {
        availableView: '#available',
        rotationView: '#rotation'
    },

    events: {
        'keyup #filterMissions': 'updateFilter'
    },

    modelEvents: {
        change: 'serverChanged'
    },

    initialize: function (options) {
        this.missions = options.missions;
        this.filterValue = '';

        this.rotationCollection = new MissionRotations(this.model.get('missions'));

        var self = this;

        this.availableListView = new AvailableListView({collection: this.missions, filterValue: this.filterValue});
        this.availableListView.on('add', function (model) {
            self.rotationCollection.add([{
                name: model.get('name').replace('.pbo', '')
            }]);
        });
        this.rotationListView = new RotationListView({collection: this.rotationCollection});
    },

    onRender: function () {
        this.showChildView('availableView', this.availableListView);
        this.showChildView('rotationView', this.rotationListView);
    },

    updateFilter: function (event) {
        this.filterValue = event.target.value;
        this.availableListView.filterValue = this.filterValue;
        this.availableListView.filter();
    },

    serverChanged: function () {
        if (this.model.hasConfigChange()) {
            this.serverUpdated();
        }
    },

    serverUpdated: function () {
        this.rotationCollection.set(this.model.get('missions'));
    },

    serialize: function () {
        return {
            missions: this.rotationCollection.toJSON()
        };
    }
});
