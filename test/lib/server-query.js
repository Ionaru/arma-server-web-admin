require('should');

var config = require('../../config.js');
var GameDig = require('gamedig').GameDig;
var gamedig = require('gamedig');

var Server = require('../../lib/server.js');

var S = {
    name: 'Op',
    map: 'Altis',
    maxplayers: 40,
    players: [{name: 'Alice', raw: {score: 12, time: 30}}],
    raw: {game: 'Co40 Op'}
};

// A promise the test settles by hand.
var deferred = function () {
    var d = {};
    d.promise = new Promise(function (resolve, reject) {
        d.resolve = resolve;
        d.reject = reject;
    });
    return d;
};

describe('Server query status', function () {
    var originalQuery;
    var originalGame;
    var calls;
    var server;
    var emits;

    // Replaces GameDig.query with a recorder; `impl` returns the promise for each call.
    var stubQuery = function (impl) {
        GameDig.query = function (options) {
            calls.push(options);
            return impl(options, calls.length);
        };
    };

    beforeEach(function () {
        originalQuery = GameDig.query;
        originalGame = config.game;
        calls = [];
        emits = 0;
        server = new Server(null, null, {title: 'test'});
        server.port = 2302;
        server.instance = {};
        server.on('state', function () {
            emits++;
        });
    });

    afterEach(function () {
        GameDig.query = originalQuery;
        config.game = originalGame;
    });

    describe('B1 success', function () {
        it('B1 should query 127.0.0.1 on the server port and store the result', async function () {
            stubQuery(function () {
                return Promise.resolve(S);
            });

            await server.queryStatus();

            calls.length.should.eql(1);
            calls[0].should.eql({type: 'arma3', host: '127.0.0.1', port: 2302});
            server.state.should.equal(S);
            emits.should.eql(1);
        });
    });

    describe('B2 failure', function () {
        it('B2 should set state to null and emit once when the query rejects', async function () {
            server.state = S;
            stubQuery(function () {
                return Promise.reject(new Error('timeout'));
            });

            await server.queryStatus();

            (server.state === null).should.be.true();
            emits.should.eql(1);
        });
    });

    describe('B3 no instance', function () {
        it('B3 should not query or emit and should resolve', async function () {
            server.instance = null;
            stubQuery(function () {
                return Promise.resolve(S);
            });

            await server.queryStatus();

            calls.length.should.eql(0);
            emits.should.eql(0);
        });
    });

    describe('B4 no overlap', function () {
        it('B4 should not start a second query while one is in flight for the same instance', async function () {
            var d = deferred();
            stubQuery(function () {
                return d.promise;
            });

            var first = server.queryStatus();
            var second = server.queryStatus();
            calls.length.should.eql(1);

            d.resolve(S);
            await Promise.all([first, second]);

            emits.should.eql(1);
            server.state.should.equal(S);

            stubQuery(function () {
                return Promise.resolve(S);
            });
            await server.queryStatus();
            calls.length.should.eql(2);
        });

        it('B4 should query again after the previous query has finished', async function () {
            var pending = [];
            stubQuery(function () {
                var d = deferred();
                pending.push(d);
                return d.promise;
            });

            var first = server.queryStatus();
            var second = server.queryStatus();
            pending.length.should.eql(1);
            pending[0].resolve(S);
            await Promise.all([first, second]);

            var third = server.queryStatus();
            pending.length.should.eql(2);
            pending[1].resolve(S);
            await third;
        });

        it('B4 should query again after a failed query', async function () {
            var pending = [];
            stubQuery(function () {
                var d = deferred();
                pending.push(d);
                return d.promise;
            });

            var first = server.queryStatus();
            pending[0].reject(new Error('timeout'));
            await first;

            var second = server.queryStatus();
            pending.length.should.eql(2);
            pending[1].resolve(S);
            await second;
        });
    });

    describe('B5 result for an old process', function () {
        it('B5a should drop a result that arrives after the instance is gone', async function () {
            var before = {marker: 'before'};
            server.state = before;
            var d = deferred();
            stubQuery(function () {
                return d.promise;
            });

            var p = server.queryStatus();
            server.instance = null;
            d.resolve(S);
            await p;

            server.state.should.equal(before);
            emits.should.eql(0);
        });

        it('B5a should drop a failure that arrives after the instance is gone', async function () {
            var before = {marker: 'before'};
            server.state = before;
            var d = deferred();
            stubQuery(function () {
                return d.promise;
            });

            var p = server.queryStatus();
            server.instance = null;
            d.reject(new Error('timeout'));
            await p;

            server.state.should.equal(before);
            emits.should.eql(0);
        });

        it('B5b should not let an old query block a new instance and should drop the old result', async function () {
            var S2 = {name: 'New', players: []};
            var pending = [];
            stubQuery(function () {
                var d = deferred();
                pending.push(d);
                return d.promise;
            });

            var i1 = {};
            var i2 = {};
            server.instance = i1;
            var first = server.queryStatus();

            server.instance = i2;
            var second = server.queryStatus();
            calls.length.should.eql(2);

            var before = server.state;
            pending[0].resolve(S);
            await first;
            (server.state === before).should.be.true();
            emits.should.eql(0);

            pending[1].resolve(S2);
            await second;
            server.state.should.equal(S2);
            emits.should.eql(1);
        });
    });

    describe('B6 game id map', function () {
        it('B6 should map panel game ids to gamedig 5 ids', function () {
            Server.queryTypes.should.eql({
                arma1: 'aaa',
                arma2: 'arma2',
                arma2oa: 'arma2',
                arma3: 'arma3',
                arma3_x64: 'arma3',
                cwa: 'acwa',
                ofp: 'ofcwc',
                ofpresistance: 'ofr'
            });
        });

        it('B6 should only map to game ids that exist in gamedig', function () {
            Object.keys(Server.queryTypes).forEach(function (key) {
                var id = Server.queryTypes[key];
                (typeof gamedig.games[id]).should.not.eql('undefined', key + ' -> ' + id);
            });
        });

        it('B6 should query with the mapped type for the configured game', async function () {
            config.game = 'ofp';
            stubQuery(function () {
                return Promise.resolve(S);
            });

            await server.queryStatus();

            calls.length.should.eql(1);
            calls[0].type.should.eql('ofcwc');
        });
    });
});
