// Turns op mode run events into Discord messages. Deliberately separate from lib/op-mode.js: op
// mode carries fleet-stopping invariants and should not also own a Discord client, a 15 minute
// timer, and "wait until online" state. This module holds the only new state in the feature.

var OpModeNotifier = function (opMode, discord, options) {
    options = options || {};

    this.discord = discord;

    // The online-wait timeout is operator-configurable in minutes (config.discord.onlineTimeoutMinutes).
    // Both the setTimeout and the "after N minutes" warning derive from this one value, so the message
    // can never contradict the actual wait.
    this.onlineTimeoutMinutes = OpModeNotifier.resolveTimeoutMinutes(options.onlineTimeoutMinutes);
    this.onlineTimeoutMs = this.onlineTimeoutMinutes * 60 * 1000;

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

// The online-wait timeout in minutes when config.js does not set discord.onlineTimeoutMinutes.
OpModeNotifier.defaultOnlineTimeoutMinutes = 15;

// Only honour a positive, finite number of minutes. Anything else (missing, zero, negative, or a
// value the operator typed as a string) falls back to the default rather than arming a nonsensical
// or immediate timeout: the same fail-safe posture op mode takes with a bad schedule.
OpModeNotifier.resolveTimeoutMinutes = function (minutes) {
    if (typeof minutes === 'number' && isFinite(minutes) && minutes > 0) {
        return minutes;
    }

    return OpModeNotifier.defaultOnlineTimeoutMinutes;
};

// "15 minutes" / "1 minute". The warning message reads the configured value through this, so it
// always matches the timeout actually in force.
OpModeNotifier.formatTimeoutMinutes = function (minutes) {
    return minutes + (minutes === 1 ? ' minute' : ' minutes');
};

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
            return self.post('⚠️ **' + opServer.title + '** has not come back online after ' +
                OpModeNotifier.formatTimeoutMinutes(self.onlineTimeoutMinutes) + '.');
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
