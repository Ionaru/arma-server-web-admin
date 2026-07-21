var $ = require('jquery');
var Backbone = require('backbone');

module.exports = Backbone.Model.extend({
    defaults: {
        enabled: false,
        days: [],
        time: '19:30',
        opServerId: null,
        opServerTitle: null,
        opServerMissing: false,
        running: false,
        loadFailed: null,
        lastError: null,
        lastSkipped: null,
        lastSkippedFormatted: null,
        nextRun: null,
        nextRunFormatted: null,
        timezone: null
    },

    url: '/api/op-mode',

    // A singleton resource with no id of its own. Without this Backbone would treat every save as
    // a create and POST it, but the API only accepts PUT.
    isNew: function () {
        return false;
    },

    run: function (cb) {
        $.ajax({
            url: '/api/op-mode/run',
            type: 'POST',
            success: function () {
                if (cb) {
                    cb();
                }
            },
            error: function (err) {
                if (cb) {
                    cb(err);
                }
            }
        });
    }
});
