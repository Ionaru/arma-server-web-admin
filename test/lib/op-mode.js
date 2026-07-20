process.env.TZ = 'Europe/Amsterdam';

require('should');
var events = require('events');
var fs = require('fs');
var os = require('os');
var path = require('path');
var tk = require('timekeeper');
var util = require('util');

var OpMode = require('../../lib/op-mode.js');

// Sunday 19 July 2026. Verified by the day-of-week assertions in test/lib/op-schedule.js.
var SUNDAY = 0;
var OP_NIGHT = function (hours, minutes, seconds) {
    return new Date(2026, 6, 19, hours, minutes, seconds || 0);
};

var fakeServer = function (id, running) {
    var server = {
        id: id,
        instance: running ? {pid: 1234} : null,
        stops: 0,
        restarts: 0
    };

    server.stop = function (cb) {
        server.stops++;
        server.instance = null;

        if (cb) {
            cb();
        }
    };

    server.restart = function (cb) {
        server.restarts++;
        server.instance = {pid: 5678};

        if (cb) {
            cb();
        }
    };

    return server;
};

var FakeManager = function (servers) {
    events.EventEmitter.call(this);
    this.servers = servers || [];
};
util.inherits(FakeManager, events.EventEmitter);

FakeManager.prototype.getServers = function () {
    return this.servers;
};

FakeManager.prototype.getServer = function (id) {
    return this.servers.filter(function (server) {
        return server.id === id;
    })[0];
};

var created = [];

var tmpPath = function () {
    var file = path.join(os.tmpdir(),
        'op-mode-test-' + process.pid + '-' + (tmpPath.counter = (tmpPath.counter || 0) + 1) + '.json');

    created.push(file);

    return file;
};

// Every OpMode instance may write its config and a sibling .tmp. Clean up unconditionally rather
// than per test, so a failing assertion cannot leave litter behind.
var cleanUp = function () {
    created.forEach(function (file) {
        [file, file + '.tmp'].forEach(function (target) {
            try {
                fs.unlinkSync(target);
            } catch (e) {
                // never existed, or already gone
            }
        });
    });

    created = [];
};

var instances = [];

var opModeWith = function (servers, overrides) {
    var opMode = new OpMode(new FakeManager(servers), tmpPath());
    instances.push(opMode);

    opMode.config = {
        enabled: true,
        days: [SUNDAY],
        time: '19:30',
        opServerId: 'op',
        opServerTitle: 'Op Server'
    };

    Object.keys(overrides || {}).forEach(function (key) {
        opMode[key] = overrides[key];
    });

    return opMode;
};

