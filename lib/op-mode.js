var async = require('async');
var events = require('events');
var fs = require('fs');
var util = require('util');

var schedule = require('./op-schedule');

var filePath = 'op-mode.json';

// Canonicalise a stored window timestamp, so the string comparison in tick() is well defined.
var parseWindow = function (value) {
    if (typeof value !== 'string') {
        return null;
    }

    var date = new Date(value);

    return isNaN(date.getTime()) ? null : date.toISOString();
};

var OpMode = function (manager, file) {
    events.EventEmitter.call(this);

    this.manager = manager;
    this.filePath = file || filePath;

    this.config = {
        enabled: false,
        days: [],
        time: '19:30',
        opServerId: null,
        opServerTitle: null
    };

    this.nextRun = null;
    this.lastWindow = null;     // the last scheduled occurrence this instance has consumed
    this.lastSkipped = null;    // the last occurrence that was passed over for being too late
    this.loadFailed = null;
    this.opServerMissing = false;
    this.running = false;
    this.timer = null;
    this.saving = false;
    this.savePending = null;
    this.lastError = null;      // why the most recent run failed, so the panel can say so
};

util.inherits(OpMode, events.EventEmitter);

// How often the schedule is checked. Matches the gamedig poll cadence in lib/server.js, and the
// tick itself is a couple of date comparisons, so this is far cheaper than the polling the process
// already does per running server.
OpMode.tickMs = 5000;

// How late a window may be fired. Must comfortably exceed tickMs so ordinary timer jitter never
// looks like a missed window, and must stay far below the 24h minimum gap between occurrences.
// This bound is what stops a suspended machine resuming at 03:00 and killing every server.
OpMode.graceMs = 90000;

OpMode.prototype.load = function (cb) {
    cb = cb || function () {};

    var self = this;

    fs.readFile(this.filePath, function (err, data) {
        if (err && err.code === 'ENOENT') {
            // Genuine first run.
            self.refresh();
            self.startTicker();
            return cb();
        }

        if (err) {
            self.fail('Could not read ' + self.filePath + ': ' + err.message);
            self.startTicker();
            return cb();
        }

        var parsed;

        try {
            parsed = JSON.parse(data);
        } catch (e) {
            self.fail(self.filePath + ' is not valid JSON: ' + e.message);
            self.startTicker();
            return cb();
        }

        var result = schedule.normalizeConfig(parsed);

        if (result.error) {
            self.fail(self.filePath + ' is not a valid schedule: ' + result.error);
            self.startTicker();
            return cb();
        }

        self.config = result.config;
        // Normalise rather than trusting the string. tick() compares lastWindow with > , so a
        // hand-edited value like "yesterday" would otherwise sort above every real timestamp and
        // silently stop op night forever, with nothing shown in the UI.
        self.lastWindow = parseWindow(parsed.lastWindow);
        self.refresh();
        self.startTicker();

        cb();
    });
};

// A schedule we could not read is not a schedule that says "nothing tonight". Record why, leave
// nextRun null, and let tick() refuse to fire until an operator saves a good config.
OpMode.prototype.fail = function (reason) {
    console.error('op-mode: ' + reason);
    this.loadFailed = reason;
    this.nextRun = null;
    this.emit('op-mode');
};

OpMode.prototype.startTicker = function () {
    var self = this;

    this.stopTicker();

    this.timer = setInterval(function () {
        self.tick();
    }, OpMode.tickMs);

    // Do not hold the process open purely for the schedule.
    if (this.timer.unref) {
        this.timer.unref();
    }
};

OpMode.prototype.stopTicker = function () {
    if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
    }
};

