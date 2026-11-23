require('should');
var bodyParser = require('body-parser');
var express = require('express');
var request = require('supertest');

var serversRoute = require('../../routes/servers.js');

describe('routes/servers (B4-B7)', function () {
    var calls;
    var stubServer;
    var app;

    beforeEach(function () {
        calls = {addServer: [], getServer: [], update: [], save: 0};

        stubServer = {
            update: function (options) {
                calls.update.push(options);
            },
            toJSON: function () {
                return {id: 'Keep-Me', title: 'Renamed'};
            }
        };

        var manager = {
            addServer: function (options) {
                calls.addServer.push(options);
                return {id: 'New-Server', title: 'New Server'};
            },
            getServer: function (id) {
                calls.getServer.push(id);
                return stubServer;
            },
            save: function () {
                calls.save++;
            }
        };

        app = express();
        app.set('env', 'test');
        app.use(bodyParser.json());
        app.use('/api/servers', serversRoute(manager, {}));
    });

    function expectRefused(req, done) {
        req.end(function (err, res) {
            if (err) {
                return done(err);
            }

            res.status.should.eql(400);
            res.body.should.eql({error: 'title is required'});
            calls.addServer.should.eql([]);
            calls.getServer.should.eql([]);
            calls.update.should.eql([]);
            calls.save.should.eql(0);
            done();
        });
    }

    it('B4a: POST / without a body is 400 and adds nothing', function (done) {
        expectRefused(request(app).post('/api/servers'), done);
    });

    it('B4b: POST / with {} is 400 and adds nothing', function (done) {
        expectRefused(request(app).post('/api/servers').send({}), done);
    });

    it('B4c: POST / with an empty title is 400 and adds nothing', function (done) {
        expectRefused(request(app).post('/api/servers').send({title: ''}), done);
    });

    it('B4d: POST / with a non-string title is 400 and adds nothing', function (done) {
        expectRefused(request(app).post('/api/servers').send({title: 42}), done);
    });

    it('B5: POST / with a title adds the server and returns it', function (done) {
        request(app)
            .post('/api/servers')
            .send({title: 'New Server', port: 2402})
            .end(function (err, res) {
                if (err) {
                    return done(err);
                }

                res.status.should.eql(200);
                calls.addServer.should.eql([{title: 'New Server', port: 2402}]);
                res.body.should.eql({id: 'New-Server', title: 'New Server'});
                done();
            });
    });

    it('B6: PUT /Keep-Me without a body is 400 and touches nothing', function (done) {
        expectRefused(request(app).put('/api/servers/Keep-Me'), done);
    });

    it('B6: PUT /Keep-Me with {} is 400 and touches nothing', function (done) {
        expectRefused(request(app).put('/api/servers/Keep-Me').send({}), done);
    });

    it('B6: PUT /Keep-Me with an empty title is 400 and touches nothing', function (done) {
        expectRefused(request(app).put('/api/servers/Keep-Me').send({title: ''}), done);
    });

    it('B7: PUT /Keep-Me with a title updates, saves and returns the server', function (done) {
        request(app)
            .put('/api/servers/Keep-Me')
            .send({title: 'Renamed', port: 2402})
            .end(function (err, res) {
                if (err) {
                    return done(err);
                }

                res.status.should.eql(200);
                calls.getServer.should.eql(['Keep-Me']);
                calls.update.should.eql([{title: 'Renamed', port: 2402}]);
                calls.save.should.eql(1);
                res.body.should.eql({id: 'Keep-Me', title: 'Renamed'});
                done();
            });
    });
});
