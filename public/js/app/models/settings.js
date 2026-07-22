var Backbone = require('backbone');

module.exports = Backbone.Model.extend({
    defaults: {
        path: '',
        type: '',
        discordEnabled: false
    },
    urlRoot: '/api/settings'
});
