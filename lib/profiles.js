// Pure helpers for the Arma `-profiles` parameter. No I/O, no state.
//
// Arma names its .rpt log `<exe>_<date>_<time to the second>.rpt` inside the -profiles folder. A
// server and its headless clients start in the same second, so when they share a folder they write
// the same file name and the server log is lost. Giving each headless client its own subfolder
// avoids that. Everything here works on strings only (no `path` module), so the result does not
// depend on the OS the panel runs on: a Windows profiles path stays a Windows path on Linux.

var PROFILES_PATTERN = /^-profiles=(.*)$/i;

var stripQuotes = function (text) {
    if (text.charAt(0) === '"') {
        text = text.slice(1);
    }

    if (text.charAt(text.length - 1) === '"') {
        text = text.slice(0, -1);
    }

    return text;
};

// Returns the (unquoted, trimmed) value of a profiles parameter, or null when the element is not
// one. An empty value such as `-profiles=` still counts as a profiles parameter, with value ''.
var parseProfiles = function (parameter) {
    if (typeof parameter !== 'string') {
        return null;
    }

    var trimmed = parameter.trim();

    // The whole element may be quoted, e.g. "-profiles=C:\My Dir\P".
    if (trimmed.length >= 2 && trimmed.charAt(0) === '"' && trimmed.charAt(trimmed.length - 1) === '"') {
        trimmed = trimmed.slice(1, -1);
    }

    var match = PROFILES_PATTERN.exec(trimmed);

    if (!match) {
        return null;
    }

    return stripQuotes(match[1].trim());
};

// The last profiles parameter wins, as it does for Arma itself. Null when there is none or the
// last one is empty.
var profilesPath = function (parameters) {
    var result = null;

    (Array.isArray(parameters) ? parameters : []).forEach(function (parameter) {
        var value = parseProfiles(parameter);

        if (value !== null) {
            result = value || null;
        }
    });

    return result;
};

// A new array without any profiles parameter; the input is not mutated.
var withoutProfiles = function (parameters) {
    return (Array.isArray(parameters) ? parameters : []).filter(function (parameter) {
        return parseProfiles(parameter) === null;
    });
};

// Join a folder name onto a profiles path, keeping the separator style the path already uses.
// A path with no separator at all (e.g. `profiles`) falls back to the platform's style.
var childPath = function (base, child, platform) {
    var separator;

    if (base.indexOf('\\') !== -1) {
        separator = '\\';
    } else if (base.indexOf('/') !== -1) {
        separator = '/';
    } else {
        separator = platform === 'linux' ? '/' : '\\';
    }

    return base.replace(/[\\/]+$/, '') + separator + child;
};

module.exports = {
    childPath: childPath,
    profilesPath: profilesPath,
    withoutProfiles: withoutProfiles
};
