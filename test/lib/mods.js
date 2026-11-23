require('should');
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

    describe('delete() (B4)', function () {
        it('B4: should remove the mod folder recursively and keep others', function (done) {
            mods.delete('@foo', function (err) {
                (err === null || err === undefined).should.be.true();
                fs.existsSync(path.join(tmp, '@foo')).should.be.false();
                fs.existsSync(path.join(tmp, '@bar')).should.be.true();
                done();
            });
        });

        it('B4: should not error when the mod does not exist', function (done) {
            mods.delete('@missing', function (err) {
                (err === null || err === undefined).should.be.true();
                done();
            });
        });
    });
});
