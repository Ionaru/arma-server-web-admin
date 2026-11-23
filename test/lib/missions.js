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
});
