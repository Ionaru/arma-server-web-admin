require('should');

var Settings = require('../../lib/settings.js');

describe('Settings', function () {
    describe('getPublicSettings()', function () {
        it('exposes game, path and type', function () {
            var settings = new Settings({game: 'arma3', path: '/arma', type: 'linux'});
            var pub = settings.getPublicSettings();
            pub.game.should.eql('arma3');
            pub.path.should.eql('/arma');
            pub.type.should.eql('linux');
        });

        it('reports discordEnabled true only when token and channelId are both set', function () {
            new Settings({discord: {token: 't', channelId: 'c'}})
                .getPublicSettings().discordEnabled.should.be.true();

            new Settings({discord: {token: 't'}})
                .getPublicSettings().discordEnabled.should.be.false();

            new Settings({}).getPublicSettings().discordEnabled.should.be.false();
        });

        it('never leaks the discord config or token', function () {
            var settings = new Settings({discord: {token: 'super-secret', channelId: 'c'}});
            var pub = settings.getPublicSettings();
            (pub.discord === undefined).should.be.true();
            JSON.stringify(pub).should.not.match(/super-secret/);
        });
    });
});
