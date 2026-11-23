require('should');
var fs = require('fs');
var os = require('os');
var path = require('path');

var Missions = require('../../lib/missions.js');

describe('Missions', function () {
    var tmp;

    beforeEach(function () {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'missions-'));
        fs.mkdirSync(path.join(tmp, 'mpmissions'));
    });

    afterEach(function () {
        fs.rmSync(tmp, {recursive: true, force: true});
    });

    it('B2: should list a mission with its binary KB formatted size', function (done) {
        fs.writeFileSync(path.join(tmp, 'mpmissions', 'Big.Altis.pbo'), Buffer.alloc(123456));
        var missions = new Missions({path: tmp});

        missions.updateMissions(function (err, list) {
            if (err) {
                return done(err);
            }

            var mission = (list || missions.missions).filter(function (m) {
                return m.name === 'Big.Altis.pbo';
            })[0];
            mission.size.should.equal(123456);
            mission.sizeFormatted.should.equal('120.56 KB');
            done();
        });
    });

    describe('handleUpload name decoding', function () {
        var missions;
        var missionsDir;

        beforeEach(function () {
            missionsDir = path.join(tmp, 'mpmissions');
            missions = new Missions({path: tmp});
            // handleUpload refreshes the listing without a callback; keep it
            // from touching the folder after the test removed it.
            missions.updateMissions = function (cb) {
                if (cb) {
                    cb(null, []);
                }
            };
        });

        function uploadName(name, done, check) {
            var tempFile = path.join(tmp, 'upload.tmp');
            fs.writeFileSync(tempFile, 'PBO');

            try {
                missions.handleUpload({originalname: name, path: tempFile}, function (err) {
                    if (err) {
                        return done(err);
                    }
                    try {
                        check();
                    } catch (e) {
                        return done(e);
                    }
                    done();
                });
            } catch (e) {
                return done(e);
            }
        }

        it('B1: a malformed percent sequence does not throw and the raw name is kept', function (done) {
            uploadName('%E0.pbo', done, function () {
                fs.readdirSync(missionsDir).should.eql(['%e0.pbo'], 'listing: ' + JSON.stringify(fs.readdirSync(missionsDir)));
                fs.readFileSync(path.join(missionsDir, '%e0.pbo')).toString().should.eql('PBO');
            });
        });

        it('B2: a lone percent sign is kept in the stored name', function (done) {
            uploadName('100%.pbo', done, function () {
                fs.readdirSync(missionsDir).should.eql(['100%.pbo'], 'listing: ' + JSON.stringify(fs.readdirSync(missionsDir)));
            });
        });

        it('B3: a name that decodes is still decoded', function (done) {
            uploadName('co10%20Escape.Altis.pbo', done, function () {
                fs.readdirSync(missionsDir).should.eql(['co10 escape.altis.pbo'], 'listing: ' + JSON.stringify(fs.readdirSync(missionsDir)));
            });
        });

        it('B5a: the fallback still cuts a literal backslash path to its last segment', function (done) {
            uploadName('sub\\%E0.pbo', done, function () {
                fs.readdirSync(missionsDir).should.eql(['%e0.pbo'], 'listing: ' + JSON.stringify(fs.readdirSync(missionsDir)));
            });
        });

        it('B5b: an undecodable name keeps an encoded separator as literal text inside the folder', function (done) {
            uploadName('..%5C%E0.pbo', done, function () {
                fs.readdirSync(missionsDir).should.eql(['..%5c%e0.pbo'], 'listing: ' + JSON.stringify(fs.readdirSync(missionsDir)));
                fs.readdirSync(tmp).should.eql(['mpmissions'], 'root: ' + JSON.stringify(fs.readdirSync(tmp)));
            });
        });
    });
});
