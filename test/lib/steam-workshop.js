require('should');
var fs = require('fs');
var http = require('http');
var os = require('os');
var path = require('path');

var SteamWorkshop = require('../../lib/steam-workshop.js');

describe('SteamWorkshop', function () {
    var parent;
    var folder;
    var server;
    var port;
    var requests;
    var routes;
    var hung;

    var listing = function () {
        return fs.readdirSync(folder).sort();
    };

    var detailsReply = function (entry) {
        return function (req, res) {
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({response: {result: 1, resultcount: 1, publishedfiledetails: [entry]}}));
        };
    };

    var okEntry = function (overrides) {
        return Object.assign({
            publishedfileid: '123',
            result: 1,
            filename: 'Co10_Escape.Altis.pbo',
            file_url: 'http://127.0.0.1:' + port + '/file/123'
        }, overrides || {});
    };

    var fileReply = function (status, body) {
        return function (req, res) {
            res.writeHead(status);
            res.end(body);
        };
    };

    var hang = function (req, res) {
        hung.push(res);
    };

    var workshop = function () {
        return new SteamWorkshop(folder, {
            apiUrl: 'http://127.0.0.1:' + port + '/details',
            timeout: 500,
            downloadTimeout: 500
        });
    };

    // Runs downloadFile, waits 50 ms after the first callback, and asserts it was called once.
    var download = function (id) {
        return new Promise(function (resolve, reject) {
            var calls = [];
            workshop().downloadFile(id, function (err, result) {
                calls.push({err: err, result: result});
                if (calls.length === 1) {
                    setTimeout(function () {
                        if (calls.length !== 1) {
                            return reject(new Error('cb called ' + calls.length + ' times'));
                        }
                        resolve(calls[0]);
                    }, 50);
                }
            });
        });
    };

    var expectError = function (outcome, pattern) {
        outcome.err.should.be.an.instanceOf(Error);
        outcome.err.message.should.match(pattern);
    };

    beforeEach(function (done) {
        parent = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-workshop-'));
        folder = path.join(parent, 'missions');
        fs.mkdirSync(folder);
        requests = [];
        routes = {};
        hung = [];

        server = http.createServer(function (req, res) {
            var chunks = [];
            req.on('data', function (c) {
                chunks.push(c);
            });
            req.on('end', function () {
                requests.push({
                    method: req.method,
                    url: req.url,
                    contentType: req.headers['content-type'],
                    body: Buffer.concat(chunks).toString('utf8')
                });
                var handler = routes[req.url];
                if (!handler) {
                    res.writeHead(404);
                    return res.end();
                }
                handler(req, res);
            });
        });
        server.listen(0, '127.0.0.1', function () {
            port = server.address().port;
            done();
        });
    });

    afterEach(function (done) {
        hung.forEach(function (res) {
            res.destroy();
        });
        server.closeAllConnections();
        server.close(function () {
            fs.rmSync(parent, {recursive: true, force: true});
            done();
        });
    });

    describe('B1: invalid ids', function () {
        ['', 'abc', '12a', undefined, '../1', '1 2'].forEach(function (id) {
            it('B1: rejects ' + JSON.stringify(id) + ' without a request or file', function () {
                var sync = true;
                var outcome;
                var p = new Promise(function (resolve, reject) {
                    var calls = 0;
                    workshop().downloadFile(id, function (err, result) {
                        calls++;
                        if (calls > 1) {
                            return;
                        }
                        (sync === false).should.be.true();
                        setTimeout(function () {
                            if (calls !== 1) {
                                return reject(new Error('cb called ' + calls + ' times'));
                            }
                            resolve({err: err, result: result});
                        }, 50);
                    });
                    sync = false;
                });
                return p.then(function (o) {
                    outcome = o;
                    outcome.err.should.be.an.instanceOf(Error);
                    outcome.err.message.should.equal('Not a valid Steam Workshop ID: ' + id);
                    requests.length.should.equal(0);
                    listing().should.eql([]);
                });
            });
        });

        it('B1: invokes the callback exactly once for an invalid id', function () {
            return download('abc').then(function (outcome) {
                outcome.err.message.should.equal('Not a valid Steam Workshop ID: abc');
            });
        });

        it('B1: accepts a number id and a digit string', function () {
            routes['/details'] = detailsReply(okEntry());
            routes['/file/123'] = fileReply(200, 'PBO-BYTES');
            return download(123).then(function (outcome) {
                (outcome.err === null || outcome.err === undefined).should.be.true();
                return download('123');
            }).then(function (outcome) {
                (outcome.err === null || outcome.err === undefined).should.be.true();
            });
        });
    });

    describe('B2: details request', function () {
        it('B2: POSTs a form-encoded body with the id', function () {
            routes['/details'] = detailsReply(okEntry());
            routes['/file/123'] = fileReply(200, 'PBO-BYTES');
            return download('123').then(function () {
                var first = requests[0];
                first.method.should.equal('POST');
                first.url.should.equal('/details');
                first.contentType.should.match(/^application\/x-www-form-urlencoded/);
                var params = new URLSearchParams(first.body);
                params.get('format').should.equal('json');
                params.get('itemcount').should.equal('1');
                params.get('publishedfileids[0]').should.equal('123');
            });
        });
    });

    describe('B3: success', function () {
        it('B3: stores the file and reports filename and path', function () {
            routes['/details'] = detailsReply(okEntry());
            routes['/file/123'] = fileReply(200, 'PBO-BYTES');
            return download('123').then(function (outcome) {
                (outcome.err === null || outcome.err === undefined).should.be.true();
                outcome.result.filename.should.equal('Co10_Escape.Altis.pbo');
                outcome.result.path.should.equal(path.join(folder, 'Co10_Escape.Altis.pbo'));
                listing().should.eql(['Co10_Escape.Altis.pbo']);
                fs.readFileSync(path.join(folder, 'Co10_Escape.Altis.pbo'), 'utf8').should.equal('PBO-BYTES');
            });
        });
    });

    describe('B4: name confined to the folder', function () {
        it('B4: keeps only the base name of a nested path', function () {
            routes['/details'] = detailsReply(okEntry({filename: 'mpmissions/Sub/Co10.Altis.pbo'}));
            routes['/file/123'] = fileReply(200, 'PBO-BYTES');
            return download('123').then(function (outcome) {
                (outcome.err === null || outcome.err === undefined).should.be.true();
                outcome.result.filename.should.equal('Co10.Altis.pbo');
                listing().should.eql(['Co10.Altis.pbo']);
                fs.readdirSync(parent).should.eql(['missions']);
            });
        });

        it('B4: a traversal name cannot write outside the folder', function () {
            routes['/details'] = detailsReply(okEntry({filename: '../../evil.pbo'}));
            routes['/file/123'] = fileReply(200, 'PBO-BYTES');
            return download('123').then(function (outcome) {
                (outcome.err === null || outcome.err === undefined).should.be.true();
                outcome.result.filename.should.equal('evil.pbo');
                listing().should.eql(['evil.pbo']);
                fs.readdirSync(parent).should.eql(['missions']);
            });
        });

        ['', '.', '..'].forEach(function (name) {
            it('B4: rejects the file name ' + JSON.stringify(name) + ' as no file name', function () {
                routes['/details'] = detailsReply(okEntry({filename: name}));
                routes['/file/123'] = fileReply(200, 'PBO-BYTES');
                return download('123').then(function (outcome) {
                    expectError(outcome, /no file name/);
                    listing().should.eql([]);
                });
            });
        });
    });

    describe('B5: details HTTP error', function () {
        it('B5: reports HTTP 500 and requests no file', function () {
            routes['/details'] = fileReply(500, 'boom');
            routes['/file/123'] = fileReply(200, 'PBO-BYTES');
            return download('123').then(function (outcome) {
                expectError(outcome, /HTTP 500/);
                listing().should.eql([]);
                requests.filter(function (r) {
                    return r.url.indexOf('/file/') === 0;
                }).length.should.equal(0);
            });
        });
    });

    describe('B6: no data', function () {
        it('B6: an empty response object reports No data found', function () {
            routes['/details'] = function (req, res) {
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({response: {}}));
            };
            return download('123').then(function (outcome) {
                expectError(outcome, /No data found/);
                listing().should.eql([]);
            });
        });

        it('B6: a body that is not JSON reports No data found', function () {
            routes['/details'] = fileReply(200, '<html>not json</html>');
            return download('123').then(function (outcome) {
                expectError(outcome, /No data found/);
                listing().should.eql([]);
            });
        });
    });

    describe('B7: item not found', function () {
        it('B7: result 9 reports not found', function () {
            routes['/details'] = detailsReply({publishedfileid: '123', result: 9});
            return download('123').then(function (outcome) {
                expectError(outcome, /not found/);
                listing().should.eql([]);
            });
        });
    });

    describe('B8: no downloadable file', function () {
        it('B8: an empty file_url is an error, not a success', function () {
            routes['/details'] = detailsReply(okEntry({file_url: ''}));
            return download('123').then(function (outcome) {
                expectError(outcome, /no downloadable file/);
                listing().should.eql([]);
            });
        });
    });

    describe('B9: download HTTP error', function () {
        it('B9: reports HTTP 404 and leaves no .download file', function () {
            routes['/details'] = detailsReply(okEntry());
            routes['/file/123'] = fileReply(404, 'nope');
            return download('123').then(function (outcome) {
                expectError(outcome, /HTTP 404/);
                listing().should.eql([]);
            });
        });
    });

    describe('B10: existing file', function () {
        var target = function () {
            return path.join(folder, 'Co10_Escape.Altis.pbo');
        };

        it('B10: a successful download replaces it', function () {
            fs.writeFileSync(target(), 'OLD');
            routes['/details'] = detailsReply(okEntry());
            routes['/file/123'] = fileReply(200, 'PBO-BYTES');
            return download('123').then(function (outcome) {
                (outcome.err === null || outcome.err === undefined).should.be.true();
                listing().should.eql(['Co10_Escape.Altis.pbo']);
                fs.readFileSync(target(), 'utf8').should.equal('PBO-BYTES');
            });
        });

        it('B10: a failing download leaves it untouched', function () {
            fs.writeFileSync(target(), 'OLD');
            routes['/details'] = detailsReply(okEntry());
            routes['/file/123'] = fileReply(404, 'nope');
            return download('123').then(function (outcome) {
                expectError(outcome, /HTTP 404/);
                listing().should.eql(['Co10_Escape.Altis.pbo']);
                fs.readFileSync(target(), 'utf8').should.equal('OLD');
            });
        });
    });

    describe('B11: redirect and timeout', function () {
        it('B11: follows a redirect to the real file', function () {
            routes['/details'] = detailsReply(okEntry());
            routes['/file/123'] = function (req, res) {
                res.writeHead(302, {Location: '/file/real'});
                res.end();
            };
            routes['/file/real'] = fileReply(200, 'REDIRECTED');
            return download('123').then(function (outcome) {
                (outcome.err === null || outcome.err === undefined).should.be.true();
                listing().should.eql(['Co10_Escape.Altis.pbo']);
                fs.readFileSync(path.join(folder, 'Co10_Escape.Altis.pbo'), 'utf8').should.equal('REDIRECTED');
            });
        });

        it('B11: a details request that never answers fails within 2 s', function () {
            this.timeout(5000);
            routes['/details'] = hang;
            var started = Date.now();
            return download('123').then(function (outcome) {
                outcome.err.should.be.an.instanceOf(Error);
                (Date.now() - started).should.be.below(2000);
                listing().should.eql([]);
            });
        });
    });
});
