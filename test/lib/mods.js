var should = require('should');
var fs = require('fs');
var os = require('os');
var path = require('path');

var Mods = require('../../lib/mods.js');

describe('Mods', function () {
    var tmp;
    var mods;

    beforeEach(function () {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-'));
        fs.mkdirSync(path.join(tmp, '@foo', 'addons'), {recursive: true});
        fs.writeFileSync(path.join(tmp, '@foo', 'addons', 'x.pbo'), 'x');
        fs.mkdirSync(path.join(tmp, '@bar'));
        mods = new Mods({path: tmp});
    });

    afterEach(function () {
        fs.rmSync(tmp, {recursive: true, force: true});
    });

    describe('delete() (B4, B7)', function () {
        it('B4, B7: should remove the listed mod folder recursively and keep others', function (done) {
            mods.updateMods();
            var listed = path.join(tmp, '@foo');
            mods.mods.map(function (mod) {
                return mod.name;
            }).should.containEql(listed);

            mods.delete(listed, function (err) {
                (err === null || err === undefined).should.be.true();
                fs.existsSync(path.join(tmp, '@foo')).should.be.false();
                fs.existsSync(path.join(tmp, '@bar')).should.be.true();
                done();
            });
        });

        it('B4, B7: should fail with a 404 error when the mod is not listed', function (done) {
            mods.updateMods();
            mods.delete('@missing', function (err) {
                should.exist(err);
                err.status.should.eql(404);
                err.message.should.eql('Mod not found');
                fs.existsSync(path.join(tmp, '@foo')).should.be.true();
                fs.existsSync(path.join(tmp, '@bar')).should.be.true();
                done();
            });
        });
    });
});
