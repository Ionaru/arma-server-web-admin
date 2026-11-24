var _ = require('underscore');
var Backbone = require('backbone');
var Marionette = require('marionette');
var bootstrap = require('bootstrap/dist/js/bootstrap.bundle');

var ModalView = require('app/views/modal');
var ServersListView = require('app/views/navigation/servers/list');
var SettingsView = require('app/views/settings');
var tpl = require('tpl/navigation.html');

module.exports = Marionette.View.extend({
    template: _.template(tpl),

    templateContext: function () {
        return {
            isActiveRoute: function (route) {
                return Backbone.history.fragment === route ? 'active' : '';
            }
        };
    },

    events: {
        'click #settings': 'settings'
    },

    initialize: function (options) {
        this.settings = options.settings;
        this.servers = options.servers;
        this.serversListView = new ServersListView({collection: this.servers});
        this.listenTo(Backbone.history, 'route', this.render);
    },

    // The template is replaced on every render: drop the Bootstrap instances of the old navbar first.
    onBeforeRender: function () {
        this.disposeBootstrap();
    },

    onBeforeDestroy: function () {
        this.disposeBootstrap();
    },

    disposeBootstrap: function () {
        var toggle = this.el.querySelector('.dropdown-toggle');
        var dropdown = toggle ? bootstrap.Dropdown.getInstance(toggle) : null;
        if (dropdown) {
            dropdown.dispose();
        }

        var collapseElement = this.el.querySelector('#navbar-collapse');
        var collapse = collapseElement ? bootstrap.Collapse.getInstance(collapseElement) : null;
        // Disposing mid-transition leaves Bootstrap's completion timer reading a nulled element (TypeError)
        if (collapse && !collapseElement.classList.contains('collapsing')) {
            collapse.dispose();
        }
    },

    onDomRefresh: function () {
        this.serversListView.setElement('#servers-list');
        this.serversListView.render();
    },

    settings: function (event) {
        event.preventDefault();
        var view = new SettingsView({model: this.settings});
        new ModalView({content: view, animate: true, cancelText: false}).open();
    }
});
