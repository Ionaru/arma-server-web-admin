require('should');
var http = require('http');
var express = require('express');
var request = require('supertest');

var originCheck = require('../../lib/origin-check.js');
var setupBasicAuth = require('../../lib/setup-basic-auth.js');

function H(headers) {
    return {headers: headers};
}

function check(title, config, headers, expected, behaviour) {
    it(behaviour + ': ' + title, function () {
        var result;
        (function () {
            result = originCheck.isAllowed(config, H(headers));
        }).should.not.throw();
        result.should.equal(expected);
    });
}

describe('lib/origin-check isAllowed', function () {
    describe('no browser headers (B1)', function () {
        check('only a Host header is allowed', {}, {host: 'panel.example:3000'}, true, 'B1');

        it('B1: a request without a headers object is allowed and does not throw', function () {
            var result;
            (function () {
                result = originCheck.isAllowed({}, {});
            }).should.not.throw();
            result.should.equal(true);
        });
    });

    describe('Sec-Fetch-Site same-origin (B2)', function () {
        check('wins over a host mismatch', {}, {
            host: '127.0.0.1:3000',
            origin: 'https://panel.example',
            'sec-fetch-site': 'same-origin'
        }, true, 'B2');
    });

    describe('Sec-Fetch-Site none (B3)', function () {
        check('is allowed', {}, {host: 'panel.example:3000', 'sec-fetch-site': 'none'}, true, 'B3');
    });

    describe('other Sec-Fetch-Site values (B4)', function () {
        check('cross-site is refused even when Origin and Host match', {}, {
            host: 'panel.example:3000',
            origin: 'http://panel.example:3000',
            'sec-fetch-site': 'cross-site'
        }, false, 'B4');
        check('same-site is refused even when Origin and Host match', {}, {
            host: 'panel.example:3000',
            origin: 'http://panel.example:3000',
            'sec-fetch-site': 'same-site'
        }, false, 'B4');
        check('cross-site without Origin is refused', {}, {
            host: 'panel.example:3000',
            'sec-fetch-site': 'cross-site'
        }, false, 'B4');
        check('an empty Sec-Fetch-Site counts as absent', {}, {
            host: 'panel.example:3000',
            origin: 'http://panel.example:3000',
            'sec-fetch-site': ''
        }, true, 'B4');
    });

    describe('Origin host equals Host (B5)', function () {
        check('a hostname with a port', {}, {host: 'panel.example:3000', origin: 'http://panel.example:3000'}, true, 'B5');
        check('an IPv4 address', {}, {host: '192.168.1.10:3000', origin: 'http://192.168.1.10:3000'}, true, 'B5');
        check('an IPv6 address', {}, {host: '[::1]:3000', origin: 'http://[::1]:3000'}, true, 'B5');
        check('the scheme is not compared', {}, {host: 'panel.example:3000', origin: 'https://panel.example:3000'}, true, 'B5');
    });

    describe('Origin host differs from Host (B6)', function () {
        check('another host is refused', {}, {host: 'panel.example:3000', origin: 'http://evil.example'}, false, 'B6');
        check('another port is refused', {}, {host: 'panel.example:3000', origin: 'http://panel.example:8080'}, false, 'B6');
        check('a host that only starts the same is refused', {}, {
            host: 'panel.example',
            origin: 'http://panel.example.evil.example'
        }, false, 'B6');
    });

    describe('unusable input (B7)', function () {
        check('Origin null is refused', {}, {host: 'panel.example:3000', origin: 'null'}, false, 'B7');
        check('an unparseable Origin is refused', {}, {host: 'panel.example:3000', origin: 'not a url'}, false, 'B7');
        check('a missing Host is refused', {}, {origin: 'http://panel.example:3000'}, false, 'B7');
        check('an unparseable Host is refused', {}, {host: 'bad host/', origin: 'http://panel.example:3000'}, false, 'B7');
    });

    describe('normalisation (B8)', function () {
        check('case and the default http port in Origin', {}, {host: 'panel.example', origin: 'http://PANEL.example:80'}, true, 'B8');
        check('the default http port in Host', {}, {host: 'panel.example:80', origin: 'http://panel.example'}, true, 'B8');
        check('the default https port in Host', {}, {host: 'panel.example:443', origin: 'https://panel.example'}, true, 'B8');
        check('case in Host', {}, {host: 'Panel.Example:3000', origin: 'http://panel.example:3000'}, true, 'B8');
    });

    describe('config.allowedOrigins (B9)', function () {
        var trusted = {allowedOrigins: ['https://panel.example']};

        check('a listed Origin is allowed despite a host mismatch', trusted, {
            host: '10.0.0.5:3000',
            origin: 'https://panel.example'
        }, true, 'B9');
        check('a listed Origin is allowed despite Sec-Fetch-Site cross-site', trusted, {
            host: '10.0.0.5:3000',
            origin: 'https://panel.example',
            'sec-fetch-site': 'cross-site'
        }, true, 'B9');
        check('an entry is compared by its normalised origin', {allowedOrigins: ['HTTPS://Panel.Example/']}, {
            host: '10.0.0.5:3000',
            origin: 'https://panel.example'
        }, true, 'B9');
        check('an Origin that is not listed is refused', {allowedOrigins: ['https://other.example']}, {
            host: '10.0.0.5:3000',
            origin: 'http://evil.example'
        }, false, 'B9');
        check('allowedOrigins that is not an array is ignored', {allowedOrigins: 'https://panel.example'}, {
            host: '10.0.0.5:3000',
            origin: 'https://panel.example'
        }, false, 'B9');
        check('invalid entries are skipped and the valid one still matches', {
            allowedOrigins: [42, null, 'not a url', 'https://panel.example']
        }, {
            host: '10.0.0.5:3000',
            origin: 'https://panel.example'
        }, true, 'B9');
        check('an allowed origin never matches the literal null', {allowedOrigins: ['file:///x', 'null']}, {
            host: 'panel.example',
            origin: 'null'
        }, false, 'B9');
    });

    describe('missing config (B10)', function () {
        it('B10: an undefined config refuses a mismatching Origin and does not throw', function () {
            var result;
            (function () {
                result = originCheck.isAllowed(undefined, H({host: 'a', origin: 'http://evil.example'}));
            }).should.not.throw();
            result.should.equal(false);
        });

        it('B10: an undefined config allows a request without Origin and does not throw', function () {
            var result;
            (function () {
                result = originCheck.isAllowed(undefined, H({host: 'a'}));
            }).should.not.throw();
            result.should.equal(true);
        });
    });
});

