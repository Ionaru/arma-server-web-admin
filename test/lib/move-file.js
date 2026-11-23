require('should');
var fs = require('fs');
var os = require('os');
var path = require('path');

var moveFile = require('../../lib/move-file.js');

describe('moveFile', function () {
    var tmp;
    var src;
    var dst;
    var originalRename = fs.rename;

    beforeEach(function () {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'move-file-'));
        src = path.join(tmp, 'src.bin');
        dst = path.join(tmp, 'dst.bin');
    });

    afterEach(function () {
        fs.rename = originalRename;
        fs.rmSync(tmp, {recursive: true, force: true});
    });

    it('B3a: should move src to an absent dst', function (done) {
        fs.writeFileSync(src, 'MOVE');

        moveFile(src, dst, function (err) {
            (err === null || err === undefined).should.be.true();
            fs.readFileSync(dst, 'utf8').should.equal('MOVE');
            fs.existsSync(src).should.be.false();
            done();
        });
    });

    it('B3b: should fail and change nothing when dst exists', function (done) {
        fs.writeFileSync(src, 'MOVE');
        fs.writeFileSync(dst, 'OLD');

        moveFile(src, dst, function (err) {
            err.should.be.an.instanceOf(Error);
            err.message.should.equal('File ' + dst + ' exists.');
            fs.readFileSync(src, 'utf8').should.equal('MOVE');
            fs.readFileSync(dst, 'utf8').should.equal('OLD');
            done();
        });
    });

    it('B3c: should fall back to copy and unlink when rename fails with EXDEV', function (done) {
        fs.writeFileSync(src, 'MOVE');
        fs.rename = function (from, to, cb) {
            cb(Object.assign(new Error('cross-device'), {code: 'EXDEV'}));
        };

        moveFile(src, dst, function (err) {
            (err === null || err === undefined).should.be.true();
            fs.readFileSync(dst, 'utf8').should.equal('MOVE');
            fs.existsSync(src).should.be.false();
            done();
        });
    });

    it('B3d: should report ENOENT when src does not exist', function (done) {
        moveFile(src, dst, function (err) {
            err.should.be.an.instanceOf(Error);
            err.code.should.equal('ENOENT');
            fs.existsSync(dst).should.be.false();
            done();
        });
    });
});
