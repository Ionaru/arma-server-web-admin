require('should');
var events = require('events');
var util = require('util');

var OpModeNotifier = require('../../lib/op-mode-notifier.js');
var Server = require('../../lib/server.js');

// Records every send() and lets a test resolve/inspect it.
var FakeDiscord = function (configured) {
    this.configured = configured === undefined ? true : configured;
    this.sent = [];
};
FakeDiscord.prototype.isConfigured = function () {
    return this.configured;
};
FakeDiscord.prototype.send = function (content, cb) {
    this.sent.push(content);
    if (cb) {
        cb(null);
    }
};

// A fake op server whose waitUntilOnline outcome the test controls. Records how many times a wait
// was armed and cancelled, and hands the behaviour the timeoutMs it was called with. Returns a
// cancel handle, matching the real Server.waitUntilOnline contract.
var fakeOpServer = function (title, onlineBehaviour) {
    var server = {
        title: title,
        waitCalls: 0,
        cancelled: 0,
        waitUntilOnline: function (timeoutMs, cb) {
            server.waitCalls++;

            if (onlineBehaviour) {
                onlineBehaviour(cb, timeoutMs);
            }

            return function cancel() {
                server.cancelled++;
            };
        }
    };

    return server;
};

var FakeOpMode = function () {
    events.EventEmitter.call(this);
};
util.inherits(FakeOpMode, events.EventEmitter);

// Drive a full successful run: announce, then the restart spawns the replacement (run-restarted).
var runAndRestart = function (opMode, opServer) {
    opMode.emit('run-started', opServer);
    opMode.emit('run-restarted', opServer);
};

