// Turns op mode run events into Discord messages. Deliberately separate from lib/op-mode.js: op
// mode carries fleet-stopping invariants and should not also own a Discord client, a 15 minute
// timer, and "wait until online" state. This module holds the only new state in the feature.

var OpModeNotifier = function (opMode, discord, options) {
    options = options || {};

    this.discord = discord;
    this.onlineTimeoutMs = options.onlineTimeoutMs || OpModeNotifier.onlineTimeoutMs;

    // The in-flight run, if any: {server, startedAt, done}. done guards against sending more than
    // one terminal message (online / timeout / failed) for a single run.
    this.current = null;

    var self = this;

    opMode.on('run-started', function (opServer) {
        self.onRunStarted(opServer);
    });

    opMode.on('run-failed', function (opServer, err) {
        self.onRunFailed(opServer, err);
    });
};

// The online-wait timeout, matching the "15 minutes" wording in the messages. Named so tests can
// shorten it, like Server.stopTimeout and OpMode.tickMs.
OpModeNotifier.onlineTimeoutMs = 15 * 60 * 1000;

OpModeNotifier.formatDuration = function (ms) {
    var totalSeconds = Math.round(ms / 1000);
    var minutes = Math.floor(totalSeconds / 60);
    var seconds = totalSeconds % 60;

    if (minutes === 0) {
        return seconds + 's';
    }

    return minutes + 'm ' + seconds + 's';
};

// Fire-and-forget: a failed Discord post is logged and swallowed so a Discord outage can never look
// like an op mode failure.
OpModeNotifier.prototype.post = function (content) {
    if (!this.discord.isConfigured()) {
        return;
    }

    this.discord.send(content, function (err) {
        if (err) {
            console.error('op-mode-notifier: could not post to Discord: ' + err.message);
        }
    });
};

OpModeNotifier.prototype.onRunStarted = function (opServer) {
    if (!this.discord.isConfigured()) {
        return;
    }

    var self = this;
    var run = {server: opServer, startedAt: Date.now(), done: false};
    this.current = run;

    this.post('🔄 Restarting **' + opServer.title + '** for the operation.');

    opServer.waitUntilOnline(this.onlineTimeoutMs, function (err) {
        if (run.done) {
            return;
        }

        run.done = true;

        if (err) {
            return self.post('⚠️ **' + opServer.title +
                '** has not come back online after 15 minutes.');
        }

        var took = OpModeNotifier.formatDuration(Date.now() - run.startedAt);
        self.post('✅ **' + opServer.title + '** is back online (took ' + took + ').');
    });
};

OpModeNotifier.prototype.onRunFailed = function (opServer, err) {
    // Cancel any pending online wait for this run: only the failure message should go out.
    if (this.current) {
        this.current.done = true;
    }

    if (!this.discord.isConfigured()) {
        return;
    }

    this.post('⚠️ **' + opServer.title + '** failed to restart: ' + err.message + '.');
};

module.exports = OpModeNotifier;
