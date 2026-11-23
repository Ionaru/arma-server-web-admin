var _ = require('underscore');
var Marionette = require('marionette');

var tpl = require('tpl/servers/players.html');

module.exports = Marionette.View.extend({
    template: _.template(tpl),
    templateContext: {
        players: function () {
            return _.sortBy(this.state.players, function (player) {
                return player.name;
            });
        }
    }
});