// Firing is decided by the most recent occurrence at or before now, recomputed every tick. That one
// rule covers the normal case, a panel restarting inside the window, a window missed while the
// process was down, and a clock stepped forwards, without a separate catch-up path for any of them.
//
// Backward clock steps (NTP correction, VM time sync, someone changing the clock) are handled by
// only ever consuming a window strictly newer than the last one. Note the deliberate consequence:
// if the host clock was running ahead and gets pulled back, the future-dated lastWindow suppresses
// firing until the schedule passes it again. That is fail-closed, which is the right trade for a
// feature whose failure mode is killing every running server. Do not "fix" it back into a
// double-fire.
OpMode.prototype.tick = function () {
    // Nothing in here may throw: an uncaught exception from a setInterval callback would take the
    // whole panel down, and there is no uncaughtException handler anywhere in this app.
    try {
        if (this.loadFailed) {
            return;
        }

        var self = this;
        var now = new Date();
        var previous = schedule.previousRunAtOrBefore(this.config, now);

        if (previous) {
            var window = previous.toISOString();

            // Strictly newer, not merely different: a backward clock step makes previous go back a
            // week, and an inequality test would rewrite lastWindow backwards and let the real
            // window fire a second time.
            if (!this.lastWindow || window > this.lastWindow) {
                var lateBy = now.getTime() - previous.getTime();

                // Mark the window consumed before running. In memory this is what stops a tick
                // landing mid-run from consuming it twice. The write is initiated here and
                // completes asynchronously, which is soon enough: a run spends seconds stopping
                // servers, so the window is on disk long before the run finishes.
                this.lastWindow = window;
                this.save();

                if (lateBy <= OpMode.graceMs) {
                    this.lastSkipped = null;
                    this.run(function (err) {
                        if (err) {
                            // Also surfaced in getState, so a failed op night is visible in the
                            // panel rather than only in a console nobody is watching.
                            self.lastError = err.message;
                            self.emit('op-mode');
                            console.error('op-mode: run failed: ' + err.message);
                        }
                    });
                } else {
                    this.lastSkipped = previous;
                    console.warn('op-mode: skipping window ' + window + ', missed by ' +
                        Math.round(lateBy / 1000) + 's');
                }
            }
        }

        this.refresh();
    } catch (err) {
        console.error('op-mode: tick failed: ' + err.message);
    }
};

// Recompute the derived display state, and tell connected browsers only when it actually changed.
OpMode.prototype.refresh = function () {
    var next = schedule.nextRunAfter(this.config, new Date());
    var missing = this.isOpServerMissing();
    var changed = String(next) !== String(this.nextRun) || missing !== this.opServerMissing;

    this.nextRun = next;
    this.opServerMissing = missing;

    if (changed) {
        this.emit('op-mode');
    }
};

OpMode.prototype.isOpServerMissing = function () {
    if (this.config.opServerId === null || this.config.opServerId === undefined) {
        return false;
    }

    return !this.manager.getServer(this.config.opServerId);
};

OpMode.prototype.getState = function () {
    return {
        enabled: this.config.enabled,
        days: this.config.days,
        time: this.config.time,
        opServerId: this.config.opServerId,
        opServerTitle: this.config.opServerTitle,
        opServerMissing: this.isOpServerMissing(),
        running: this.running,
        loadFailed: this.loadFailed,
        lastError: this.lastError,
        lastSkipped: this.lastSkipped ? this.lastSkipped.toISOString() : null,
        lastSkippedFormatted: schedule.formatRun(this.lastSkipped),
        nextRun: this.nextRun ? this.nextRun.toISOString() : null,
        nextRunFormatted: schedule.formatRun(this.nextRun),
        // Reported rather than assumed. The UI used to assert "Europe/Amsterdam", which would have
        // been a confident lie if the host were ever moved or reconfigured.
        timezone: schedule.hostTimezone()
    };
};

OpMode.prototype.setConfig = function (raw, cb) {
    cb = cb || function () {};

    var self = this;
    var result = schedule.normalizeConfig(raw);

    if (result.error) {
        return cb(new Error(result.error));
    }

    // An enabled schedule that cannot name a day or a server would save happily, show "Enabled"
    // ticked, and then silently never run. Refuse it instead of letting someone believe op night
    // is armed when it is not.
    if (result.config.enabled && !result.config.days.length) {
        return cb(new Error('Select at least one day, or untick Enabled'));
    }

    if (result.config.enabled && result.config.opServerId === null) {
        return cb(new Error('Select an op server, or untick Enabled'));
    }

    // Store the title purely so the "op server no longer exists" warning can name a human. It is
    // never used to resolve the server: matching on title would let a rename arm op night against
    // the wrong one.
    var opServer = result.config.opServerId ? this.manager.getServer(result.config.opServerId) : null;
    result.config.opServerTitle = opServer ? opServer.title : result.config.opServerTitle;

    this.config = result.config;
    this.loadFailed = null;
    // The operator has just reconfigured the schedule, so stale complaints about the old one are
    // no longer useful. Without this the skipped-run banner would never go away.
    this.lastSkipped = null;
    this.lastError = null;

    // Treat the window we are currently inside as already consumed, so saving the page at 19:30:30
    // on an op night does not immediately shut the fleet down. Only ever advance lastWindow, the
    // same fail-closed guarantee tick() makes: a backward clock step (NTP, VM time sync) followed
    // by a save would otherwise pull it back a week and let tick() re-fire a window that already
    // ran, the double fire rule 3 exists to prevent. A future window we schedule always sorts
    // after any past lastWindow, so keeping the later value never suppresses a real run.
    var previous = schedule.previousRunAtOrBefore(this.config, new Date());
    var candidate = previous ? previous.toISOString() : null;

    if (candidate && (!this.lastWindow || candidate > this.lastWindow)) {
        this.lastWindow = candidate;
    }

    this.refresh();
    this.startTicker();

    this.save(function (err) {
        self.emit('op-mode');
        cb(err);
    });
};