describe('lib/origin-check middleware', function () {
    var reached;

    function makeApp() {
        var app = express();
        app.use(originCheck({}));
        app.all('/{*splat}', function (req, res) {
            reached = true;
            res.status(200).json({ok: true});
        });
        return app;
    }

    beforeEach(function () {
        reached = false;
    });

    describe('safe methods (B11)', function () {
        ['get', 'head', 'options'].forEach(function (method) {
            it('B11: ' + method.toUpperCase() + ' with a foreign Origin reaches the handler', async function () {
                var res = await request(makeApp())[method]('/x').set('Origin', 'http://evil.example');
                res.status.should.equal(200);
                reached.should.equal(true);
            });
        });

        it('B11: GET with Sec-Fetch-Site cross-site reaches the handler', async function () {
            await request(makeApp()).get('/x').set('Sec-Fetch-Site', 'cross-site').expect(200);
            reached.should.equal(true);
        });
    });

    describe('refused requests (B12)', function () {
        it('B12: POST with a foreign Origin answers 403 with the JSON error', async function () {
            var res = await request(makeApp()).post('/x').set('Origin', 'http://evil.example');
            res.status.should.equal(403);
            res.headers['content-type'].should.match(/json/);
            res.body.should.eql({error: 'Cross-origin request refused'});
            reached.should.equal(false);
        });

        it('B12: DELETE with Sec-Fetch-Site cross-site answers 403', async function () {
            var res = await request(makeApp()).delete('/x').set('Sec-Fetch-Site', 'cross-site');
            res.status.should.equal(403);
            res.body.should.eql({error: 'Cross-origin request refused'});
            reached.should.equal(false);
        });

        it('B12: PUT with Origin null answers 403', async function () {
            var res = await request(makeApp()).put('/x').set('Origin', 'null');
            res.status.should.equal(403);
            res.body.should.eql({error: 'Cross-origin request refused'});
            reached.should.equal(false);
        });

        it('B12: PATCH with a foreign Origin answers 403', async function () {
            var res = await request(makeApp()).patch('/x').set('Origin', 'http://evil.example');
            res.status.should.equal(403);
            reached.should.equal(false);
        });
    });

    describe('allowed requests (B13)', function () {
        it('B13: POST without Origin reaches the handler', async function () {
            await request(makeApp()).post('/x').expect(200);
            reached.should.equal(true);
        });

        it('B13: POST with an Origin whose host equals Host reaches the handler', async function () {
            await request(makeApp())
                .post('/x')
                .set('Host', 'panel.example:3000')
                .set('Origin', 'http://panel.example:3000')
                .expect(200);
            reached.should.equal(true);
        });

        it('B13: POST with Sec-Fetch-Site same-origin reaches the handler', async function () {
            await request(makeApp()).post('/x').set('Sec-Fetch-Site', 'same-origin').expect(200);
            reached.should.equal(true);
        });
    });
});

describe('lib/origin-check socket.io handshake (B15)', function () {
    var server;
    var io;

    // Built from both functions the way app.js does it.
    function start(config) {
        server = http.createServer();
        io = require('socket.io')(server, {
            allowRequest: function (req, callback) {
                try {
                    callback(null, originCheck.isAllowed(config, req) && setupBasicAuth.isAuthorized(config, req));
                } catch (e) {
                    callback(null, false);
                }
            }
        });
    }

    beforeEach(function () {
        start({});
    });

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

    it('B15: a handshake with a foreign Origin answers 403', async function () {
        await request(server)
            .get('/socket.io/?EIO=4&transport=polling')
            .set('Origin', 'http://evil.example')
            .expect(403);
    });

    it('B15: a handshake without Origin answers 200 with a sid', async function () {
        var res = await request(server).get('/socket.io/?EIO=4&transport=polling').expect(200);
        res.text.should.startWith('0{"sid":');
    });

    it('B15: a handshake whose Origin host equals Host answers 200', async function () {
        await request(server)
            .get('/socket.io/?EIO=4&transport=polling')
            .set('Host', 'panel.example:3000')
            .set('Origin', 'http://panel.example:3000')
            .expect(200);
    });

    it('B15: a handshake with Sec-Fetch-Site cross-site answers 403', async function () {
        await request(server)
            .get('/socket.io/?EIO=4&transport=polling')
            .set('Sec-Fetch-Site', 'cross-site')
            .expect(403);
    });
});
