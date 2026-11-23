require('should');
var express = require('express');
var fs = require('fs');
var os = require('os');
var path = require('path');
var request = require('supertest');

var Missions = require('../../lib/missions.js');
var missionsRoute = require('../../routes/missions.js');

describe('routes/missions upload (B1-B6)', function () {
    var root;
    var missionsDir;
    var missions;
    var inFlight;
    var app;

    beforeEach(function (done) {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'missions-route-'));
        missionsDir = path.join(root, 'mpmissions');
        fs.mkdirSync(missionsDir, {recursive: true});

        missions = new Missions({path: root});

        // handleUpload calls updateMissions() without a callback; count the
        // calls so afterEach can wait for them before removing the folder.
        inFlight = 0;
        var original = missions.updateMissions;
        missions.updateMissions = function (cb) {
            inFlight++;
            original.call(this, function (err) {
                inFlight--;
                if (cb) {
                    cb(err);
                }
            });
        };

        app = express();
        app.set('env', 'test');
        app.use('/api/missions', missionsRoute(missions));

        missions.updateMissions(function () {
            done();
        });
    });

    afterEach(function (done) {
        var waitForIdle = function () {
            if (inFlight > 0) {
                return setTimeout(waitForIdle, 10);
            }

            fs.rmSync(root, {recursive: true, force: true});
            done();
        };

        waitForIdle();
    });

    function listing() {
        return fs.readdirSync(missionsDir).sort();
    }

    function upload(field, files) {
        var req = request(app).post('/api/missions');
        files.forEach(function (file) {
            req = req.attach(field, file.content, file.name);
        });
        return req;
    }

    function numbered(count) {
        var files = [];
        for (var i = 1; i <= count; i++) {
            files.push({name: 'm' + (i < 10 ? '0' : '') + i + '.Altis.pbo', content: Buffer.from('x')});
        }
        return files;
    }

    function lowerNumbered(count) {
        return numbered(count).map(function (file) {
            return file.name.toLowerCase();
        });
    }

    it('B1: a single upload is stored lower-cased with its content', function (done) {
        upload('missions', [{name: 'Co10_Escape.Altis.pbo', content: Buffer.from('PBO-ONE')}])
            .end(function (err, res) {
                if (err) {
                    return done(err);
                }

                res.status.should.eql(200);
                res.body.should.eql({success: true});
                listing().should.eql(['co10_escape.altis.pbo'], 'listing: ' + JSON.stringify(listing()));
                fs.readFileSync(path.join(missionsDir, 'co10_escape.altis.pbo')).equals(Buffer.from('PBO-ONE')).should.eql(true);
                done();
            });
    });

    it('B2: several files are stored and non-PBO files are filtered', function (done) {
        upload('missions', [
            {name: 'A.Altis.pbo', content: Buffer.from('A')},
            {name: 'B.Stratis.pbo', content: Buffer.from('BB')},
            {name: 'notes.txt', content: Buffer.from('ignored')}
        ]).end(function (err, res) {
            if (err) {
                return done(err);
            }

            res.status.should.eql(200);
            res.body.should.eql({success: true});
            listing().should.eql(['a.altis.pbo', 'b.stratis.pbo'], 'listing: ' + JSON.stringify(listing()));
            fs.readFileSync(path.join(missionsDir, 'a.altis.pbo')).toString().should.eql('A');
            fs.readFileSync(path.join(missionsDir, 'b.stratis.pbo')).toString().should.eql('BB');
            done();
        });
    });

    it('B3: a non-ASCII filename is decoded as UTF-8', function (done) {
        upload('missions', [{name: 'Opération_Ōmega.Altis.pbo', content: Buffer.from('UTF')}])
            .end(function (err, res) {
                if (err) {
                    return done(err);
                }

                res.status.should.eql(200);
                res.body.should.eql({success: true});
                listing().should.eql(['opération_ōmega.altis.pbo'], 'listing: ' + JSON.stringify(listing()));
                done();
            });
    });

    it('B4a: 64 files are accepted', function (done) {
        upload('missions', numbered(64)).end(function (err, res) {
            if (err) {
                return done(err);
            }

            res.status.should.eql(200);
            res.body.should.eql({success: true});
            var actual = listing();
            actual.length.should.eql(64, 'listing: ' + JSON.stringify(actual));
            actual.should.eql(lowerNumbered(64), 'listing: ' + JSON.stringify(actual));
            done();
        });
    });

    it('B4b: 65 files are rejected with 500 and nothing is stored', function (done) {
        upload('missions', numbered(65)).end(function (err, res) {
            if (err) {
                return done(err);
            }

            res.status.should.eql(500);
            listing().should.eql([], 'listing: ' + JSON.stringify(listing()));
            done();
        });
    });

    it('B5: a wrong field name is rejected with 500 and nothing is stored', function (done) {
        upload('file', [{name: 'Wrong.Altis.pbo', content: Buffer.from('x')}])
            .end(function (err, res) {
                if (err) {
                    return done(err);
                }

                res.status.should.eql(500);
                listing().should.eql([], 'listing: ' + JSON.stringify(listing()));
                done();
            });
    });

    it('B6: a request without a PBO succeeds and stores nothing', function (done) {
        upload('missions', [{name: 'readme.md', content: Buffer.from('x')}])
            .end(function (err, res) {
                if (err) {
                    return done(err);
                }

                res.status.should.eql(200);
                res.body.should.eql({success: true});
                listing().should.eql([], 'listing: ' + JSON.stringify(listing()));
                done();
            });
    });
});