// Writes are serialised. tick() and setConfig() can both save, and two overlapping writes would
// race on the shared temp path: the first rename consumes the file, the second fails ENOENT, and
// the operator sees their successful save reported as an error. Worse, the older payload can win
// the rename and silently lose the newer lastWindow, re-arming a window that already ran.
OpMode.prototype.save = function (cb) {
    cb = cb || function () {};

    var self = this;

    if (this.saving) {
        // Whatever is in flight is already stale. Park this caller and re-run once when it lands,
        // rebuilding the payload from current state. Every waiter is kept, because a dropped one
        // means an HTTP request that never gets answered.
        this.savePending = this.savePending || [];
        this.savePending.push(cb);
        return;
    }

    this.saving = true;

    this.writeNow(function (err) {
        self.saving = false;

        var waiting = self.savePending;
        self.savePending = null;

        cb(err);

        if (waiting) {
            self.save(function (secondErr) {
                waiting.forEach(function (pending) {
                    pending(secondErr);
                });
            });
        }
    });
};

OpMode.prototype.writeNow = function (cb) {
    var self = this;
    var data = {
        enabled: this.config.enabled,
        days: this.config.days,
        time: this.config.time,
        opServerId: this.config.opServerId,
        opServerTitle: this.config.opServerTitle,
        lastWindow: this.lastWindow
    };

    // Write and rename, so a crash partway through cannot leave a truncated schedule behind.
    var tempPath = this.filePath + '.tmp';

    fs.writeFile(tempPath, JSON.stringify(data, null, 2), function (err) {
        if (err) {
            console.error('op-mode: could not write ' + tempPath + ': ' + err.message);
            return cb(err);
        }

        fs.rename(tempPath, self.filePath, function (err) {
            if (err) {
                console.error('op-mode: could not replace ' + self.filePath + ': ' + err.message);

                // Best effort: do not leave a stale temp file behind for the next write to trip on.
                return fs.unlink(tempPath, function () {
                    cb(err);
                });
            }

            cb();
        });
    });
};

OpMode.prototype.run = function (cb) {
    // Callers include the tick and the HTTP layer. Neither may be able to crash the process by
    // forgetting a callback.
    cb = cb || function () {};

    var self = this;

    if (this.running) {
        return cb(new Error('An op mode run is already in progress'));
    }

    if (this.config.opServerId === null || this.config.opServerId === undefined) {
        return cb(new Error('No op server is configured'));
    }

    var opServer = this.manager.getServer(this.config.opServerId);

    if (!opServer) {
        return cb(new Error('Op server "' + this.config.opServerId + '" no longer exists'));
    }

    // Every abort above happens before anything is stopped. Never shut the fleet down and then
    // discover there is nothing to bring back up.

    this.running = true;
    this.lastError = null;
    this.emit('op-mode');

    var finished = false;
    var done = function (err) {
        if (finished) {
            return;
        }

        finished = true;
        self.running = false;

        if (err) {
            self.emit('run-failed', opServer, err);
        }

        self.emit('op-mode');

        cb(err);
    };

    // Compare by object identity, not by id: ids are derived from the title, so two servers can
    // briefly share one.
    var others = this.manager.getServers().filter(function (server) {
        return server !== opServer && server.instance;
    });

    console.log('op-mode: stopping ' + others.length + ' server(s), then restarting ' + opServer.id);

    // Announce before stopping anything, so a Discord notification lands while the fleet is still
    // up. Carries the op server object itself: a consumer that follows the object is immune to the
    // title-derived-id changing under a rename mid-run.
    this.emit('run-started', opServer);

    async.each(others, function (server, next) {
        server.stop(function () {
            next();     // swallow any argument: async treats one as an error
        });
    }, function () {
        try {
            opServer.restart(done);
        } catch (err) {
            done(err);
        }
    });
};

module.exports = OpMode;
