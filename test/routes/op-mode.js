process.env.TZ = 'Europe/Amsterdam';

require('should');
var bodyParser = require('body-parser');
var express = require('express');
var request = require('supertest');

var opModeRoute = require('../../routes/op-mode.js');

// A stand-in for OpMode with the same surface the route uses, so these tests exercise the route's
// own logic (status codes, the 202-vs-400 split) rather than the scheduler's.
var FakeOpMode = function (behaviour) {
    this.behaviour = behaviour || {};
    this.running = this.behaviour.running || false;
    this.setConfigCalls = [];
    this.runCalls = 0;
};

FakeOpMode.prototype.getState = function () {
    return {enabled: true, running: this.running};
};

FakeOpMode.prototype.setConfig = function (raw, cb) {
    this.setConfigCalls.push(raw);
    cb(this.behaviour.setConfigError || null);
};

FakeOpMode.prototype.run = function (cb) {
    this.runCalls++;

    if (this.behaviour.syncRunError) {
        return cb(this.behaviour.syncRunError);
    }

    // The real run calls back only once the whole stop/restart sequence is done.
    this.finishRun = cb;
};

var appWith = function (opMode) {
    var app = express();
    app.use(bodyParser.json());
    app.use('/api/op-mode', opModeRoute(opMode));
    return app;
};

describe('routes/op-mode', function () {

    describe('GET /', function () {
        it('should return the current state', function (done) {
            request(appWith(new FakeOpMode()))
                .get('/api/op-mode')
                .expect('Content-Type', /json/)
                .expect(200, {enabled: true, running: false}, done);
        });
    });

    describe('PUT /', function () {
        it('should pass the body through and return the new state', function (done) {
            var opMode = new FakeOpMode();

            request(appWith(opMode))
                .put('/api/op-mode')
                .send({enabled: true, days: [0], time: '19:30', opServerId: 'op'})
                .expect(200)
                .end(function (err) {
                    if (err) {
                        return done(err);
                    }

                    opMode.setConfigCalls.length.should.eql(1);
                    opMode.setConfigCalls[0].time.should.eql('19:30');
                    done();
                });
        });

        it('should return 400 with the message when the schedule is rejected', function (done) {
            var opMode = new FakeOpMode({setConfigError: new Error('Select at least one day')});

            request(appWith(opMode))
                .put('/api/op-mode')
                .send({enabled: true, days: [], time: '19:30', opServerId: 'op'})
                .expect('Content-Type', /json/)
                .expect(400, {error: 'Select at least one day'}, done);
        });
    });

    describe('POST /run', function () {
        // The run is not awaited, because stopping servers and starting Arma takes far longer than
        // a request should stay open. The outcome arrives over the socket instead.
        it('should return 202 immediately once the run is under way', function (done) {
            var opMode = new FakeOpMode();

            request(appWith(opMode))
                .post('/api/op-mode/run')
                .expect(202)
                .end(function (err) {
                    if (err) {
                        return done(err);
                    }

                    opMode.runCalls.should.eql(1);
                    opMode.finishRun.should.be.a.Function();
                    done();
                });
        });

        // Every refusal is raised before anything is stopped, so it can be reported straight back
        // to whoever pressed the button rather than disappearing into the console.
        it('should return 400 when the run is refused up front', function (done) {
            var opMode = new FakeOpMode({syncRunError: new Error('No op server is configured')});

            request(appWith(opMode))
                .post('/api/op-mode/run')
                .expect('Content-Type', /json/)
                .expect(400, {error: 'No op server is configured'}, done);
        });

        it('should return 409 when a run is already in progress', function (done) {
            var opMode = new FakeOpMode({running: true});

            request(appWith(opMode))
                .post('/api/op-mode/run')
                .expect('Content-Type', /json/)
                .expect(409)
                .end(function (err) {
                    if (err) {
                        return done(err);
                    }

                    opMode.runCalls.should.eql(0);
                    done();
                });
        });

        // A failure after the 202 has gone out must not try to respond a second time.
        it('should not respond twice when the run fails after it started', function (done) {
            var opMode = new FakeOpMode();

            request(appWith(opMode))
                .post('/api/op-mode/run')
                .expect(202)
                .end(function (err) {
                    if (err) {
                        return done(err);
                    }

                    (function () {
                        opMode.finishRun(new Error('did not stop in time'));
                    }).should.not.throw();

                    done();
                });
        });
    });
});