describe('routes/missions upload name (B4)', function () {
    var root;
    var missionsDir;
    var missions;
    var inFlight;
    var app;

    beforeEach(function (done) {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'missions-name-'));
        missionsDir = path.join(root, 'mpmissions');
        fs.mkdirSync(missionsDir, {recursive: true});

        missions = new Missions({path: root});
        inFlight = 0;
        var original = missions.updateMissions;
        missions.updateMissions = function (cb) {
            inFlight++;
            original.call(this, function (err) {
                inFlight--;
                if (cb) {
                    cb(err);
                }
            });
        };

        app = express();
        app.set('env', 'test');
        app.use('/api/missions', missionsRoute(missions));

        missions.updateMissions(function () {
            done();
        });
    });

    afterEach(function (done) {
        var waitForIdle = function () {
            if (inFlight > 0) {
                return setTimeout(waitForIdle, 10);
            }

            fs.rmSync(root, {recursive: true, force: true});
            done();
        };

        waitForIdle();
    });

    it('B4: an encoded backslash traversal in the upload name keeps only the last segment', function (done) {
        request(app)
            .post('/api/missions')
            .attach('missions', Buffer.from('EVIL'), '..%5C..%5CEvil.Altis.pbo')
            .end(function (err, res) {
                if (err) {
                    return done(err);
                }

                res.status.should.eql(200);
                res.body.should.eql({success: true});
                fs.readdirSync(missionsDir).sort().should.eql(['evil.altis.pbo'], 'listing: ' + JSON.stringify(fs.readdirSync(missionsDir)));
                fs.readdirSync(root).should.eql(['mpmissions'], 'root: ' + JSON.stringify(fs.readdirSync(root)));
                fs.readFileSync(path.join(missionsDir, 'evil.altis.pbo')).toString().should.eql('EVIL');
                done();
            });
    });
});

