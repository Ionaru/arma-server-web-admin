require('should');
var express = require('express');
var fs = require('fs');
var fsExtra = require('fs.extra');
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
        fsExtra.mkdirpSync(missionsDir);

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

            fsExtra.rmrfSync(root);
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
