var $ = require('jquery');
var _ = require('underscore');
var Marionette = require('marionette');

var UploadView = require('app/views/missions/upload');
var ListView = require('app/views/missions/list');
var tpl = require('tpl/missions/index.html');

module.exports = Marionette.View.extend({
    template: _.template(tpl),
    templateContext: function () {
        return {
            filterValue: this.filterValue
        };
    },

    regions: {
        uploadView: '#upload',
        listView: '#list'
    },

    events: {
        'click #refresh': 'refresh',
        'keyup #filterMissions': 'updateFilter'
    },

    initialize: function () {
        this.filterValue = '';
    },

    updateFilter: function (event) {
        this.filterValue = event.target.value;
        var listView = this.getChildView('listView');
        listView.filterValue = this.filterValue;
        listView.filter();
    },

    onRender: function () {
        this.showChildView('uploadView', new UploadView());
        this.showChildView('listView', new ListView({collection: this.options.missions, filterValue: this.filterValue}));
    },

    refresh: function (event) {
        event.preventDefault();
        $.ajax({
            url: '/api/missions/refresh',
            type: 'POST',
            success: function (resp) {

            },
            error: function (resp) {

            }
        });
    }
});
