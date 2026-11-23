require('should');
var events = require('events');
var fs = require('fs');
var os = require('os');
var path = require('path');

var Server = require('../../lib/server.js');

describe('Server', function () {
    describe('B1: idFromTitle()', function () {
        var slugify = require('slugify');

        ['Ops', '[7R] Ops #1', 'Server 1.2', '   ', '???', '-'].forEach(function (title) {
            it('B1: matches slugify with dots replaced for ' + JSON.stringify(title), function () {
                Server.idFromTitle(title).should.eql(slugify(title).replace(/\./g, '-'));
            });
        });

        ['   ', '???', '-'].forEach(function (title) {
            it('B1: is empty for ' + JSON.stringify(title), function () {
                Server.idFromTitle(title).should.eql('');
            });
        });

        it('B1: a server titled "Server 1.2" keeps the id "Server-1-2"', function () {
            var server = new Server(null, null, {title: 'Server 1.2'});
            server.id.should.eql('Server-1-2');
            server.generateId().should.eql('Server-1-2');
        });
    });

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

    describe('waitUntilOnline()', function () {
        it('resolves when a state poll first reports the server up', function (done) {
            var server = new Server(null, null, {title: 'test'});
            server.instance = {pid: 1234};
            server.state = null;

            server.waitUntilOnline(1000, function (err) {
                (err === null || err === undefined).should.be.true();
                done();
            });

            // A poll that still sees nothing must not resolve it.
            server.emit('state');

            // The next poll reports the server up.
            server.state = {players: []};
            server.emit('state');
        });

        it('does not resolve more than once', function (done) {
            var server = new Server(null, null, {title: 'test'});
            server.instance = {pid: 1234};
            var calls = 0;

            server.waitUntilOnline(1000, function () {
                calls++;
            });

            server.state = {players: []};
            server.emit('state');
            server.emit('state');

            setTimeout(function () {
                calls.should.eql(1);
                done();
            }, 10);
        });

        it('fails early when the process exits before coming up', function (done) {
            var server = new Server(null, null, {title: 'test'});
            server.instance = {pid: 1234};

            server.waitUntilOnline(1000, function (err) {
                err.should.be.an.Error();
                done();
            });

            // The process died during load: the close handler nulls instance and state, then emits.
            server.instance = null;
            server.state = null;
            server.emit('state');
        });

        it('fails when the timeout elapses with the server still down', function (done) {
            var server = new Server(null, null, {title: 'test'});
            server.instance = {pid: 1234};
            server.state = null;

            server.waitUntilOnline(20, function (err) {
                err.should.be.an.Error();
                done();
            });
        });

        // This repo has a history of EventEmitter listener leaks. The single-shot guarantee must
        // come from removing the listener, not only from the settled flag: assert the count directly.
        it('removes its state listener once it resolves online', function (done) {
            var server = new Server(null, null, {title: 'test'});
            server.instance = {pid: 1234};

            server.listenerCount('state').should.eql(0);

            server.waitUntilOnline(1000, function () {
                server.listenerCount('state').should.eql(0);
                done();
            });

            server.listenerCount('state').should.eql(1);   // armed
            server.state = {players: []};
            server.emit('state');
        });

        it('reports a timeout and an early exit with distinct reasons', function (done) {
            var timed = new Server(null, null, {title: 'test'});
            timed.instance = {pid: 1234};
            timed.state = null;

            timed.waitUntilOnline(20, function (err) {
                err.reason.should.eql('timeout');

                var exited = new Server(null, null, {title: 'test'});
                exited.instance = {pid: 1234};
                exited.waitUntilOnline(1000, function (err2) {
                    err2.reason.should.eql('offline');
                    done();
                });
                exited.instance = null;
                exited.state = null;
                exited.emit('state');
            });
        });

        // waitUntilOnline returns a cancel handle so a superseding run can abandon the wait without
        // firing the callback and without leaking the listener.
        it('can be cancelled without firing the callback', function (done) {
            var server = new Server(null, null, {title: 'test'});
            server.instance = {pid: 1234};
            server.state = null;

            var called = false;
            var cancel = server.waitUntilOnline(1000, function () {
                called = true;
            });

            server.listenerCount('state').should.eql(1);
            cancel();
            server.listenerCount('state').should.eql(0);

            // A later online transition must not resolve a cancelled wait.
            server.state = {players: []};
            server.emit('state');

            setTimeout(function () {
                called.should.be.false();
                done();
            }, 10);
        });
    });

    describe('headless clients', function () {
        var ArmaServer = require('arma-server');
        var moduleConfig = require('../../config.js');

        var DELAY = 40;
        var INTERVAL = 80;

        var origHeadlessStart;
        var origServerStart;
        var origWriteServerConfig;
        var origParameters;
        var origDelay;
        var origInterval;
        var origStopTimeout;
        var origConsoleLog;
        var servers;
        var serverChildren;
        var serverOptions;
        var hcChildren;
        var hcOptions;
        var hcCalls;
        var hcThrowOnFirst;
        var tmpDirs;

        var fakeChild = function () {
            var child = new events.EventEmitter();
            child.stdout = new events.EventEmitter();
            child.stderr = new events.EventEmitter();
            child.pid = 4242;
            child.killCount = 0;
            child.kill = function () {
                child.killCount++;
            };
            return child;
        };

        var logsStub = function (dir, suffixes) {
            return {
                generateLogFilePath: function (suffix) {
                    suffixes.push(suffix);
                    return path.join(dir, 'log' + (suffix ? '_' + suffix : '') + '.log');
                }
            };
        };

        var makeServer = function (options, type, logs) {
            var opts = {title: 'test', number_of_headless_clients: 0};
            Object.keys(options || {}).forEach(function (key) {
                opts[key] = options[key];
            });

            var server = new Server({path: '/tmp/arma', type: type || 'windows'}, logs || null, opts);
            servers.push(server);
            return server;
        };

        var later = function (ms, fn) {
            setTimeout(fn, ms);
        };

        beforeEach(function () {
            origHeadlessStart = ArmaServer.Headless.prototype.start;
            origServerStart = ArmaServer.Server.prototype.start;
            origWriteServerConfig = ArmaServer.Server.prototype.writeServerConfig;
            origParameters = moduleConfig.parameters;
            origDelay = Server.headlessClientStartDelay;
            origInterval = Server.headlessClientStartInterval;
            origStopTimeout = Server.stopTimeout;
            origConsoleLog = console.log;

            servers = [];
            serverChildren = [];
            serverOptions = [];
            hcChildren = [];
            hcOptions = [];
            hcCalls = 0;
            hcThrowOnFirst = false;
            tmpDirs = [];

            moduleConfig.parameters = ['-noSound'];
            Server.headlessClientStartDelay = DELAY;
            Server.headlessClientStartInterval = INTERVAL;
            Server.stopTimeout = 10;

            ArmaServer.Server.prototype.writeServerConfig = function () {};
            ArmaServer.Server.prototype.start = function () {
                var child = fakeChild();
                // Like a real process: killing it makes it close.
                child.kill = function () {
                    child.killCount++;
                    child.emit('close', 0);
                };
                serverOptions.push(this.options);
                serverChildren.push(child);
                return child;
            };
            ArmaServer.Headless.prototype.start = function () {
                hcCalls++;
                hcOptions.push(this.options);

                if (hcThrowOnFirst && hcCalls === 1) {
                    throw new Error('spawn failed');
                }

                var child = fakeChild();
                hcChildren.push(child);
                return child;
            };
        });

        afterEach(function () {
            // Closing the fake children clears the status interval and any pending HC timers.
            serverChildren.forEach(function (child) {
                child.emit('close', 0);
            });
            hcChildren.forEach(function (child) {
                child.emit('close', 0);
            });
            servers.forEach(function (server) {
                clearInterval(server.queryStatusInterval);
                (server.headlessClientTimers || []).forEach(clearTimeout);
            });
            tmpDirs.forEach(function (dir) {
                fs.readdirSync(dir).forEach(function (file) {
                    fs.unlinkSync(path.join(dir, file));
                });
                fs.rmdirSync(dir);
            });

            ArmaServer.Headless.prototype.start = origHeadlessStart;
            ArmaServer.Server.prototype.start = origServerStart;
            ArmaServer.Server.prototype.writeServerConfig = origWriteServerConfig;
            moduleConfig.parameters = origParameters;
            Server.headlessClientStartDelay = origDelay;
            Server.headlessClientStartInterval = origInterval;
            Server.stopTimeout = origStopTimeout;
            console.log = origConsoleLog;
        });

        describe('getHeadlessClientParameters() (B6)', function () {
            var cases = [
                [['-profiles=C:\\Arma\\P\\', '-name=7R'], 0, ['-noSound', '-name=7R', '-profiles=C:\\Arma\\P\\HC_0']],
                [['-profiles=C:\\Arma\\P\\', '-name=7R'], 1, ['-noSound', '-name=7R', '-profiles=C:\\Arma\\P\\HC_1']],
                [['-profiles="C:\\Arma\\P\\"'], 0, ['-noSound', '-profiles=C:\\Arma\\P\\HC_0']],
                [['-name=7R'], 0, ['-noSound', '-name=7R']],
                [undefined, 0, ['-noSound']]
            ];

            cases.forEach(function (c) {
                it('should give ' + JSON.stringify(c[2]) + ' for ' + JSON.stringify(c[0]) + ' index ' + c[1], function () {
                    var server = makeServer({parameters: c[0]}, 'windows');
                    server.getHeadlessClientParameters(c[1]).should.eql(c[2]);
                });
            });

            it('should use the server profiles over the global one on linux', function () {
                moduleConfig.parameters = ['-profiles=/global'];
                var server = makeServer({parameters: ['-profiles=/own']}, 'linux');
                server.getHeadlessClientParameters(0).should.eql(['-profiles=/own/HC_0']);
            });

            it('should fall back to the global profiles on linux', function () {
                moduleConfig.parameters = ['-profiles=/global'];
                var server = makeServer({parameters: []}, 'linux');
                server.getHeadlessClientParameters(2).should.eql(['-profiles=/global/HC_2']);
            });

            it('should return a copy when there is no profiles parameter', function () {
                var server = makeServer({parameters: ['-name=7R']}, 'windows');
                var result = server.getHeadlessClientParameters(0);
                (result === server.getParameters()).should.be.false();
            });
        });

        describe('server parameters (B7)', function () {
            it('should leave getParameters() and the server options untouched', function () {
                var server = makeServer({
                    parameters: ['-profiles=C:\\Arma\\P\\'],
                    number_of_headless_clients: 2
                });

                server.start();

                server.getParameters().should.eql(['-noSound', '-profiles=C:\\Arma\\P\\']);
                serverOptions.length.should.eql(1);
                serverOptions[0].parameters.should.eql(['-noSound', '-profiles=C:\\Arma\\P\\']);
            });
        });

        describe('start() staggering (B8)', function () {
            it('should spawn nothing synchronously and then one HC per interval', function (done) {
                var server = makeServer({number_of_headless_clients: 2});

                server.start();
                hcCalls.should.eql(0);
                server.headlessClientInstances.should.eql([]);

                later(DELAY / 2, function () {
                    hcCalls.should.eql(0);
                });

                later(DELAY + 20, function () {
                    hcCalls.should.eql(1);
                });

                later(DELAY + INTERVAL + 40, function () {
                    hcCalls.should.eql(2);
                    hcOptions[0].parameters.should.eql(server.getHeadlessClientParameters(0));
                    hcOptions[1].parameters.should.eql(server.getHeadlessClientParameters(1));
                    server.headlessClientInstances.length.should.eql(2);
                    done();
                });
            });

            it('should give each HC its own profiles folder', function (done) {
                var server = makeServer({
                    parameters: ['-profiles=C:\\Arma\\P\\'],
                    number_of_headless_clients: 2
                });

                server.start();

                later(DELAY + INTERVAL + 40, function () {
                    hcOptions.length.should.eql(2);
                    hcOptions[0].parameters.should.containEql('-profiles=C:\\Arma\\P\\HC_0');
                    hcOptions[1].parameters.should.containEql('-profiles=C:\\Arma\\P\\HC_1');
                    hcOptions[0].parameters.should.not.containEql('-profiles=C:\\Arma\\P\\');
                    hcOptions[1].parameters.should.not.containEql('-profiles=C:\\Arma\\P\\');
                    done();
                });
            });

            it('should schedule nothing when the server has no instance', function (done) {
                var server = makeServer({number_of_headless_clients: 2});

                server.startHeadlessClients();

                later(DELAY + INTERVAL + 40, function () {
                    hcCalls.should.eql(0);
                    done();
                });
            });

            it('should clear timers of an earlier schedule when scheduling again', function (done) {
                var server = makeServer({number_of_headless_clients: 2});

                server.start();
                server.startHeadlessClients();

                later(DELAY + INTERVAL + 60, function () {
                    hcCalls.should.eql(2);
                    done();
                });
            });
        });

        describe('startHeadlessClient() (B9)', function () {
            var started = function (type, logs) {
                var server = makeServer({
                    file_patching: true,
                    mods: ['@a', '@b'],
                    password: 'pw',
                    port: 2302,
                    parameters: ['-profiles=C:\\Arma\\P\\'],
                    number_of_headless_clients: 1
                }, type, logs);

                server.instance = fakeChild();
                server.headlessClientInstances = [];
                return server;
            };

            it('should spawn one HC now with the usual options and its own parameters', function () {
                var server = started('windows');
                var child = server.startHeadlessClient(1);

                hcCalls.should.eql(1);
                (child === hcChildren[0]).should.be.true();

                var options = hcOptions[0];
                options.filePatching.should.eql(true);
                options.game.should.eql(moduleConfig.game);
                options.host.should.eql('127.0.0.1');
                options.mods.should.eql(['@a', '@b']);
                options.password.should.eql('pw');
                options.path.should.eql('/tmp/arma');
                options.platform.should.eql('windows');
                options.port.should.eql(2302);
                options.parameters.should.eql(server.getHeadlessClientParameters(1));
            });

            it('should track the child and drop it on close', function () {
                var server = started('windows');
                var child = server.startHeadlessClient(0);

                server.headlessClientInstances.should.eql([child]);
                var current = server.headlessClientInstances;

                child.emit('close', 0);
                current.length.should.eql(0);
                server.headlessClientInstances.length.should.eql(0);
            });

            it('should log HC output with the server id and HC index as prefix', function () {
                var server = started('windows');
                var logged = [];
                console.log = function () {
                    logged.push(Array.prototype.slice.call(arguments).join(' '));
                };

                var child = server.startHeadlessClient(1);
                child.stdout.emit('data', Buffer.from('hello out'));
                child.stderr.emit('data', Buffer.from('hello err'));
                child.emit('close', 0);
                console.log = origConsoleLog;

                logged.some(function (line) {
                    return line.indexOf('test HC_1') !== -1;
                }).should.be.true();
            });

            ['windows', 'wine'].forEach(function (type) {
                it('should not create an HC log file on ' + type, function () {
                    var suffixes = [];
                    var server = started(type, logsStub(os.tmpdir(), suffixes));

                    var child = server.startHeadlessClient(0);
                    child.stdout.emit('data', Buffer.from('x'));
                    child.emit('close', 0);

                    suffixes.should.eql([]);
                });
            });

            it('should capture stdout and stderr to the HC log file on linux', function (done) {
                var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-logs-'));
                tmpDirs.push(dir);
                var suffixes = [];
                var server = started('linux', logsStub(dir, suffixes));

                var child = server.startHeadlessClient(1);
                suffixes.should.eql(['test_HC_1']);

                child.stdout.emit('data', Buffer.from('out1;'));
                child.stderr.emit('data', Buffer.from('err1;'));
                child.stdout.emit('data', Buffer.from('out2;'));
                child.emit('close', 0);

                var file = path.join(dir, 'log_test_HC_1.log');
                var attempts = 0;
                var poll = function () {
                    var content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
                    if (content.length >= 15 || attempts++ > 100) {
                        content.should.eql('out1;err1;out2;');
                        suffixes.should.eql(['test_HC_1']);
                        return done();
                    }
                    setTimeout(poll, 10);
                };
                poll();
            });
        });

        describe('failing HC start (B10)', function () {
            it('should be caught, logged, and not stop later HCs', function (done) {
                var logged = [];
                hcThrowOnFirst = true;
                var server = makeServer({number_of_headless_clients: 2});
                console.log = function () {
                    logged.push(Array.prototype.slice.call(arguments).join(' '));
                };

                server.start();

                later(DELAY + INTERVAL + 60, function () {
                    console.log = origConsoleLog;
                    hcCalls.should.eql(2);
                    hcChildren.length.should.eql(1);
                    logged.some(function (line) {
                        return line.indexOf('test HC_0') !== -1;
                    }).should.be.true();
                    done();
                });
            });
        });

        describe('stopping (B11)', function () {
            it('should not throw when the server never started', function () {
                var server = makeServer({number_of_headless_clients: 2});
                server.stopHeadlessClients.bind(server).should.not.throw();
            });

            it('should spawn no HC when the server closes before HC_0 starts', function (done) {
                var server = makeServer({number_of_headless_clients: 2});

                server.start();
                serverChildren[0].emit('close', 0);

                later(DELAY + INTERVAL + 60, function () {
                    hcCalls.should.eql(0);
                    done();
                });
            });

            it('should kill started HCs and never spawn the later ones', function (done) {
                var server = makeServer({number_of_headless_clients: 2});

                server.start();

                later(DELAY + 20, function () {
                    hcCalls.should.eql(1);
                    serverChildren[0].emit('close', 0);
                    hcChildren[0].killCount.should.eql(1);
                });

                later(DELAY + INTERVAL + 60, function () {
                    hcCalls.should.eql(1);
                    done();
                });
            });
        });

        describe('without headless clients (B12)', function () {
            [0, undefined].forEach(function (count) {
                it('should construct no HC and keep no timers for ' + count, function (done) {
                    var server = makeServer({number_of_headless_clients: count});

                    server.start();

                    later(DELAY + 40, function () {
                        hcCalls.should.eql(0);
                        (server.headlessClientTimers || []).length.should.eql(0);
                        done();
                    });
                });
            });
        });

        describe('review fixes (unit 04)', function () {
            it('R3: should spawn HCs with the settings the server started with', function (done) {
                moduleConfig.parameters = [];
                var server = makeServer({
                    port: 2302,
                    password: 'a',
                    mods: ['@a'],
                    file_patching: false,
                    parameters: ['-profiles=C:\\P'],
                    number_of_headless_clients: 1
                });

                server.start();

                server.update({
                    title: 'test',
                    port: 2402,
                    password: 'b',
                    mods: ['@b'],
                    file_patching: true,
                    parameters: ['-profiles=C:\\Q'],
                    number_of_headless_clients: 1
                });

                later(DELAY + 40, function () {
                    hcCalls.should.eql(1);
                    hcOptions[0].port.should.eql(2302);
                    hcOptions[0].password.should.eql('a');
                    hcOptions[0].mods.should.eql(['@a']);
                    hcOptions[0].filePatching.should.eql(false);
                    hcOptions[0].parameters.should.eql(['-profiles=C:\\P\\HC_0']);
                    done();
                });
            });

            it('R3: headlessClientOptions() should return a copy of the mods', function () {
                var server = makeServer({mods: ['@a']});
                var options = server.headlessClientOptions(0);

                options.mods.should.eql(['@a']);
                (options.mods === server.mods).should.be.false();
            });

            it('R3: startHeadlessClient() should use the options it is given', function () {
                var server = makeServer({port: 2302, number_of_headless_clients: 1});
                server.instance = fakeChild();
                server.headlessClientInstances = [];

                var options = server.headlessClientOptions(0);
                options.port = 9999;
                server.startHeadlessClient(0, options);

                hcOptions[0].port.should.eql(9999);
            });

            it('R4: stop() should cancel pending HC starts even when the process hangs', function (done) {
                var server = makeServer({number_of_headless_clients: 2});
                var calls = 0;

                server.start();
                // A hung process: kill() never leads to close.
                serverChildren[0].kill = function () {
                    serverChildren[0].killCount++;
                };

                server.stop(function () {
                    calls++;
                });

                later(DELAY + 2 * INTERVAL + 60, function () {
                    hcCalls.should.eql(0);
                    calls.should.eql(1);
                    done();
                });
            });

            it('R5: should name the server capture and HC captures after the server id on linux', function (done) {
                var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-logs-'));
                tmpDirs.push(dir);
                var suffixes = [];
                var server = makeServer({number_of_headless_clients: 1}, 'linux', logsStub(dir, suffixes));

                server.start();
                suffixes.should.eql(['test']);

                later(DELAY + 40, function () {
                    suffixes.should.eql(['test', 'test_HC_0']);
                    // let the capture streams open before cleanup removes the directory
                    later(50, done);
                });
            });
        });

        describe('restart() (B13)', function () {
            it('should spawn HC_0 once for the new process, not for the old timer', function (done) {
                var server = makeServer({number_of_headless_clients: 1});

                server.start();

                server.restart(function (err) {
                    (err === undefined || err === null).should.be.true();
                    serverChildren.length.should.eql(2);

                    later(DELAY + INTERVAL + 60, function () {
                        hcCalls.should.eql(1);
                        done();
                    });
                });
            });

            it('should kill the old HC and spawn one for the new process', function (done) {
                var server = makeServer({number_of_headless_clients: 1});

                server.start();

                later(DELAY + 20, function () {
                    hcCalls.should.eql(1);

                    server.restart(function (err) {
                        (err === undefined || err === null).should.be.true();
                        hcChildren[0].killCount.should.eql(1);

                        later(DELAY + INTERVAL + 60, function () {
                            hcCalls.should.eql(2);
                            done();
                        });
                    });
                });
            });
        });
    });
});
