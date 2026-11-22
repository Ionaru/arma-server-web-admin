var _ = require('lodash');
var events = require('events');
var fs = require('fs');
var Gamedig = require('gamedig');
var slugify = require('slugify');
var util = require('util');

var ArmaServer = require('arma-server');

var profiles = require('./profiles.js');

var config = require('../config.js');

var queryInterval = 5000;
var queryTypes = {
    arma1: 'arma',
    arma2: 'arma2',
    arma2oa: 'arma2',
    arma3: 'arma3',
    arma3_x64: 'arma3',
    cwa: 'operationflashpoint',
    ofp: 'operationflashpoint',
    ofpresistance: 'operationflashpoint'
};

var createServerTitle = function (title) {
    if (config.prefix) {
        title = config.prefix + title;
    }

    if (config.suffix) {
        title = title + config.suffix;
    }

    return title;
};

var Server = function (config, logs, options) {
    events.EventEmitter.call(this);

    this.config = config;
    this.logs = logs;
    this.headlessClientInstances = [];
    this.headlessClientTimers = [];
    this.update(options);
};

// Must be util.inherits, not `Server.prototype = new events.EventEmitter()`. The latter gives every
// instance the *same* _events object, so one server's emit runs every other server's listeners.
util.inherits(Server, events.EventEmitter);

// How long to wait for a killed process to actually close before giving up. Named so tests can
// shorten it; matches the queryInterval cadence above.
Server.stopTimeout = 5000;

// Headless client start-up: the delay from start() to HC_0, then the gap between consecutive HCs.
// Arma names its log to the second, so starts must not share one. Named so tests can shorten them.
Server.headlessClientStartDelay = 5000;
Server.headlessClientStartInterval = 2000;

Server.prototype.generateId = function () {
    return slugify(this.title).replace(/\./g, '-');
};

Server.prototype.update = function (options) {
    this.additionalConfigurationOptions = options.additionalConfigurationOptions;
    this.admin_password = options.admin_password;
    this.allowed_file_patching = options.allowed_file_patching;
    this.auto_start = options.auto_start;
    this.battle_eye = options.battle_eye;
    this.file_patching = options.file_patching;
    this.forcedDifficulty = options.forcedDifficulty || null;
    this.max_players = options.max_players;
    this.missions = options.missions;
    this.mods = options.mods || [];
    this.motd = options.motd || null;
    this.number_of_headless_clients = options.number_of_headless_clients || 0;
    this.password = options.password;
    this.parameters = options.parameters;
    this.persistent = options.persistent;
    this.port = options.port || 2302;
    this.title = options.title;
    this.von = options.von;
    this.verify_signatures = options.verify_signatures;

    this.id = this.generateId();
    this.port = parseInt(this.port, 10); // If port is a string then gamedig fails
};

Server.prototype.queryStatus = function () {
    if (!this.instance) {
        return;
    }

    var self = this;
    Gamedig.query(
        {
            type: queryTypes[config.game],
            host: '127.0.0.1',
            port: self.port
        },
        function (state) {
            if (!self.instance) {
                return;
            }

            if (state.error) {
                self.state = null;
            } else {
                self.state = state;
            }

            self.emit('state');
        }
    );
};

Server.prototype.getParameters = function () {
    var parameters = [];

    if (config.parameters && Array.isArray(config.parameters)) {
        parameters = parameters.concat(config.parameters);
    }

    if (this.parameters && Array.isArray(this.parameters)) {
        parameters = parameters.concat(this.parameters);
    }

    return parameters;
};

Server.prototype.getAdditionalConfigurationOptions = function () {
    var additionalConfigurationOptions = '';

    if (config.additionalConfigurationOptions) {
        additionalConfigurationOptions += config.additionalConfigurationOptions;
    }

    if (this.additionalConfigurationOptions) {
        if (additionalConfigurationOptions) {
            additionalConfigurationOptions += '\n';
        }

        additionalConfigurationOptions += this.additionalConfigurationOptions;
    }

    return additionalConfigurationOptions;
};

