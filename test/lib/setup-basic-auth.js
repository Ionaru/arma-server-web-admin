require('should');
var http = require('http');
var request = require('supertest');

var setupBasicAuth = require('../../lib/setup-basic-auth.js');

function B(user, pass) {
    return 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
}

function reqWith(authorization) {
    var headers = {};
    if (authorization !== undefined) {
        headers.authorization = authorization;
    }
    return {headers: headers};
}

describe('lib/setup-basic-auth isAuthorized', function () {
    describe('not configured (B1)', function () {
        it('B1: an empty config is authorized without a header', function () {
            setupBasicAuth.isAuthorized({}, reqWith()).should.equal(true);
        });

        it('B1: empty username and password is authorized without a header', function () {
            setupBasicAuth.isAuthorized({auth: {username: '', password: ''}}, reqWith()).should.equal(true);
        });
    });

    describe('single user (B2)', function () {
        var config = {auth: {username: 'admin', password: 'p:w'}};

        it('B2: the right credentials, with a colon in the password, are authorized', function () {
            setupBasicAuth.isAuthorized(config, reqWith(B('admin', 'p:w'))).should.equal(true);
        });

        it('B2: a wrong password is refused', function () {
            setupBasicAuth.isAuthorized(config, reqWith(B('admin', 'p'))).should.equal(false);
        });

        it('B2: a username with different case is refused', function () {
            setupBasicAuth.isAuthorized(config, reqWith(B('Admin', 'p:w'))).should.equal(false);
        });

        it('B2: a missing header is refused', function () {
            setupBasicAuth.isAuthorized(config, reqWith()).should.equal(false);
        });

        it('B2: a Bearer header is refused', function () {
            setupBasicAuth.isAuthorized(config, reqWith('Bearer x')).should.equal(false);
        });

        it('B2: a malformed Basic header is refused', function () {
            setupBasicAuth.isAuthorized(config, reqWith('Basic !!!')).should.equal(false);
        });

        it('B2: Basic credentials without a colon are refused', function () {
            var header = 'Basic ' + Buffer.from('nocolon').toString('base64');
            setupBasicAuth.isAuthorized(config, reqWith(header)).should.equal(false);
        });
    });

    describe('several users (B3)', function () {
        var config = {auth: [{username: 'a', password: '1'}, {username: 'b', password: '2'}]};

        it('B3: the second user with the right password is authorized', function () {
            setupBasicAuth.isAuthorized(config, reqWith(B('b', '2'))).should.equal(true);
        });

        it('B3: a user with another user\'s password is refused', function () {
            setupBasicAuth.isAuthorized(config, reqWith(B('a', '2'))).should.equal(false);
        });

        it('B3: an empty array is configured and refuses everyone', function () {
            setupBasicAuth.isAuthorized({auth: []}, reqWith(B('a', '1'))).should.equal(false);
        });
    });

    describe('fail closed on a bad config (B7)', function () {
        it('B7: a non-string configured password refuses and does not throw', function () {
            var config = {auth: {username: 'admin', password: 1234}};
            var result;
            (function () {
                result = setupBasicAuth.isAuthorized(config, reqWith(B('x', 'y')));
            }).should.not.throw();
            result.should.equal(false);
        });

        it('B7: a user with a non-string password is skipped, the others still work', function () {
            var config = {auth: [{username: 'a', password: 'good'}, {username: 'b', password: 1234}]};
            var good;
            var bad;
            (function () {
                good = setupBasicAuth.isAuthorized(config, reqWith(B('a', 'good')));
                bad = setupBasicAuth.isAuthorized(config, reqWith(B('x', 'y')));
            }).should.not.throw();
            good.should.equal(true);
            bad.should.equal(false);
        });
    });

    describe('same rule as the middleware (B4)', function () {
        var configs = {
            'no auth': {},
            'empty object': {auth: {username: '', password: ''}},
            'single user': {auth: {username: 'admin', password: 'p:w'}},
            'several users': {auth: [{username: 'a', password: '1'}, {username: 'b', password: '2'}]},
            'empty array': {auth: []}
        };

        Object.keys(configs).forEach(function (name) {
            it('B4: ' + name + ': authorized without a header exactly when no middleware is added', function () {
                var uses = [];
                setupBasicAuth(configs[name], {
                    use: function (fn) {
                        uses.push(fn);
                    }
                });
                setupBasicAuth.isAuthorized(configs[name], reqWith()).should.equal(uses.length === 0);
            });
        });
    });
});

describe('lib/setup-basic-auth socket.io handshake', function () {
    var server;
    var io;

    function start(config) {
        server = http.createServer();
        // Built from isAuthorized the way app.js does it.
        io = require('socket.io')(server, {
            allowRequest: function (req, callback) {
                callback(null, setupBasicAuth.isAuthorized(config, req));
            }
        });
    }

    afterEach(function (done) {
        var finish = function () {
            done();
        };
        if (!io) {
            return finish();
        }
        io.close(function () {
            if (server && server.listening) {
                return server.close(finish);
            }
            finish();
        });
    });

    describe('with auth configured (B5)', function () {
        beforeEach(function () {
            start({auth: {username: 'admin', password: 'secret'}});
        });

        it('B5: a handshake without credentials answers 403', async function () {
            await request(server).get('/socket.io/?EIO=4&transport=polling').expect(403);
        });

        it('B5: a handshake with the right credentials answers 200 with a sid', async function () {
            var res = await request(server)
                .get('/socket.io/?EIO=4&transport=polling')
                .set('Authorization', B('admin', 'secret'))
                .expect(200);
            res.text.should.startWith('0{"sid":');
        });
    });

    describe('without auth configured (B6)', function () {
        beforeEach(function () {
            start({});
        });

        it('B6: a handshake without credentials answers 200', async function () {
            await request(server).get('/socket.io/?EIO=4&transport=polling').expect(200);
        });
    });
});