describe('routes/missions upload undecodable name (B6-B7)', function () {
    var root;
    var missionsDir;
    var missions;
    var inFlight;
    var app;

    beforeEach(function (done) {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'missions-decode-'));
        missionsDir = path.join(root, 'mpmissions');
        fs.mkdirSync(missionsDir, {recursive: true});

        missions = new Missions({path: root});
        inFlight = 0;
        var original = missions.updateMissions;
        missions.updateMissions = function (cb) {
            inFlight++;
            original.call(this, function (err) {
                inFlight--;
                if (cb) {
                    cb(err);
                }
            });
        };

        app = express();
        app.set('env', 'test');
        app.use('/api/missions', missionsRoute(missions));

        missions.updateMissions(function () {
            done();
        });
    });

    afterEach(function (done) {
        var waitForIdle = function () {
            if (inFlight > 0) {
                return setTimeout(waitForIdle, 10);
            }

            fs.rmSync(root, {recursive: true, force: true});
            done();
        };

        waitForIdle();
    });

    it('B6: nine files with an undecodable ninth name all land and the request succeeds', function (done) {
        var req = request(app).post('/api/missions');
        for (var i = 1; i <= 8; i++) {
            req = req.attach('missions', Buffer.from('x' + i), 'm' + i + '.pbo');
        }
        req = req.attach('missions', Buffer.from('NINE'), '%E0.pbo');

        req.end(function (err, res) {
            if (err) {
                return done(err);
            }

            res.status.should.eql(200);
            res.body.should.eql({success: true});
            var expected = ['%e0.pbo', 'm1.pbo', 'm2.pbo', 'm3.pbo', 'm4.pbo', 'm5.pbo', 'm6.pbo', 'm7.pbo', 'm8.pbo'];
            fs.readdirSync(missionsDir).sort().should.eql(expected, 'listing: ' + JSON.stringify(fs.readdirSync(missionsDir)));
            fs.readFileSync(path.join(missionsDir, '%e0.pbo')).toString().should.eql('NINE');
            done();
        });
    });

    it('B7: a single file named 100%.pbo answers 200 and is stored under that name', function (done) {
        request(app)
            .post('/api/missions')
            .attach('missions', Buffer.from('PCT'), '100%.pbo')
            .end(function (err, res) {
                if (err) {
                    return done(err);
                }

                res.status.should.eql(200);
                res.body.should.eql({success: true});
                fs.readdirSync(missionsDir).should.eql(['100%.pbo'], 'listing: ' + JSON.stringify(fs.readdirSync(missionsDir)));
                fs.readFileSync(path.join(missionsDir, '100%.pbo')).toString().should.eql('PCT');
                done();
            });
    });
});

describe('routes/missions delete (B1-B3)', function () {
    var root;
    var missionsDir;
    var missions;
    var inFlight;
    var app;

    beforeEach(function (done) {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'missions-delete-'));
        missionsDir = path.join(root, 'mpmissions');
        fs.mkdirSync(missionsDir, {recursive: true});
        fs.writeFileSync(path.join(missionsDir, 'Keep.Altis.pbo'), 'KEEP');
        fs.writeFileSync(path.join(missionsDir, 'Other.Altis.pbo'), 'OTHER');
        fs.writeFileSync(path.join(root, 'secret.txt'), 'TOP-SECRET');

        missions = new Missions({path: root});
        inFlight = 0;
        var original = missions.updateMissions;
        missions.updateMissions = function (cb) {
            inFlight++;
            original.call(this, function (err) {
                inFlight--;
                if (cb) {
                    cb(err);
                }
            });
        };

        app = express();
        app.set('env', 'test');
        app.use('/api/missions', missionsRoute(missions));

        missions.updateMissions(function () {
            done();
        });
    });

    afterEach(function (done) {
        var waitForIdle = function () {
            if (inFlight > 0) {
                return setTimeout(waitForIdle, 10);
            }

            fs.rmSync(root, {recursive: true, force: true});
            done();
        };

        waitForIdle();
    });

    it('B1: DELETE of a listed mission answers 200 and removes the file', function (done) {
        request(app)
            .delete('/api/missions/Keep.Altis.pbo')
            .end(function (err, res) {
                if (err) {
                    return done(err);
                }

                res.status.should.eql(200);
                res.body.should.eql({success: true});
                fs.existsSync(path.join(missionsDir, 'Keep.Altis.pbo')).should.eql(false);
                fs.existsSync(path.join(missionsDir, 'Other.Altis.pbo')).should.eql(true);
                done();
            });
    });

    it('B2: DELETE /..%2Fsecret.txt answers 404 and keeps the file outside mpmissions', function (done) {
        request(app)
            .delete('/api/missions/..%2Fsecret.txt')
            .end(function (err, res) {
                if (err) {
                    return done(err);
                }

                res.status.should.eql(404);
                res.body.should.eql({error: 'Mission not found'});
                fs.existsSync(path.join(root, 'secret.txt')).should.eql(true);
                fs.readdirSync(missionsDir).sort().should.eql(['Keep.Altis.pbo', 'Other.Altis.pbo']);
                done();
            });
    });

    it('B3: DELETE of a mission that is not listed answers 404 with the same body', function (done) {
        request(app)
            .delete('/api/missions/Nope.Altis.pbo')
            .end(function (err, res) {
                if (err) {
                    return done(err);
                }

                res.status.should.eql(404);
                res.body.should.eql({error: 'Mission not found'});
                fs.readdirSync(missionsDir).sort().should.eql(['Keep.Altis.pbo', 'Other.Altis.pbo']);
                done();
            });
    });
});