Server.prototype.start = function () {
    if (this.instance) {
        return this;
    }

    var parameters = this.getParameters();
    var server = new ArmaServer.Server({
        additionalConfigurationOptions: this.getAdditionalConfigurationOptions(),
        admins: config.admins,
        allowedFilePatching: this.allowed_file_patching || 1,
        battleEye: this.battle_eye ? 1 : 0,
        config: this.id,
        disableVoN: this.von ? 0 : 1,
        game: config.game,
        filePatching: this.file_patching || false,
        forcedDifficulty: this.forcedDifficulty || null,
        headlessClients: this.number_of_headless_clients > 0 ? ['127.0.0.1'] : null,
        hostname: createServerTitle(this.title),
        localClient: this.number_of_headless_clients > 0 ? ['127.0.0.1'] : null,
        missions: this.missions,
        mods: this.mods,
        motd: (this.motd && this.motd.split('\n')) || null,
        parameters: parameters,
        password: this.password,
        passwordAdmin: this.admin_password,
        path: this.config.path,
        persistent: this.persistent ? 1 : 0,
        platform: this.config.type,
        players: this.max_players,
        port: this.port,
        serverMods: config.serverMods,
        verifySignatures: this.verify_signatures ? 2 : 0
    });
    server.writeServerConfig();
    var instance = server.start();
    var self = this;

    // The id keeps captures apart when several servers start in the same second (Manager.load()).
    this.captureOutput(instance, this.id);

    instance.on('close', function (code) {
        clearInterval(self.queryStatusInterval);
        self.state = null;
        self.pid = null;
        self.instance = null;

        self.stopHeadlessClients();

        self.emit('state');
    });

    instance.on('error', function (err) {
        console.log(err);
    });

    this.pid = instance.pid;
    this.instance = instance;
    this.queryStatusInterval = setInterval(function () {
        self.queryStatus();
    }, queryInterval);

    this.startHeadlessClients();

    this.emit('state');

    return this;
};

// On Linux the game writes no .rpt, so a process's stdout and stderr are its log. The listeners go
// on every platform so the pipes are always read.
Server.prototype.captureOutput = function (child, suffix) {
    var logStream = null;

    if (this.config.type === 'linux') {
        logStream = fs.createWriteStream(this.logs.generateLogFilePath(suffix), {
            flags: 'a'
        });
    }

    ['stdout', 'stderr'].forEach(function (name) {
        child[name].on('data', function (data) {
            if (logStream) {
                logStream.write(data);
            }
        });
    });

    child.on('close', function () {
        if (logStream) {
            logStream.end();
        }
    });
};

// Spawning every headless client in the start() loop made them share the server's start second and
// its -profiles folder, so they all wrote the same .rpt name. Starts are staggered instead.
Server.prototype.startHeadlessClients = function () {
    var self = this;
    var instance = this.instance;

    this.headlessClientInstances = [];
    this.clearHeadlessClientTimers();

    if (!instance) {
        return;
    }

    // The options are captured now: update() can change the running server's settings before the
    // timers fire, and a headless client has to join the server as it was started.
    _.times(this.number_of_headless_clients, function (i) {
        var options = self.headlessClientOptions(i);
        var delay = Server.headlessClientStartDelay + i * Server.headlessClientStartInterval;

        self.headlessClientTimers.push(setTimeout(function () {
            // The server was stopped or restarted since this was scheduled.
            if (self.instance !== instance) {
                return;
            }

            try {
                self.startHeadlessClient(i, options);
            } catch (err) {
                console.log(self.id + ' ' + profiles.headlessClientName(i) + ' failed to start: ' + err);
            }
        }, delay));
    });
};

Server.prototype.clearHeadlessClientTimers = function () {
    this.headlessClientTimers.forEach(function (timer) {
        clearTimeout(timer);
    });

    this.headlessClientTimers = [];
};

Server.prototype.headlessClientOptions = function (index) {
    return {
        filePatching: this.file_patching,
        game: config.game,
        host: '127.0.0.1',
        mods: this.mods.slice(),
        parameters: this.getHeadlessClientParameters(index),
        password: this.password,
        path: this.config.path,
        platform: this.config.type,
        port: this.port
    };
};

Server.prototype.startHeadlessClient = function (index, options) {
    var self = this;
    var headless = new ArmaServer.Headless(options || this.headlessClientOptions(index));
    var headlessInstance = headless.start();
    var name = profiles.headlessClientName(index);
    var logPrefix = this.id + ' ' + name;
    var headlessClientInstances = this.headlessClientInstances;
    console.log(logPrefix + ' starting');

    headlessClientInstances.push(headlessInstance);

    this.captureOutput(headlessInstance, this.id + '_' + name);

    ['stdout', 'stderr'].forEach(function (stream) {
        headlessInstance[stream].on('data', function (data) {
            console.log(logPrefix + ' ' + stream + ': ' + data);
        });
    });

    headlessInstance.on('close', function (code) {
        console.log(logPrefix + ' exited: ' + code);

        var elementIndex = headlessClientInstances.indexOf(headlessInstance);
        if (elementIndex !== -1) {
            headlessClientInstances.splice(elementIndex, 1);
        }
    });

    headlessInstance.on('error', function (err) {
        console.log(logPrefix + ' error: ' + err);
    });

    return headlessInstance;
};

