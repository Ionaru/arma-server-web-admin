require('should');
var events = require('events');
var util = require('util');

var OpModeNotifier = require('../../lib/op-mode-notifier.js');

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

// A fake op server whose waitUntilOnline outcome the test controls.
var fakeOpServer = function (title, onlineBehaviour) {
    return {
        title: title,
        waitUntilOnline: function (timeoutMs, cb) {
            onlineBehaviour(cb);
        }
    };
};

var FakeOpMode = function () {
    events.EventEmitter.call(this);
};
util.inherits(FakeOpMode, events.EventEmitter);

describe('OpModeNotifier', function () {
    it('announces the restart when a run starts', function () {
        var opMode = new FakeOpMode();
        var discord = new FakeDiscord();
        new OpModeNotifier(opMode, discord);

        opMode.emit('run-started', fakeOpServer('Op Server', function () {}));

        discord.sent[0].should.eql('🔄 Restarting **Op Server** for the operation.');
    });

    it('announces back online with a duration once the server is up', function () {
        var opMode = new FakeOpMode();
        var discord = new FakeDiscord();
        new OpModeNotifier(opMode, discord);

        // Resolve online immediately (synchronously) so no real timer is involved.
        opMode.emit('run-started', fakeOpServer('Op Server', function (cb) {
            cb(null);
        }));

        discord.sent.length.should.eql(2);
        discord.sent[1].should.match(/^✅ \*\*Op Server\*\* is back online \(took .+\)\.$/);
    });

    it('announces a timeout when the server does not come up', function () {
        var opMode = new FakeOpMode();
        var discord = new FakeDiscord();
        new OpModeNotifier(opMode, discord);

        opMode.emit('run-started', fakeOpServer('Op Server', function (cb) {
            cb(new Error('did not come online in time'));
        }));

        discord.sent.length.should.eql(2);
        discord.sent[1].should.eql('⚠️ **Op Server** has not come back online after 15 minutes.');
    });

    it('announces an immediate restart failure and does not also announce online', function () {
        var opMode = new FakeOpMode();
        var discord = new FakeDiscord();
        new OpModeNotifier(opMode, discord);

        var onlineCb = null;
        var op = fakeOpServer('Op Server', function (cb) {
            onlineCb = cb;   // keep the online wait pending
        });

        opMode.emit('run-started', op);
        opMode.emit('run-failed', op, new Error('did not stop in time'));

        // Even if the online wait were to resolve later, it must be ignored after a failure.
        if (onlineCb) {
            onlineCb(null);
        }

        discord.sent.length.should.eql(2);
        discord.sent[0].should.eql('🔄 Restarting **Op Server** for the operation.');
        discord.sent[1].should.eql('⚠️ **Op Server** failed to restart: did not stop in time.');
    });

    it('stays completely silent when Discord is not configured', function () {
        var opMode = new FakeOpMode();
        var discord = new FakeDiscord(false);
        new OpModeNotifier(opMode, discord);

        opMode.emit('run-started', fakeOpServer('Op Server', function (cb) {
            cb(null);
        }));

        discord.sent.length.should.eql(0);
    });

    it('formats sub-minute durations as seconds only', function () {
        OpModeNotifier.formatDuration(4000).should.eql('4s');
        OpModeNotifier.formatDuration(252000).should.eql('4m 12s');
        OpModeNotifier.formatDuration(60000).should.eql('1m 0s');
    });
});
