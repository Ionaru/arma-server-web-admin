require('should');
var events = require('events');

var Server = require('../../lib/server.js');

describe('Server', function () {
    describe('generateId()', function () {
        it('should include title', function () {
            var server = new Server(null, null, {title: 'title.with.lot.of.dots'});
            server.generateId().should.eql('title-with-lot-of-dots');
        });
    });

    describe('toJSON()', function () {
        it('should include title', function () {
            var server = new Server(null, null, {title: 'test'});
            server.toJSON().should.have.property('title', 'test');
        });
    });

    describe('events', function () {
        // Guards the util.inherits fix. `Server.prototype = new events.EventEmitter()` gave every
        // instance one shared listener registry, so a single server's state change fired the
        // manager's handler once per server, and op mode stopping N-1 servers made that N squared.
        it('should not share listeners between instances', function () {
            var a = new Server(null, null, {title: 'a'});
            var b = new Server(null, null, {title: 'b'});
            var fired = 0;

            a.on('state', function () {
                fired++;
            });

            b.emit('state');
            fired.should.eql(0);

            a.emit('state');
            fired.should.eql(1);
        });
    });

    describe('stop()', function () {
        it('should invoke the callback when the server is not running', function (done) {
            var server = new Server(null, null, {title: 'test'});
            (server.instance === undefined || server.instance === null).should.be.true();

            // routes/servers.js only responds from inside this callback, so a missing call hangs
            // the request rather than failing it.
            server.stop(function () {
                done();
            });
        });

        it('should not throw when the server is not running', function () {
            var server = new Server(null, null, {title: 'test'});
            server.stop.bind(server).should.not.throw();
        });
    });

    describe('restart()', function () {
        var stopTimeout;

        beforeEach(function () {
            stopTimeout = Server.stopTimeout;
        });

        afterEach(function () {
            Server.stopTimeout = stopTimeout;
        });

        // Simulates the close handler that the real start() registers, which nulls the instance.
        var runningServer = function (options) {
            var server = new Server(null, null, {title: 'test'});
            var instance = new events.EventEmitter();

            instance.kill = function () {
                if (options && options.refusesToDie) {
                    return;
                }

                server.instance = null;
                instance.emit('close', 0);
            };

            server.instance = instance;

            return server;
        };

        it('should just start when the server is not running', function (done) {
            var server = new Server(null, null, {title: 'test'});
            var started = false;

            server.start = function () {
                started = true;
            };

            server.restart(function (err) {
                (err === undefined || err === null).should.be.true();
                started.should.be.true();
                done();
            });
        });

        it('should stop then start when the server is running', function (done) {
            var server = runningServer();
            var started = false;

            server.start = function () {
                started = true;
            };

            server.restart(function (err) {
                (err === undefined || err === null).should.be.true();
                started.should.be.true();
                done();
            });
        });

        // The only branch that ends with the op server down. If kill() does not take within the
        // fallback window the process is still alive, and starting a second one would be worse
        // than reporting the failure.
        it('should report an error and not start when the process refuses to die', function (done) {
            Server.stopTimeout = 10;

            var server = runningServer({refusesToDie: true});
            var started = false;

            server.start = function () {
                started = true;
            };

            server.restart(function (err) {
                err.should.be.an.Error();
                err.message.should.match(/did not stop/i);
                started.should.be.false();
                done();
            });
        });

        it('should report an error when starting throws on the not running path', function (done) {
            var server = new Server(null, null, {title: 'test'});

            server.start = function () {
                throw new Error('spawn failed');
            };

            server.restart(function (err) {
                err.should.be.an.Error();
                err.message.should.eql('spawn failed');
                done();
            });
        });

        // The running path is the one that matters: this callback fires inside the ChildProcess
        // close emit, which is outside any Express or timer guard, so an uncaught throw here would
        // take the whole panel down rather than failing one restart.
        it('should report an error when starting throws on the running path', function (done) {
            var server = runningServer();

            server.start = function () {
                throw new Error('spawn failed after stop');
            };

            server.restart(function (err) {
                err.should.be.an.Error();
                err.message.should.eql('spawn failed after stop');
                done();
            });
        });

        it('should not throw when called without a callback', function () {
            var server = new Server(null, null, {title: 'test'});
            server.start = function () {};
            server.restart.bind(server).should.not.throw();
        });
    });
});