// Each headless client gets its own -profiles subfolder (see lib/profiles.js for why). Without a
// profiles parameter there is nothing to separate, so the parameters pass through unchanged.
Server.prototype.getHeadlessClientParameters = function (index) {
    var parameters = this.getParameters();
    var base = profiles.profilesPath(parameters);

    if (base === null) {
        return parameters;
    }

    return profiles.withoutProfiles(parameters).concat([
        '-profiles=' + profiles.childPath(base, profiles.headlessClientName(index), this.config.type)
    ]);
};

Server.prototype.stop = function (cb) {
    // Stopping an already stopped server is a no-op rather than a crash, but the callback still
    // has to fire: routes/servers.js only sends its response from inside it.
    if (!this.instance) {
        if (cb) {
            cb();
        }

        return this;
    }

    var handled = false;

    this.instance.on('close', function (code) {
        if (!handled) {
            handled = true;

            if (cb) {
                cb();
            }
        }
    });

    // A pending start would otherwise still pass the instance check while the process is exiting
    // or hung.
    this.clearHeadlessClientTimers();
    this.instance.kill();

    setTimeout(function () {
        if (!handled) {
            handled = true;

            if (cb) {
                cb();
            }
        }
    }, Server.stopTimeout);

    return this;
};

// Stop and start again, to hand the game a clean process. Used by op mode to give the op server
// fresh memory before an operation.
Server.prototype.restart = function (cb) {
    cb = cb || function () {};

    var self = this;
    // Capture the instance we actually observed, rather than re-reading this.instance later: a
    // Start/Stop click from the UI mid-restart would otherwise make the check below misreport.
    var instance = this.instance;

    if (!instance) {
        try {
            this.start();
        } catch (err) {
            return cb(err);
        }

        return cb();
    }

    this.stop(function () {
        if (self.instance === instance) {
            // stop() fell back on its timeout and the process is still alive. Starting a second
            // one on the same port would be worse than reporting this.
            return cb(new Error('Server "' + self.id + '" did not stop in time, not restarting'));
        }

        try {
            self.start();
        } catch (err) {
            return cb(err);
        }

        cb();
    });

    return this;
};

// Resolve once the server is actually joinable, not merely spawned. restart()'s callback fires when
// the process is spawned, which is minutes before Arma answers a query. The real signal is the
// gamedig poll (queryStatus), which sets this.state and emits 'state' every few seconds.
//
// cb(null) on the first 'state' where this.state is truthy; cb(err) if the process exits first
// (instance goes null, e.g. a bad mod or mission) or the timeout elapses. Exactly one outcome.
Server.prototype.waitUntilOnline = function (timeoutMs, cb) {
    cb = cb || function () {};

    var self = this;
    var settled = false;
    var timer;

    var onState = function () {
        if (self.state) {
            return finish(null);
        }

        // The process exited during load, so it is never coming up on this attempt. Reported
        // distinctly from a timeout so the caller can say "went offline during startup" rather than
        // "still not back after N minutes", which would be a lie.
        if (!self.instance) {
            var err = new Error('Server "' + self.id + '" stopped before it came online');
            err.reason = 'offline';
            return finish(err);
        }
    };

    var teardown = function () {
        settled = true;
        clearTimeout(timer);
        self.removeListener('state', onState);
    };

    var finish = function (err) {
        if (settled) {
            return;
        }

        teardown();
        cb(err);
    };

    timer = setTimeout(function () {
        var err = new Error('Server "' + self.id + '" did not come online in time');
        err.reason = 'timeout';
        finish(err);
    }, timeoutMs);

    this.on('state', onState);

    // Lets a caller abandon the wait without firing cb, e.g. a newer run superseding this one.
    return function cancel() {
        if (settled) {
            return;
        }

        teardown();
    };
};

Server.prototype.stopHeadlessClients = function () {
    this.clearHeadlessClientTimers();

    this.headlessClientInstances.slice().forEach(function (headlessClientInstance) {
        headlessClientInstance.kill();
    });
};

Server.prototype.toJSON = function () {
    return {
        additionalConfigurationOptions: this.additionalConfigurationOptions,
        admin_password: this.admin_password,
        allowed_file_patching: this.allowed_file_patching,
        auto_start: this.auto_start,
        battle_eye: this.battle_eye,
        id: this.id,
        file_patching: this.file_patching,
        forcedDifficulty: this.forcedDifficulty,
        max_players: this.max_players,
        missions: this.missions,
        motd: this.motd,
        mods: this.mods,
        number_of_headless_clients: this.number_of_headless_clients,
        parameters: this.parameters,
        password: this.password,
        persistent: this.persistent,
        pid: this.pid,
        port: this.port,
        state: this.state,
        title: this.title,
        von: this.von,
        verify_signatures: this.verify_signatures
    };
};

module.exports = Server;
