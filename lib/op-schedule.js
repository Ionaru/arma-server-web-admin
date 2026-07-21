var _ = require('lodash');

// Pure date helpers for op mode. No I/O, no state, no `new Date()` without an explicit argument,
// so every rule in here is directly unit testable.
//
// IMPORTANT: all arithmetic goes through occurrenceOn(), which builds a Date from local wall-clock
// fields. Never advance a day or a week by adding 24 * 60 * 60 * 1000 milliseconds. Across the
// Europe/Amsterdam DST transitions that is off by exactly one hour, so a 19:30 op would fire at
// 18:30 or 20:30 twice a year. See the DST cases in test/lib/op-schedule.js.

var TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

var DAY_NAMES = [
    'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'
];

var MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];

var occurrenceOn = function (base, offsetDays, hours, minutes) {
    // Date normalises an out of range day-of-month, so this rolls over months and years for free.
    return new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetDays, hours, minutes, 0, 0);
};

var parseTime = function (time) {
    var match = TIME_PATTERN.exec(time);

    if (!match) {
        return null;
    }

    return {
        hours: parseInt(match[1], 10),
        minutes: parseInt(match[2], 10)
    };
};

// A schedule that cannot name a day, a time, and a server to restart has nothing to fire.
var isSchedulable = function (config) {
    return !!(config &&
        config.enabled &&
        config.days &&
        config.days.length &&
        config.opServerId !== null &&
        config.opServerId !== undefined);
};

// Lenient normaliser, used both by the HTTP layer and when reading op-mode.json off disk, since
// that file is hand editable. Returns the coerced config plus the first problem found, if any.
// On error the config comes back disabled: a schedule we could not understand must not fire.
var normalizeConfig = function (raw) {
    raw = raw || {};

    var error = null;

    var days = _.uniq((Array.isArray(raw.days) ? raw.days : [])
        .map(function (day) {
            return parseInt(day, 10);
        })
        .filter(function (day) {
            return day >= 0 && day <= 6;
        }))
        .sort();

    var time = typeof raw.time === 'string' ? raw.time : '';
    if (!parseTime(time)) {
        error = 'Invalid time "' + time + '", expected HH:MM between 00:00 and 23:59';
    }

    var opServerId = (typeof raw.opServerId === 'string' && raw.opServerId) ? raw.opServerId : null;
    var opServerTitle = (typeof raw.opServerTitle === 'string' && raw.opServerTitle) ? raw.opServerTitle : null;

    return {
        error: error,
        config: {
            enabled: error ? false : raw.enabled === true,
            days: days,
            time: time,
            opServerId: opServerId,
            opServerTitle: opServerTitle
        }
    };
};

// The first scheduled occurrence strictly after `now`, or null. Used for display and nothing else:
// firing is decided by previousRunAtOrBefore, so a stale nextRun can never trigger a run.
var nextRunAfter = function (config, now) {
    var time = isSchedulable(config) ? parseTime(config.time) : null;

    if (!time) {
        return null;
    }

    for (var offset = 0; offset <= 7; offset++) {
        var candidate = occurrenceOn(now, offset, time.hours, time.minutes);

        if (candidate > now && config.days.indexOf(candidate.getDay()) !== -1) {
            return candidate;
        }
    }

    return null;
};

// The most recent scheduled occurrence at or before `now`, or null. This is what the tick actually
// fires on: recomputing it every tick is what makes restarts, clock steps and missed windows all
// behave without needing a separate catch-up path.
var previousRunAtOrBefore = function (config, now) {
    var time = isSchedulable(config) ? parseTime(config.time) : null;

    if (!time) {
        return null;
    }

    for (var offset = 0; offset >= -7; offset--) {
        var candidate = occurrenceOn(now, offset, time.hours, time.minutes);

        if (candidate <= now && config.days.indexOf(candidate.getDay()) !== -1) {
            return candidate;
        }
    }

    return null;
};

// Formatted on the server, from host local fields, because members open the panel from their own
// machines. Formatting in the browser would show the viewer's timezone while the scheduler fires
// on the host clock.
var formatRun = function (date) {
    if (!date) {
        return null;
    }

    var minutes = date.getMinutes();
    var hours = date.getHours();

    return DAY_NAMES[date.getDay()] + ' ' +
        date.getDate() + ' ' +
        MONTH_NAMES[date.getMonth()] + ', ' +
        (hours < 10 ? '0' : '') + hours + ':' +
        (minutes < 10 ? '0' : '') + minutes;
};

// The zone the scheduler actually fires in, for display. Everything here uses local wall-clock
// fields, so this is whatever the panel host is configured for.
var hostTimezone = function () {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch (e) {
        return null;
    }
};

module.exports = {
    formatRun: formatRun,
    hostTimezone: hostTimezone,
    isSchedulable: isSchedulable,
    nextRunAfter: nextRunAfter,
    normalizeConfig: normalizeConfig,
    previousRunAtOrBefore: previousRunAtOrBefore
};
