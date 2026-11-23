require('should');

var Backbone = require('backbone');

var Server = require('../../public/js/app/models/server.js');

var fixture = function () {
    return {
        id: 'Smoke-Server',
        title: 'Smoke Server',
        port: 2302,
        mods: [],
        missions: [],
        parameters: [],
        state: null
    };
};

// Registers a change listener, runs `action` and returns what hasConfigChange() reported inside
// each change event. The listener must run exactly `times` times.
var recordInChange = function (model, action, times) {
    var seen = [];

    model.on('change', function () {
        seen.push(model.hasConfigChange());
    });

    action();

    seen.length.should.eql(times === undefined ? 1 : times);

    return seen;
};

describe('Server model hasConfigChange', function () {
    it('is false on a fresh model that was never set', function () {
        new Server(fixture()).hasConfigChange().should.be.false();
    });

    it('is false when state arrives from null', function () {
        var model = new Server(fixture());
        var seen = recordInChange(model, function () {
            model.set({state: {name: 'Smoke Server', players: []}});
        });

        seen[0].should.be.false();
    });

    it('is false when only pid changes', function () {
        var model = new Server(fixture());
        var seen = recordInChange(model, function () {
            model.set({pid: 4242});
        });

        seen[0].should.be.false();
    });

    it('is false when pid and state change together', function () {
        var model = new Server(fixture());
        var seen = recordInChange(model, function () {
            model.set({pid: 4242, state: {name: 'Smoke Server', players: [{name: 'Alpha'}]}});
        });

        seen[0].should.be.false();
    });

    it('is false for each of two consecutive state-only sets', function () {
        var model = new Server(fixture());
        var seen = recordInChange(model, function () {
            model.set({state: {name: 'Smoke Server', players: [{name: 'Alpha'}]}});
            model.set({state: {name: 'Smoke Server', players: [{name: 'Alpha'}, {name: 'Bravo'}]}});
        }, 2);

        seen[0].should.be.false();
        seen[1].should.be.false();
    });

    it('is true when a configuration field changes', function () {
        var model = new Server(fixture());
        var seen = recordInChange(model, function () {
            model.set({port: 2303});
        });

        seen[0].should.be.true();
    });

    it('is true when status and configuration change together', function () {
        var model = new Server(fixture());
        var seen = recordInChange(model, function () {
            model.set({state: {name: 'Smoke Server', players: []}, mods: ['@smoke_mod']});
        });

        seen[0].should.be.true();
    });

    var configChanges = {
        missions: {missions: [{name: 'smoke.Altis', difficulty: 'veteran'}]},
        parameters: {parameters: ['-smoke']},
        'a field absent from the defaults': {motd: 'Hello'},
        'title and id': {title: 'Renamed', id: 'Renamed'}
    };

    Object.keys(configChanges).forEach(function (name) {
        it('is true when ' + name + ' changes', function () {
            var model = new Server(fixture());
            var seen = recordInChange(model, function () {
                model.set(configChanges[name]);
            });

            seen[0].should.be.true();
        });
    });

    describe('through a collection merge, as the socket push does', function () {
        var Servers = Backbone.Collection.extend({model: Server});

        it('tells status-only, configuration and identical pushes apart', function () {
            var collection = new Servers([fixture()]);
            var model = collection.get('Smoke-Server');
            var seen = [];

            model.on('change', function () {
                seen.push(model.hasConfigChange());
            });

            var statusOnly = fixture();
            statusOnly.state = {name: 'Smoke Server', players: []};

            collection.set([statusOnly]);
            seen.should.eql([false]);

            var withPort = JSON.parse(JSON.stringify(statusOnly));
            withPort.port = 2303;

            collection.set([withPort]);
            seen.should.eql([false, true]);

            // The same data again must not fire change at all.
            collection.set([JSON.parse(JSON.stringify(withPort))]);
            seen.should.eql([false, true]);
        });
    });
});

describe('Server model statusAttributes', function () {
    it('lists pid and state', function () {
        Server.prototype.statusAttributes.should.eql(['pid', 'state']);
    });
});
