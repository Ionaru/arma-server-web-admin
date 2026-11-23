require('should');
var express = require('express');
var fs = require('fs');
var os = require('os');
var path = require('path');
var request = require('supertest');

var Mods = require('../../lib/mods.js');
var modsRoute = require('../../routes/mods.js');

describe('routes/mods delete (B5-B6)', function () {
    var tmp;
    var armaDir;
    var mods;
    var app;

    beforeEach(function () {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-route-'));
        armaDir = path.join(tmp, 'x', 'arma');
        fs.mkdirSync(path.join(armaDir, '@foo', 'addons'), {recursive: true});
        fs.writeFileSync(path.join(armaDir, '@foo', 'addons', 'x.pbo'), 'x');
        fs.mkdirSync(path.join(armaDir, '!col', '@bar'), {recursive: true});
        fs.mkdirSync(path.join(armaDir, '@baz'));
        fs.mkdirSync(path.join(tmp, 'outside'));

        mods = new Mods({path: armaDir});
        mods.updateMods();

        app = express();
        app.set('env', 'test');
        app.use('/api/mods', modsRoute(mods));
    });

    afterEach(function () {
        fs.rmSync(tmp, {recursive: true, force: true});
    });

    function listed(suffix) {
        var found = mods.mods.filter(function (mod) {
            return mod.name === path.join(armaDir, suffix);
        });
        found.length.should.eql(1, 'listing: ' + JSON.stringify(mods.mods));
        return found[0].name;
    }

    it('B5: DELETE of a listed mod by its listed path answers 204 and removes only that mod', function (done) {
        request(app)
            .delete('/api/mods/' + encodeURIComponent(listed('@foo')))
            .end(function (err, res) {
                if (err) {
                    return done(err);
                }

                res.status.should.eql(204);
                fs.existsSync(path.join(armaDir, '@foo')).should.eql(false);
                fs.existsSync(path.join(armaDir, '@baz')).should.eql(true);
                fs.existsSync(path.join(armaDir, '!col', '@bar')).should.eql(true);
                done();
            });
    });

    it('B5: DELETE of a listed subfolder mod answers 204 and removes only that mod', function (done) {
        request(app)
            .delete('/api/mods/' + encodeURIComponent(listed(path.join('!col', '@bar'))))
            .end(function (err, res) {
                if (err) {
                    return done(err);
                }

                res.status.should.eql(204);
                fs.existsSync(path.join(armaDir, '!col', '@bar')).should.eql(false);
                fs.existsSync(path.join(armaDir, '@foo')).should.eql(true);
                fs.existsSync(path.join(armaDir, '@baz')).should.eql(true);
                done();
            });
    });

    it('B6: DELETE /..%2F..%2Foutside answers 404 and keeps the folder outside', function (done) {
        request(app)
            .delete('/api/mods/..%2F..%2Foutside')
            .end(function (err, res) {
                if (err) {
                    return done(err);
                }

                res.status.should.eql(404);
                res.body.should.eql({error: 'Mod not found'});
                fs.existsSync(path.join(tmp, 'outside')).should.eql(true);
                fs.existsSync(path.join(armaDir, '@foo')).should.eql(true);
                done();
            });
    });

    it('B6: DELETE of a relative, unlisted name (%40foo) answers 404 and keeps the mod', function (done) {
        request(app)
            .delete('/api/mods/%40foo')
            .end(function (err, res) {
                if (err) {
                    return done(err);
                }

                res.status.should.eql(404);
                res.body.should.eql({error: 'Mod not found'});
                fs.existsSync(path.join(armaDir, '@foo')).should.eql(true);
                done();
            });
    });
});
