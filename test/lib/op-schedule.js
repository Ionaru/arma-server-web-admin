// The scheduler does local wall-clock arithmetic, so these tests are only meaningful in the
// timezone the panel host runs in. Pin it rather than depending on the developer's machine.
process.env.TZ = 'Europe/Amsterdam';

require('should');

var schedule = require('../../lib/op-schedule.js');

var SUNDAY = 0;
var WEDNESDAY = 3;

var config = function (overrides) {
    var base = {
        enabled: true,
        days: [SUNDAY],
        time: '19:30',
        opServerId: 'op-server'
    };

    Object.keys(overrides || {}).forEach(function (key) {
        base[key] = overrides[key];
    });

    return base;
};

describe('OpSchedule', function () {

    describe('normalizeConfig()', function () {
        it('should coerce string days to numbers', function () {
            schedule.normalizeConfig(config({days: ['0', '3']})).config.days.should.eql([0, 3]);
        });

        it('should drop out of range days, dedupe and sort', function () {
            schedule.normalizeConfig(config({days: [7, 3, 3, -1, 0]})).config.days.should.eql([0, 3]);
        });

        it('should treat an empty opServerId as not selected', function () {
            (schedule.normalizeConfig(config({opServerId: ''})).config.opServerId === null).should.be.true();
        });

        it('should reject a malformed time and disable the schedule', function () {
            var result = schedule.normalizeConfig(config({time: '9:5'}));
            result.error.should.match(/time/i);
            result.config.enabled.should.be.false();
        });

        it('should reject an out of range time', function () {
            schedule.normalizeConfig(config({time: '24:00'})).error.should.match(/time/i);
            schedule.normalizeConfig(config({time: '19:60'})).error.should.match(/time/i);
        });

        it('should accept valid times', function () {
            ['19:30', '08:05', '00:00', '23:59'].forEach(function (time) {
                (schedule.normalizeConfig(config({time: time})).error === null).should.be.true();
            });
        });

        it('should only treat enabled === true as enabled', function () {
            schedule.normalizeConfig(config({enabled: 'yes'})).config.enabled.should.be.false();
            schedule.normalizeConfig(config({enabled: true})).config.enabled.should.be.true();
        });
    });

    describe('nextRunAfter()', function () {
        it('should return today when the time has not passed yet', function () {
            // Sunday 19 July 2026, 12:00
            var next = schedule.nextRunAfter(config(), new Date(2026, 6, 19, 12, 0));
            next.getDate().should.eql(19);
            next.getHours().should.eql(19);
            next.getMinutes().should.eql(30);
        });

        it('should skip to next week when the time has already passed today', function () {
            var next = schedule.nextRunAfter(config(), new Date(2026, 6, 19, 19, 31));
            next.getDate().should.eql(26);
            next.getHours().should.eql(19);
        });

        it('should treat the exact scheduled instant as already passed', function () {
            var next = schedule.nextRunAfter(config(), new Date(2026, 6, 19, 19, 30, 0, 0));
            next.getDate().should.eql(26);
        });

        it('should pick the nearest of several selected days', function () {
            // Monday 20 July 2026; Wednesday is nearer than the following Sunday
            var next = schedule.nextRunAfter(config({days: [SUNDAY, WEDNESDAY]}), new Date(2026, 6, 20, 9, 0));
            next.getDay().should.eql(WEDNESDAY);
            next.getDate().should.eql(22);
        });

        it('should roll over a month boundary', function () {
            // Wednesday 29 July 2026 -> Sunday 2 August 2026
            var next = schedule.nextRunAfter(config(), new Date(2026, 6, 29, 9, 0));
            next.getMonth().should.eql(7);
            next.getDate().should.eql(2);
        });

        it('should return null when not schedulable', function () {
            var now = new Date(2026, 6, 20, 9, 0);
            (schedule.nextRunAfter(config({enabled: false}), now) === null).should.be.true();
            (schedule.nextRunAfter(config({days: []}), now) === null).should.be.true();
            (schedule.nextRunAfter(config({opServerId: null}), now) === null).should.be.true();
            (schedule.nextRunAfter(config({time: 'nonsense'}), now) === null).should.be.true();
        });

        // These are the regression tests for millisecond arithmetic. Adding 7 * 24 * 60 * 60 * 1000
        // to a Date lands an hour off across both Europe/Amsterdam transitions. Assert on the
        // wall-clock fields, never on the epoch, or the assertion proves nothing.
        describe('across DST transitions', function () {
            it('should keep 19:30 wall-clock when springing forward', function () {
                // CET -> CEST happens Sunday 29 March 2026 at 02:00
                [new Date(2026, 2, 28, 12, 0), new Date(2026, 2, 22, 19, 31)].forEach(function (now) {
                    var next = schedule.nextRunAfter(config(), now);
                    next.getDate().should.eql(29);
                    next.getMonth().should.eql(2);
                    next.getHours().should.eql(19);
                    next.getMinutes().should.eql(30);
                });
            });

            it('should keep 19:30 wall-clock when falling back', function () {
                // CEST -> CET happens Sunday 25 October 2026 at 03:00
                [new Date(2026, 9, 24, 23, 0), new Date(2026, 9, 18, 19, 31)].forEach(function (now) {
                    var next = schedule.nextRunAfter(config(), now);
                    next.getDate().should.eql(25);
                    next.getMonth().should.eql(9);
                    next.getHours().should.eql(19);
                    next.getMinutes().should.eql(30);
                });
            });
        });
    });

    describe('previousRunAtOrBefore()', function () {
        it('should return today when the time has already passed', function () {
            var prev = schedule.previousRunAtOrBefore(config(), new Date(2026, 6, 19, 19, 31));
            prev.getDate().should.eql(19);
            prev.getHours().should.eql(19);
            prev.getMinutes().should.eql(30);
        });

        it('should include the exact scheduled instant', function () {
            var prev = schedule.previousRunAtOrBefore(config(), new Date(2026, 6, 19, 19, 30, 0, 0));
            prev.getDate().should.eql(19);
        });

        it('should go back to last week when the time has not passed yet today', function () {
            var prev = schedule.previousRunAtOrBefore(config(), new Date(2026, 6, 19, 12, 0));
            prev.getDate().should.eql(12);
        });

        it('should roll back over a month boundary', function () {
            // Wednesday 1 July 2026 -> Sunday 28 June 2026
            var prev = schedule.previousRunAtOrBefore(config(), new Date(2026, 6, 1, 9, 0));
            prev.getMonth().should.eql(5);
            prev.getDate().should.eql(28);
        });

        it('should return null when not schedulable', function () {
            var now = new Date(2026, 6, 20, 9, 0);
            (schedule.previousRunAtOrBefore(config({enabled: false}), now) === null).should.be.true();
            (schedule.previousRunAtOrBefore(config({days: []}), now) === null).should.be.true();
            (schedule.previousRunAtOrBefore(config({opServerId: null}), now) === null).should.be.true();
        });

        // Both cases deliberately look back from AFTER a transition to an occurrence BEFORE it, so
        // the search actually crosses the boundary. Looking back to a same-side occurrence would
        // pass with naive millisecond arithmetic and prove nothing.
        describe('across DST transitions', function () {
            var SATURDAY = 6;

            it('should keep 19:30 wall-clock looking back over the spring forward', function () {
                // Now is Sunday 29 March 2026 12:00 CEST; the transition was that morning at 02:00.
                // The Saturday occurrence it must find is still CET.
                var prev = schedule.previousRunAtOrBefore(
                    config({days: [SATURDAY]}), new Date(2026, 2, 29, 12, 0));
                prev.getDate().should.eql(28);
                prev.getMonth().should.eql(2);
                prev.getHours().should.eql(19);
                prev.getMinutes().should.eql(30);
            });

            it('should keep 19:30 wall-clock looking back over the fall back', function () {
                // Now is Sunday 25 October 2026 12:00 CET; the transition was that morning at 03:00.
                // The Saturday occurrence it must find is still CEST.
                var prev = schedule.previousRunAtOrBefore(
                    config({days: [SATURDAY]}), new Date(2026, 9, 25, 12, 0));
                prev.getDate().should.eql(24);
                prev.getMonth().should.eql(9);
                prev.getHours().should.eql(19);
                prev.getMinutes().should.eql(30);
            });
        });
    });

    describe('formatRun()', function () {
        it('should render host local wall-clock time', function () {
            schedule.formatRun(new Date(2026, 6, 26, 19, 30)).should.eql('Sunday 26 July, 19:30');
        });

        it('should zero pad minutes', function () {
            schedule.formatRun(new Date(2026, 6, 26, 9, 5)).should.eql('Sunday 26 July, 09:05');
        });

        it('should return null for no date', function () {
            (schedule.formatRun(null) === null).should.be.true();
        });
    });
});