function binaryParser(res, callback) {
    var chunks = [];
    res.on('data', function (chunk) {
        chunks.push(chunk);
    });
    res.on('end', function () {
        callback(null, Buffer.concat(chunks));
    });
}

describe('routes/missions download (B2-B3)', function () {
    var tmp;
    var dir;
    var app;

    beforeEach(function () {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'missions-download-'));
        dir = path.join(tmp, '.arma', 'mpmissions');
        fs.mkdirSync(dir, {recursive: true});

        var manager = {
            missionsPath: function () {
                return dir;
            },
            missionPath: function (name) {
                return path.join(dir, name);
            },
            missions: []
        };

        app = express();
        app.set('env', 'test');
        app.use('/api/missions', missionsRoute(manager));
    });

    afterEach(function () {
        fs.rmSync(tmp, {recursive: true, force: true});
    });

    it('B2a: GET /<name> serves a mission below a dot-directory as an attachment', function (done) {
        fs.writeFileSync(path.join(dir, 'Foo.Altis.pbo'), Buffer.from('PBO-FOO'));

        request(app)
            .get('/api/missions/Foo.Altis.pbo')
            .buffer(true)
            .parse(binaryParser)
            .end(function (err, res) {
                if (err) {
                    return done(err);
                }

                res.status.should.eql(200);
                res.headers['content-disposition'].should.containEql('attachment');
                res.headers['content-disposition'].should.containEql('Foo.Altis.pbo');
                res.body.equals(Buffer.from('PBO-FOO')).should.eql(true);
                done();
            });
    });

    it('B2b: GET /<name> works for a mission name with a space', function (done) {
        fs.writeFileSync(path.join(dir, 'My Op.Altis.pbo'), Buffer.from('SPACE'));

        request(app)
            .get('/api/missions/My%20Op.Altis.pbo')
            .buffer(true)
            .parse(binaryParser)
            .end(function (err, res) {
                if (err) {
                    return done(err);
                }

                res.status.should.eql(200);
                res.headers['content-disposition'].should.containEql('attachment');
                res.headers['content-disposition'].should.containEql('My Op.Altis.pbo');
                res.body.equals(Buffer.from('SPACE')).should.eql(true);
                done();
            });
    });

    it('B3: GET /..%2Fsecret.txt is refused with 403 and does not leak the file', function (done) {
        var plainDir = path.join(tmp, 'mpmissions');
        fs.mkdirSync(plainDir, {recursive: true});
        fs.writeFileSync(path.join(tmp, 'secret.txt'), 'TOP-SECRET');

        var manager = {
            missionsPath: function () {
                return plainDir;
            },
            missionPath: function (name) {
                return path.join(plainDir, name);
            },
            missions: []
        };
        var plainApp = express();
        plainApp.set('env', 'test');
        plainApp.use('/api/missions', missionsRoute(manager));

        request(plainApp)
            .get('/api/missions/..%2Fsecret.txt')
            .end(function (err, res) {
                if (err) {
                    return done(err);
                }

                res.status.should.eql(403);
                (res.text || '').should.not.containEql('TOP-SECRET');
                done();
            });
    });
});
