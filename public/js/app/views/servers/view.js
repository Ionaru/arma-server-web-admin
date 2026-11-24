var _ = require('underscore');
var Backbone = require('backbone');
var Marionette = require('marionette');
var dialogs = require('app/dialogs');

var FormView = require('app/views/servers/form');
var InfoView = require('app/views/servers/info');
var MissionsView = require('app/views/servers/missions/index');
var ModsListView = require('app/views/servers/mods/list');
var ParametersListView = require('app/views/servers/parameters/list');
var PlayersView = require('app/views/servers/players');
var tpl = require('tpl/servers/view.html');

module.exports = Marionette.View.extend({
    template: _.template(tpl),

    regions: {
        infoView: '#tab-info',
        missionsView: '#tab-missions',
        modsView: '#tab-mods',
        parametersView: '#parameters',
        playersView: '#tab-players',
        settingsView: '#settings'
    },

    events: {
        submit: 'save'
    },

    modelEvents: {
        change: 'serverChanged'
    },

    initialize: function (options) {
        this.missions = options.missions;
        this.mods = options.mods;
    },

    onRender: function () {
        this.showChildView('infoView', new InfoView({model: this.model}));
        this.showChildView('missionsView', new MissionsView({missions: this.missions, model: this.model}));
        this.showChildView('modsView', new ModsListView({collection: this.mods, server: this.model}));
        this.showChildView('parametersView', new ParametersListView({model: this.model}));
        this.showChildView('playersView', new PlayersView({model: this.model}));
        this.showChildView('settingsView', new FormView({model: this.model}));
    },

    serverChanged: function () {
        // A running server's state is pushed every 5 s and its pid on start and stop; re-rendering
        // the editable tabs on those would wipe unsaved edits, so only the status views follow them.
        if (this.model.hasConfigChange()) {
            this.serverUpdated();
        } else {
            this.statusUpdated();
        }
    },

    statusUpdated: function () {
        this.getChildView('infoView').render();
        this.getChildView('playersView').render();
    },

    serverUpdated: function () {
        this.getChildView('infoView').render();
        this.getChildView('modsView').render();
        this.getChildView('parametersView').render();
        this.getChildView('playersView').render();
        this.getChildView('settingsView').render();
    },

    save: function (e) {
        e.preventDefault();
        var self = this;
        var oldId = this.model.get('id');
        var data = this.getChildView('settingsView').serialize();
        _.extend(data, this.getChildView('missionsView').serialize());
        _.extend(data, this.getChildView('modsView').serialize());
        _.extend(data, this.getChildView('parametersView').serialize());
        this.model.save(data, {
            success: function () {
                var newId = self.model.get('id');
                if (oldId !== newId) {
                    Backbone.history.navigate('#servers/' + newId, true);
                } else {
                    self.serverUpdated();
                }
            },
            error: function (model, response) {
                dialogs.alert('error', 'Error', 'An error occurred, please consult the logs');
            }
        });
    }
});