describe('OpModeNotifier', function () {
    it('announces the restart when a run starts', function () {
        var opMode = new FakeOpMode();
        var discord = new FakeDiscord();
        new OpModeNotifier(opMode, discord);

        opMode.emit('run-started', fakeOpServer('Op Server'));

        discord.sent[0].should.eql('🔄 Restarting **Op Server** for the operation.');
    });

    it('does not arm the online wait at run-started, only after the restart', function () {
        var opMode = new FakeOpMode();
        var discord = new FakeDiscord();
        new OpModeNotifier(opMode, discord);

        var op = fakeOpServer('Op Server', function () {});

        opMode.emit('run-started', op);
        op.waitCalls.should.eql(0);   // the old process is still up here

        opMode.emit('run-restarted', op);
        op.waitCalls.should.eql(1);
    });

    it('announces back online with a duration once the replacement server is up', function () {
        var opMode = new FakeOpMode();
        var discord = new FakeDiscord();
        new OpModeNotifier(opMode, discord);

        var op = fakeOpServer('Op Server', function (cb) {
            cb(null);   // resolve online immediately, synchronously
        });

        runAndRestart(opMode, op);

        discord.sent.length.should.eql(2);
        discord.sent[1].should.match(/^✅ \*\*Op Server\*\* is back online \(took .+\)\.$/);
    });

    it('announces a timeout when the server does not come up', function () {
        var opMode = new FakeOpMode();
        var discord = new FakeDiscord();
        new OpModeNotifier(opMode, discord);

        var op = fakeOpServer('Op Server', function (cb) {
            var err = new Error('did not come online in time');
            err.reason = 'timeout';
            cb(err);
        });

        runAndRestart(opMode, op);

        discord.sent.length.should.eql(2);
        discord.sent[1].should.eql('⚠️ **Op Server** has not come back online after 15 minutes.');
    });

    it('announces an offline-during-startup failure distinctly from a timeout', function () {
        var opMode = new FakeOpMode();
        var discord = new FakeDiscord();
        new OpModeNotifier(opMode, discord);

        var op = fakeOpServer('Op Server', function (cb) {
            var err = new Error('stopped before it came online');
            err.reason = 'offline';
            cb(err);
        });

        runAndRestart(opMode, op);

        discord.sent.length.should.eql(2);
        discord.sent[1].should.eql('⚠️ **Op Server** started but went offline again before coming online.');
    });

    it('announces an immediate restart failure and never arms an online wait', function () {
        var opMode = new FakeOpMode();
        var discord = new FakeDiscord();
        new OpModeNotifier(opMode, discord);

        var op = fakeOpServer('Op Server', function () {
            throw new Error('online wait must not be armed on the failure path');
        });

        opMode.emit('run-started', op);
        opMode.emit('run-failed', op, new Error('did not stop in time'));

        op.waitCalls.should.eql(0);
        discord.sent.length.should.eql(2);
        discord.sent[0].should.eql('🔄 Restarting **Op Server** for the operation.');
        discord.sent[1].should.eql('⚠️ **Op Server** failed to restart: did not stop in time.');
    });

    it('ignores a stray run-restarted after a failure', function () {
        var opMode = new FakeOpMode();
        var discord = new FakeDiscord();
        new OpModeNotifier(opMode, discord);

        var op = fakeOpServer('Op Server', function (cb) {
            cb(null);
        });

        opMode.emit('run-started', op);
        opMode.emit('run-failed', op, new Error('boom'));
        opMode.emit('run-restarted', op);   // must be ignored: the run already ended

        op.waitCalls.should.eql(0);
        discord.sent.length.should.eql(2);
        discord.sent[1].should.eql('⚠️ **Op Server** failed to restart: boom.');
    });

    it('cancels a pending online wait when a new run supersedes it', function () {
        var opMode = new FakeOpMode();
        var discord = new FakeDiscord();
        new OpModeNotifier(opMode, discord);

        // The first run's wait stays pending (never calls back).
        var op = fakeOpServer('Op Server', function () {});

        runAndRestart(opMode, op);
        op.waitCalls.should.eql(1);
        op.cancelled.should.eql(0);

        // A second run begins before the first server came online: running clears at spawn.
        opMode.emit('run-started', op);
        op.cancelled.should.eql(1);
    });

    it('stays completely silent when Discord is not configured', function () {
        var opMode = new FakeOpMode();
        var discord = new FakeDiscord(false);
        new OpModeNotifier(opMode, discord);

        var op = fakeOpServer('Op Server', function (cb) {
            cb(null);
        });

        runAndRestart(opMode, op);

        discord.sent.length.should.eql(0);
        op.waitCalls.should.eql(0);
    });

    it('does nothing on run-failed when Discord is not configured', function () {
        var opMode = new FakeOpMode();
        var discord = new FakeDiscord(false);
        new OpModeNotifier(opMode, discord);

        (function () {
            opMode.emit('run-failed', fakeOpServer('Op Server'), new Error('boom'));
        }).should.not.throw();

        discord.sent.length.should.eql(0);
    });

    it('passes the configured timeout through to the online wait', function () {
        var opMode = new FakeOpMode();
        var discord = new FakeDiscord();
        new OpModeNotifier(opMode, discord, {onlineTimeoutMinutes: 10});

        var capturedTimeout = null;
        var op = fakeOpServer('Op Server', function (cb, timeoutMs) {
            capturedTimeout = timeoutMs;
        });

        runAndRestart(opMode, op);

        capturedTimeout.should.eql(10 * 60 * 1000);
    });

    it('reflects the configured timeout in the not-back-online message', function () {
        var opMode = new FakeOpMode();
        var discord = new FakeDiscord();
        new OpModeNotifier(opMode, discord, {onlineTimeoutMinutes: 10});

        var op = fakeOpServer('Op Server', function (cb) {
            var err = new Error('did not come online in time');
            err.reason = 'timeout';
            cb(err);
        });

        runAndRestart(opMode, op);

        discord.sent[1].should.eql('⚠️ **Op Server** has not come back online after 10 minutes.');
    });

    it('uses the singular minute for a one minute timeout', function () {
        var opMode = new FakeOpMode();
        var discord = new FakeDiscord();
        new OpModeNotifier(opMode, discord, {onlineTimeoutMinutes: 1});

        var op = fakeOpServer('Op Server', function (cb) {
            var err = new Error('nope');
            err.reason = 'timeout';
            cb(err);
        });

        runAndRestart(opMode, op);

        discord.sent[1].should.eql('⚠️ **Op Server** has not come back online after 1 minute.');
    });

    it('falls back to fifteen minutes when the configured timeout is not a positive number', function () {
        var opMode = new FakeOpMode();
        var discord = new FakeDiscord();
        new OpModeNotifier(opMode, discord, {onlineTimeoutMinutes: -5});

        var capturedTimeout = null;
        var op = fakeOpServer('Op Server', function (cb, timeoutMs) {
            capturedTimeout = timeoutMs;
            var err = new Error('nope');
            err.reason = 'timeout';
            cb(err);
        });

        runAndRestart(opMode, op);

        capturedTimeout.should.eql(15 * 60 * 1000);
        discord.sent[1].should.eql('⚠️ **Op Server** has not come back online after 15 minutes.');
    });

    it('formats sub-minute durations as seconds only', function () {
        OpModeNotifier.formatDuration(4000).should.eql('4s');
        OpModeNotifier.formatDuration(252000).should.eql('4m 12s');
        OpModeNotifier.formatDuration(60000).should.eql('1m 0s');
    });

    describe('resolveTimeoutMinutes()', function () {
        it('accepts a positive, finite number', function () {
            OpModeNotifier.resolveTimeoutMinutes(10).should.eql(10);
            OpModeNotifier.resolveTimeoutMinutes(2.5).should.eql(2.5);
        });

        it('falls back to 15 for anything else', function () {
            OpModeNotifier.resolveTimeoutMinutes(0).should.eql(15);
            OpModeNotifier.resolveTimeoutMinutes(-5).should.eql(15);
            OpModeNotifier.resolveTimeoutMinutes(undefined).should.eql(15);
            OpModeNotifier.resolveTimeoutMinutes('10').should.eql(15);
            OpModeNotifier.resolveTimeoutMinutes(NaN).should.eql(15);
            OpModeNotifier.resolveTimeoutMinutes(Infinity).should.eql(15);
        });
    });

    describe('formatTimeoutMinutes()', function () {
        it('pluralizes minutes, singular only at one', function () {
            OpModeNotifier.formatTimeoutMinutes(15).should.eql('15 minutes');
            OpModeNotifier.formatTimeoutMinutes(1).should.eql('1 minute');
            OpModeNotifier.formatTimeoutMinutes(2).should.eql('2 minutes');
        });
    });

    // The bug the original design shipped with: the wait was armed at run-started while the op
    // server was still the old, still-polling process, so its next routine gamedig poll resolved a
    // false "back online" before the server was even stopped. These drive a real Server.
    describe('integration with a real Server', function () {
        it('does not post "back online" from the old instance still polling at run-started', function () {
            var opMode = new FakeOpMode();
            var discord = new FakeDiscord();
            new OpModeNotifier(opMode, discord, {onlineTimeoutMinutes: 15});

            var op = new Server(null, null, {title: 'Op Server'});
            op.instance = {pid: 1};      // the op server is up...
            op.state = {players: []};    // ...and gamedig currently reports it online

            opMode.emit('run-started', op);
            op.emit('state');            // a routine poll of the still-running old instance

            discord.sent.length.should.eql(1);
            discord.sent[0].should.match(/^🔄/);
            op.listenerCount('state').should.eql(0);   // nothing armed against the old process
        });

        it('posts "back online" only once the replacement instance answers after the restart', function () {
            var opMode = new FakeOpMode();
            var discord = new FakeDiscord();
            new OpModeNotifier(opMode, discord, {onlineTimeoutMinutes: 15});

            var op = new Server(null, null, {title: 'Op Server'});
            op.instance = {pid: 1};
            op.state = {players: []};

            opMode.emit('run-started', op);

            // The restart runs: the old process is gone, a replacement is spawned but not answering.
            op.instance = {pid: 2};
            op.state = null;
            opMode.emit('run-restarted', op);

            // A poll where the replacement is not up yet must not resolve it.
            op.emit('state');
            discord.sent.length.should.eql(1);

            // The replacement answers gamedig.
            op.state = {players: []};
            op.emit('state');

            discord.sent.length.should.eql(2);
            discord.sent[1].should.match(/^✅ \*\*Op Server\*\* is back online/);
            op.listenerCount('state').should.eql(0);   // listener cleaned up on settle
        });
    });
});