describe('OpMode', function () {

    afterEach(function () {
        tk.reset();

        // setConfig arms a real interval. Left running, a leaked ticker could fire against a stale
        // fake manager once the clock is unfrozen.
        instances.forEach(function (opMode) {
            opMode.stopTicker();
        });
        instances = [];
    });

    after(function () {
        cleanUp();
    });

    describe('run()', function () {
        it('should stop other running servers and restart the op server', function (done) {
            var op = fakeServer('op', true);
            var other = fakeServer('other', true);
            var opMode = opModeWith([op, other]);

            opMode.run(function (err) {
                (err === undefined || err === null).should.be.true();
                other.stops.should.eql(1);
                op.restarts.should.eql(1);
                op.stops.should.eql(0);
                done();
            });
        });

        it('should not stop servers that are already stopped', function (done) {
            var op = fakeServer('op', true);
            var idle = fakeServer('idle', false);
            var opMode = opModeWith([op, idle]);

            opMode.run(function () {
                idle.stops.should.eql(0);
                done();
            });
        });

        it('should start the op server when it is not running', function (done) {
            var op = fakeServer('op', false);
            var other = fakeServer('other', true);
            var opMode = opModeWith([op, other]);

            opMode.run(function (err) {
                (err === undefined || err === null).should.be.true();
                op.restarts.should.eql(1);
                other.stops.should.eql(1);
                done();
            });
        });

        // The single most important safety property: never shut the fleet down and then discover
        // there is nothing to bring back up.
        it('should abort without stopping anything when the op server is missing', function (done) {
            var other = fakeServer('other', true);
            var opMode = opModeWith([other]);

            opMode.run(function (err) {
                err.should.be.an.Error();
                err.message.should.match(/no longer exists/i);
                other.stops.should.eql(0);
                other.instance.should.be.ok();
                done();
            });
        });

        it('should abort without stopping anything when no op server is configured', function (done) {
            var other = fakeServer('other', true);
            var opMode = opModeWith([other]);
            opMode.config.opServerId = null;

            opMode.run(function (err) {
                err.should.be.an.Error();
                err.message.should.match(/no op server/i);
                other.stops.should.eql(0);
                done();
            });
        });

        it('should reject a second run while one is in flight, without stopping anything', function (done) {
            var op = fakeServer('op', true);
            var other = fakeServer('other', true);
            var opMode = opModeWith([op, other]);

            // Hold the first run open by never calling back from stop().
            other.stop = function () {
                other.stops++;
            };

            opMode.run(function () {});

            opMode.run(function (err) {
                err.should.be.an.Error();
                err.message.should.match(/already in progress/i);
                other.stops.should.eql(1);
                op.restarts.should.eql(0);
                done();
            });
        });

        it('should clear the in flight flag after a successful run', function (done) {
            var opMode = opModeWith([fakeServer('op', true)]);

            opMode.run(function () {
                opMode.running.should.be.false();
                done();
            });
        });

        // A missing op server must not wedge op mode until the process restarts. Asserting the
        // flag alone would be tautological, since the abort path never sets it: assert instead
        // that a later run is actually able to proceed.
        it('should not wedge op mode after an aborted run', function (done) {
            var op = fakeServer('op', true);
            var manager = new FakeManager([]);
            var opMode = opModeWith([]);
            opMode.manager = manager;

            opMode.run(function (err) {
                err.should.be.an.Error();
                opMode.running.should.be.false();

                // The op server reappears, e.g. the operator re-picked it after a rename.
                manager.servers.push(op);

                opMode.run(function (secondErr) {
                    (secondErr === undefined || secondErr === null).should.be.true();
                    op.restarts.should.eql(1);
                    done();
                });
            });
        });

        it('should not throw when called without a callback on the happy path', function () {
            var opMode = opModeWith([fakeServer('op', true), fakeServer('other', true)]);
            opMode.run.bind(opMode).should.not.throw();
        });

        // The tick calls run() with a callback, but a regression that drops it must not be able to
        // take the whole panel down, since nothing catches throws from a setInterval callback.
        it('should not throw when called without a callback on the abort path', function () {
            var opMode = opModeWith([]);
            opMode.run.bind(opMode).should.not.throw();
        });

        it('should report an error when the op server fails to restart', function (done) {
            var op = fakeServer('op', true);
            var opMode = opModeWith([op]);

            op.restart = function (cb) {
                cb(new Error('did not stop in time'));
            };

            opMode.run(function (err) {
                err.should.be.an.Error();
                opMode.running.should.be.false();
                done();
            });
        });
    });

    describe('tick()', function () {
        it('should fire when the scheduled instant has just passed', function () {
            var op = fakeServer('op', true);
            var opMode = opModeWith([op]);

            tk.freeze(OP_NIGHT(19, 30, 1));
            opMode.tick();

            op.restarts.should.eql(1);
        });

        it('should not fire before the scheduled instant', function () {
            var op = fakeServer('op', true);
            var opMode = opModeWith([op]);

            tk.freeze(OP_NIGHT(19, 29, 59));
            opMode.tick();

            op.restarts.should.eql(0);
        });

        // Guards against a panel restart inside the window re-killing a server people have joined.
        it('should fire exactly once across repeated ticks at the same instant', function () {
            var op = fakeServer('op', true);
            var opMode = opModeWith([op]);

            tk.freeze(OP_NIGHT(19, 30, 1));
            opMode.tick();
            opMode.tick();
            opMode.tick();

            op.restarts.should.eql(1);
        });

        it('should not fire a window already recorded as consumed', function () {
            var op = fakeServer('op', true);
            var opMode = opModeWith([op]);

            opMode.lastWindow = OP_NIGHT(19, 30).toISOString();

            tk.freeze(OP_NIGHT(19, 30, 5));
            opMode.tick();

            op.restarts.should.eql(0);
        });

        // Node timers do not fire while the machine is suspended. Without the grace bound a box
        // resuming at 03:00 would kill every server at 03:00.
        it('should skip a window missed by more than the grace period', function () {
            var op = fakeServer('op', true);
            var opMode = opModeWith([op]);

            tk.freeze(new Date(OP_NIGHT(19, 30).getTime() + OpMode.graceMs + 1000));
            opMode.tick();

            op.restarts.should.eql(0);
            opMode.getState().lastSkipped.should.eql(OP_NIGHT(19, 30).toISOString());
            opMode.getState().lastSkippedFormatted.should.eql('Sunday 19 July, 19:30');
        });

        it('should still fire a window missed by less than the grace period', function () {
            var op = fakeServer('op', true);
            var opMode = opModeWith([op]);

            tk.freeze(new Date(OP_NIGHT(19, 30).getTime() + OpMode.graceMs - 1000));
            opMode.tick();

            op.restarts.should.eql(1);
        });

        it('should record a skipped window so it is not fired later', function () {
            var op = fakeServer('op', true);
            var opMode = opModeWith([op]);

            tk.freeze(new Date(OP_NIGHT(19, 30).getTime() + OpMode.graceMs + 1000));
            opMode.tick();

            tk.freeze(OP_NIGHT(19, 30, 1));
            opMode.tick();

            op.restarts.should.eql(0);
        });

        it('should not fire when the schedule is disabled', function () {
            var op = fakeServer('op', true);
            var opMode = opModeWith([op]);
            opMode.config.enabled = false;

            tk.freeze(OP_NIGHT(19, 30, 1));
            opMode.tick();

            op.restarts.should.eql(0);
        });

        // A config we could not read is not a config that says "nothing scheduled".
        it('should not fire when the config failed to load', function () {
            var op = fakeServer('op', true);
            var opMode = opModeWith([op]);
            opMode.loadFailed = 'op-mode.json is not valid JSON';

            tk.freeze(OP_NIGHT(19, 30, 1));
            opMode.tick();

            op.restarts.should.eql(0);
        });

        // Design rule 3, in two halves.
        //
        // The half that guards against a double fire is the in-memory one: lastWindow must already
        // be set by the time the run touches any server, so a tick landing during the run cannot
        // consume the same window again. The disk write is initiated at the same moment but
        // completes asynchronously; since a real run spends seconds stopping servers and the write
        // takes about a millisecond, it lands long before the run finishes.
        it('should mark the window consumed before the run touches any server', function (done) {
            var op = fakeServer('op', true);
            var other = fakeServer('other', true);
            var opMode = opModeWith([op, other]);
            var windowAtStopTime = 'never stopped';
            var windowAtRestartTime = 'never restarted';

            other.stop = function (cb) {
                other.stops++;
                windowAtStopTime = opMode.lastWindow;
                cb();
            };

            op.restart = function (cb) {
                op.restarts++;
                windowAtRestartTime = opMode.lastWindow;
                cb();
            };

            tk.freeze(OP_NIGHT(19, 30, 1));
            opMode.tick();

            windowAtStopTime.should.eql(OP_NIGHT(19, 30).toISOString());
            windowAtRestartTime.should.eql(OP_NIGHT(19, 30).toISOString());

            // And it does reach disk.
            setTimeout(function () {
                JSON.parse(fs.readFileSync(opMode.filePath)).lastWindow
                    .should.eql(OP_NIGHT(19, 30).toISOString());
                done();
            }, 50);
        });

        // Design rule 1: firing is driven by previousRunAtOrBefore, so a window is still fired
        // when lastWindow already holds an OLDER window. Every other firing test starts from null.
        it('should fire a new window when an older one was already consumed', function () {
            var op = fakeServer('op', true);
            var opMode = opModeWith([op]);

            opMode.lastWindow = new Date(2026, 6, 12, 19, 30).toISOString();   // the previous Sunday

            tk.freeze(OP_NIGHT(19, 30, 1));
            opMode.tick();

            op.restarts.should.eql(1);
        });

        // A backward clock step must not let an already consumed window fire a second time.
        it('should not re-fire a consumed window after the clock steps backwards', function () {
            var op = fakeServer('op', true);
            var opMode = opModeWith([op]);

            tk.freeze(OP_NIGHT(19, 30, 2));
            opMode.tick();
            op.restarts.should.eql(1);

            var consumed = opMode.lastWindow;

            tk.freeze(OP_NIGHT(19, 29, 20));    // NTP pulls the clock back across the window
            opMode.tick();

            tk.freeze(OP_NIGHT(19, 30, 5));     // and it crosses the window again
            opMode.tick();

            op.restarts.should.eql(1);
            opMode.lastWindow.should.eql(consumed);
            (opMode.lastSkipped === null).should.be.true();
        });

        it('should keep nextRun up to date', function () {
            var opMode = opModeWith([fakeServer('op', true)]);

            tk.freeze(OP_NIGHT(12, 0));
            opMode.tick();

            opMode.nextRun.getDate().should.eql(19);
            opMode.nextRun.getHours().should.eql(19);
        });

        it('should not throw when the run fails', function () {
            var op = fakeServer('op', true);
            var opMode = opModeWith([op]);

            op.restart = function () {
                throw new Error('boom');
            };

            tk.freeze(OP_NIGHT(19, 30, 1));
            opMode.tick.bind(opMode).should.not.throw();
        });
    });

    describe('setConfig()', function () {
        it('should reject an invalid time without persisting', function (done) {
            var opMode = opModeWith([fakeServer('op', true)]);

            opMode.setConfig({enabled: true, days: [SUNDAY], time: 'half seven', opServerId: 'op'}, function (err) {
                err.should.be.an.Error();
                opMode.config.time.should.eql('19:30');
                fs.existsSync(opMode.filePath).should.be.false();
                done();
            });
        });

        // Saving these would show "Enabled" ticked while nextRunAfter returns null forever, so the
        // operator would believe op night is armed when nothing will ever happen.
        it('should reject an enabled schedule with no days', function (done) {
            var opMode = opModeWith([fakeServer('op', true)]);

            opMode.setConfig({enabled: true, days: [], time: '19:30', opServerId: 'op'}, function (err) {
                err.should.be.an.Error();
                err.message.should.match(/at least one day/i);
                done();
            });
        });

        it('should reject an enabled schedule with no op server', function (done) {
            var opMode = opModeWith([fakeServer('op', true)]);

            opMode.setConfig({enabled: true, days: [SUNDAY], time: '19:30', opServerId: null}, function (err) {
                err.should.be.an.Error();
                err.message.should.match(/op server/i);
                done();
            });
        });

        it('should allow a disabled schedule to be incomplete', function (done) {
            var opMode = opModeWith([fakeServer('op', true)]);

            opMode.setConfig({enabled: false, days: [], time: '19:30', opServerId: null}, function (err) {
                (err === undefined || err === null).should.be.true();
                done();
            });
        });

        it('should clear a stale skipped run warning', function (done) {
            var opMode = opModeWith([fakeServer('op', true)]);
            opMode.lastSkipped = OP_NIGHT(19, 30);

            opMode.setConfig({enabled: true, days: [SUNDAY], time: '19:30', opServerId: 'op'}, function () {
                (opMode.lastSkipped === null).should.be.true();
                done();
            });
        });

        it('should normalize string days', function (done) {
            var opMode = opModeWith([fakeServer('op', true)]);

            opMode.setConfig({enabled: true, days: ['0', '3'], time: '19:30', opServerId: 'op'}, function (err) {
                (err === undefined || err === null).should.be.true();
                opMode.config.days.should.eql([0, 3]);
                done();
            });
        });

        // Saving the page during an op night must not itself trigger a shutdown.
        it('should not fire a run for the window it was saved in', function (done) {
            var op = fakeServer('op', true);
            var opMode = opModeWith([op]);

            tk.freeze(OP_NIGHT(19, 30, 30));

            opMode.setConfig({enabled: true, days: [SUNDAY], time: '19:30', opServerId: 'op'}, function () {
                opMode.tick();
                op.restarts.should.eql(0);
                done();
            });
        });

        it('should record the op server title for display', function (done) {
            var opMode = opModeWith([fakeServer('op', true)]);
            opMode.manager.servers[0].title = 'Op Server';

            opMode.setConfig({enabled: true, days: [SUNDAY], time: '19:30', opServerId: 'op'}, function () {
                opMode.config.opServerTitle.should.eql('Op Server');
                done();
            });
        });
    });

    describe('load()', function () {
        it('should start with defaults when the file does not exist', function (done) {
            var opMode = new OpMode(new FakeManager([]), tmpPath());

            opMode.load(function () {
                opMode.config.enabled.should.be.false();
                (opMode.loadFailed === null).should.be.true();
                opMode.stopTicker();
                done();
            });
        });

        it('should refuse to run when the file is corrupt', function (done) {
            var file = tmpPath();
            fs.writeFileSync(file, '{ this is not json');

            var opMode = new OpMode(new FakeManager([fakeServer('op', true)]), file);

            opMode.load(function () {
                opMode.loadFailed.should.be.a.String();
                (opMode.nextRun === null).should.be.true();
                opMode.stopTicker();
                fs.unlinkSync(file);
                done();
            });
        });

        it('should round trip a saved config', function (done) {
            var file = tmpPath();
            var first = new OpMode(new FakeManager([fakeServer('op', true)]), file);

            first.setConfig({enabled: true, days: [SUNDAY], time: '19:30', opServerId: 'op'}, function () {
                var second = new OpMode(new FakeManager([fakeServer('op', true)]), file);

                second.load(function () {
                    second.config.enabled.should.be.true();
                    second.config.days.should.eql([SUNDAY]);
                    second.config.time.should.eql('19:30');
                    second.config.opServerId.should.eql('op');
                    second.stopTicker();
                    fs.unlinkSync(file);
                    done();
                });
            });
        });

        it('should not re-fire a window already consumed before a restart', function (done) {
            var file = tmpPath();
            var op = fakeServer('op', true);
            var first = new OpMode(new FakeManager([op]), file);

            // Configured earlier in the day, as it would be in practice.
            tk.freeze(OP_NIGHT(12, 0));

            first.setConfig({enabled: true, days: [SUNDAY], time: '19:30', opServerId: 'op'}, function () {
                tk.freeze(OP_NIGHT(19, 30, 1));
                first.tick();
                op.restarts.should.eql(1);
                first.stopTicker();

                // tick() persists the consumed window without waiting for the write, so settle it
                // before reading the file back. save() is idempotent here.
                first.save(function () {
                    // Panel restarts twenty seconds later, still inside the grace window.
                    tk.freeze(OP_NIGHT(19, 30, 21));

                    var restarted = fakeServer('op', true);
                    var second = new OpMode(new FakeManager([restarted]), file);

                    second.load(function () {
                        second.tick();
                        restarted.restarts.should.eql(0);
                        second.stopTicker();
                        fs.unlinkSync(file);
                        done();
                    });
                });
            });
        });
    });

    // app.js calls refresh() on every manager 'servers' event, which fires on every server start
    // and stop. Emitting unconditionally would broadcast the whole state on each one.
    describe('refresh()', function () {
        it('should not emit when nothing changed', function () {
            var opMode = opModeWith([fakeServer('op', true)]);
            var emits = 0;

            tk.freeze(OP_NIGHT(12, 0));
            opMode.refresh();

            opMode.on('op-mode', function () {
                emits++;
            });

            opMode.refresh();
            opMode.refresh();

            emits.should.eql(0);
        });

        it('should emit when the op server goes missing', function () {
            var manager = new FakeManager([fakeServer('op', true)]);
            var opMode = opModeWith([]);
            opMode.manager = manager;

            var emits = 0;

            tk.freeze(OP_NIGHT(12, 0));
            opMode.refresh();
            opMode.opServerMissing.should.be.false();

            opMode.on('op-mode', function () {
                emits++;
            });

            manager.servers = [];       // the op server is renamed or deleted
            opMode.refresh();

            opMode.opServerMissing.should.be.true();
            emits.should.eql(1);
        });
    });

    describe('getState()', function () {
        it('should distinguish "none selected" from "no longer exists"', function () {
            var opMode = opModeWith([]);

            opMode.config.opServerId = null;
            opMode.getState().opServerMissing.should.be.false();

            opMode.config.opServerId = 'gone';
            opMode.getState().opServerMissing.should.be.true();
        });

        it('should format the next run in host local time', function () {
            var opMode = opModeWith([fakeServer('op', true)]);

            tk.freeze(OP_NIGHT(12, 0));
            opMode.tick();

            opMode.getState().nextRunFormatted.should.eql('Sunday 19 July, 19:30');
        });

        it('should report no next run when nothing is scheduled', function () {
            var opMode = opModeWith([fakeServer('op', true)]);
            opMode.config.enabled = false;

            tk.freeze(OP_NIGHT(12, 0));
            opMode.tick();

            (opMode.getState().nextRunFormatted === null).should.be.true();
        });
    });
});
