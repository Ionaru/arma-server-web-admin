require('should');
var express = require('express');
var fs = require('fs');
var os = require('os');
var path = require('path');
var crypto = require('crypto');
var request = require('supertest');

var Logs = require('../../lib/logs.js');
var logsRoute = require('../../routes/logs.js');

describe('routes/logs (B8)', function () {
    var root;
    var profiles;
    var filePath;
    var id;
    var app;

    beforeEach(function () {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-route-'));
        profiles = path.join(root, 'profiles');
        fs.mkdirSync(profiles, {recursive: true});
        fs.mkdirSync(path.join(root, 'arma', 'logs'), {recursive: true});

        filePath = path.join(profiles, 'arma3server_x64_2026-11-21_19-30-10.rpt');
        fs.writeFileSync(filePath, 'hello log\n');
        id = crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 12) + '-' + path.basename(filePath);

        var logs = new Logs({path: path.join(root, 'arma'), type: 'linux', game: 'arma3'});
        logs.setServers(function () {
            return [{
                title: 'A',
                getParameters: function () {
                    return ['-profiles=' + profiles];
                }
            }];
        });

        app = express();
        app.use('/api/logs', logsRoute(logs));
    });

    afterEach(function () {
        fs.rmSync(root, {recursive: true, force: true});
    });

    it('B8: GET / should return the file objects as JSON', function (done) {
        request(app)
            .get('/api/logs')
            .expect('Content-Type', /json/)
            .expect(200)
            .end(function (err, res) {
                if (err) {
                    return done(err);
                }

                res.body.length.should.eql(1);
                res.body[0].id.should.eql(id);
                res.body[0].name.should.eql(path.basename(filePath));
                res.body[0].path.should.eql(filePath);
                res.body[0].size.should.eql(10);
                res.body[0].servers.should.eql(['A']);
                done();
            });
    });

    it('B8: GET /<id>/view should return the content as text/plain', function (done) {
        request(app)
            .get('/api/logs/' + encodeURIComponent(id) + '/view')
            .expect('Content-Type', /text\/plain/)
            .expect(200, 'hello log\n', done);
    });

    it('B8: GET /<id>/download should be an attachment named after the file', function (done) {
        request(app)
            .get('/api/logs/' + encodeURIComponent(id) + '/download')
            .expect(200)
            .end(function (err, res) {
                if (err) {
                    return done(err);
                }

                res.headers['content-disposition'].should.containEql('attachment');
                res.headers['content-disposition'].should.containEql(path.basename(filePath));
                done();
            });
    });

    it('B8: GET /<bare name>/view should return 404', function (done) {
        request(app)
            .get('/api/logs/' + encodeURIComponent(path.basename(filePath)) + '/view')
            .expect(404, done);
    });

    it('B8: DELETE /<id> should return 204 and remove the file', function (done) {
        request(app)
            .delete('/api/logs/' + encodeURIComponent(id))
            .expect(204)
            .end(function (err) {
                if (err) {
                    return done(err);
                }

                fs.existsSync(filePath).should.be.false();
                done();
            });
    });
});

describe('routes/logs download from a dot-directory (B1)', function () {
    var root;
    var filePath;
    var id;
    var app;

    beforeEach(function () {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-route-'));
        var profiles = path.join(root, '.hidden', 'profiles');
        fs.mkdirSync(profiles, {recursive: true});
        fs.mkdirSync(path.join(root, 'arma', 'logs'), {recursive: true});

        filePath = path.join(profiles, 'arma3server_x64_2026-11-21_19-30-10.rpt');
        fs.writeFileSync(filePath, 'hello log\n');
        id = crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 12) + '-' + path.basename(filePath);

        var logs = new Logs({path: path.join(root, 'arma'), type: 'linux', game: 'arma3'});
        logs.setServers(function () {
            return [{
                title: 'A',
                getParameters: function () {
                    return ['-profiles=' + profiles];
                }
            }];
        });

        app = express();
        app.set('env', 'test');
        app.use('/api/logs', logsRoute(logs));
    });

    afterEach(function () {
        fs.rmSync(root, {recursive: true, force: true});
    });

    it('B1: GET /<id>/download serves a log below a dot-directory as an attachment', function (done) {
        request(app)
            .get('/api/logs/' + encodeURIComponent(id) + '/download')
            .expect(200)
            .end(function (err, res) {
                if (err) {
                    return done(err);
                }

                res.headers['content-disposition'].should.containEql('attachment');
                res.headers['content-disposition'].should.containEql(path.basename(filePath));
                res.body.toString().should.eql('hello log\n');
                done();
            });
    });
});
