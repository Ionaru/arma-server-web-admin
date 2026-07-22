# Discord Op Mode Restart Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Post a Discord message when op mode restarts the op server, and a second message when it is back online (or has failed / timed out), configured via `config.js`, with a status row and test button on the Op Mode page.

**Architecture:** Three new decoupled modules. `lib/discord.js` delivers one HTTPS POST and knows nothing about Arma. `lib/op-mode-notifier.js` subscribes to new op-mode events and decides what to say. `Server.prototype.waitUntilOnline` turns the existing gamedig `state` poll into a one-shot "server is joinable" signal. `lib/op-mode.js` gains only `emit()` calls. The configured-or-not flag reaches the browser as a derived boolean through the existing read-only `lib/settings.js` projection, never exposing the token.

**Tech Stack:** Node (ES5 `var`, callbacks, no promises), Express 4, `events`/`util.inherits`, Node built-in `https`, mocha 3 + `should` + `supertest`, Backbone/Marionette + underscore templates, webpack 1 in-memory.

## Global Constraints

- **No new npm dependencies.** Use Node's built-in `https`. Do not add `discord.js`, `@discordjs/rest`, `node-fetch`, `axios`, or use global `fetch`.
- **ES5 style throughout:** `var`, `function`, prototype methods, callbacks. No `let`/`const`/arrow/`async`/promises. Match surrounding code. ESLint `parserOptions.ecmaVersion` is 6, `semi: always`.
- **EventEmitter pattern:** `events.EventEmitter.call(this)` in the constructor + `util.inherits(Thing, events.EventEmitter)`. NEVER `Thing.prototype = new events.EventEmitter()`.
- **Discord REST facts (verified against discord-api-docs `main`):**
  - `POST https://discord.com/api/v10/channels/{channelId}/messages` (the `/v10/` is required).
  - Headers required: `Authorization: Bot <token>`, `Content-Type: application/json`, and `User-Agent: DiscordBot (<url>, <version>)`. Missing/invalid User-Agent → Cloudflare block (error 40333).
  - Body: `{"content": "<text, up to 2000 chars>"}`.
  - No gateway connection needed; the bot shows offline, which is fine.
- **Token secrecy:** `Settings.getPublicSettings()` is broadcast over socket.io to every browser. It must expose only a derived boolean `discordEnabled`, never `config.discord`.
- **Do not touch op mode's scheduler invariants** (fail-closed window consumption, guards-before-stops, serialised writes). This feature only *adds* `emit()` calls to `lib/op-mode.js`.
- **Lint command (the packaged one is broken):** `npx eslint app.js webpack.config.js config.js.example lib routes public/js test`
- **Test command:** `npm test` (`mocha --recursive`).
- **No AI attribution** in commits or code. No em-dash (`—`) anywhere.
- **Message copy (exact):**
  - `🔄 Restarting **<title>** for the operation.`
  - `✅ **<title>** is back online (took <duration>).`
  - `⚠️ **<title>** has not come back online after 15 minutes.`
  - `⚠️ **<title>** failed to restart: <reason>.`

---

### Task 1: `lib/discord.js` — the delivery module

**Files:**
- Create: `lib/discord.js`
- Test: `test/lib/discord.js`

**Interfaces:**
- Consumes: nothing (Node `https`, `../package.json`).
- Produces:
  - `Discord.isConfigured(config)` → boolean (static). True iff `config` truthy and both `config.token` and `config.channelId` are non-empty.
  - `new Discord(config)` where `config` is `{token, channelId}` (may be `undefined`).
  - `discord.isConfigured()` → boolean (instance, delegates to static).
  - `discord.send(content, cb)` → posts; `cb(err)` where `err` is an `Error` on: not configured, transport error, or non-2xx status. `cb(null)` on 2xx. Never throws.
  - `discord.request` — the low-level request function, defaulting to `https.request`, reassignable in tests.

- [ ] **Step 1: Write the failing test**

Create `test/lib/discord.js`:

```js
require('should');

var Discord = require('../../lib/discord.js');

// A fake https.request: records the options + written body, and drives a fake response through
// the callback so no socket is ever opened.
var fakeRequest = function (behaviour) {
    behaviour = behaviour || {};
    var calls = [];

    var fn = function (options, responseCb) {
        var call = {options: options, body: ''};
        calls.push(call);

        var res = {
            statusCode: behaviour.statusCode || 204,
            handlers: {},
            on: function (event, handler) {
                res.handlers[event] = handler;
                return res;
            }
        };

        var req = {
            on: function (event, handler) {
                if (event === 'error' && behaviour.transportError) {
                    // Fire asynchronously, like a real socket error.
                    setImmediate(function () {
                        handler(behaviour.transportError);
                    });
                }
                return req;
            },
            write: function (data) {
                call.body += data;
            },
            end: function () {
                if (behaviour.transportError) {
                    return;
                }
                // Deliver the response on next tick, mimicking https.
                setImmediate(function () {
                    responseCb(res);
                    if (res.handlers.data && behaviour.responseBody) {
                        res.handlers.data(behaviour.responseBody);
                    }
                    if (res.handlers.end) {
                        res.handlers.end();
                    }
                });
            }
        };

        return req;
    };

    fn.calls = calls;
    return fn;
};

describe('Discord', function () {
    describe('isConfigured()', function () {
        it('is false without token or channelId', function () {
            Discord.isConfigured(undefined).should.be.false();
            Discord.isConfigured({}).should.be.false();
            Discord.isConfigured({token: 't'}).should.be.false();
            Discord.isConfigured({channelId: 'c'}).should.be.false();
            Discord.isConfigured({token: '', channelId: ''}).should.be.false();
        });

        it('is true with both token and channelId', function () {
            Discord.isConfigured({token: 't', channelId: 'c'}).should.be.true();
        });

        it('is exposed as an instance method too', function () {
            new Discord({token: 't', channelId: 'c'}).isConfigured().should.be.true();
            new Discord({}).isConfigured().should.be.false();
        });
    });

    describe('send()', function () {
        it('posts to the v10 channel messages endpoint with the required headers and body', function (done) {
            var discord = new Discord({token: 'abc', channelId: '123'});
            discord.request = fakeRequest({statusCode: 204});

            discord.send('hello world', function (err) {
                (err === null || err === undefined).should.be.true();

                discord.request.calls.length.should.eql(1);
                var call = discord.request.calls[0];
                call.options.method.should.eql('POST');
                call.options.hostname.should.eql('discord.com');
                call.options.path.should.eql('/api/v10/channels/123/messages');
                call.options.headers.Authorization.should.eql('Bot abc');
                call.options.headers['Content-Type'].should.eql('application/json');
                call.options.headers['User-Agent'].should.match(/^DiscordBot \(.+, .+\)$/);
                JSON.parse(call.body).content.should.eql('hello world');
                done();
            });
        });

        it('calls back with an error and posts nothing when not configured', function (done) {
            var discord = new Discord({});
            discord.request = fakeRequest();

            discord.send('hello', function (err) {
                err.should.be.an.Error();
                discord.request.calls.length.should.eql(0);
                done();
            });
        });

        it('calls back with an error on a non-2xx status', function (done) {
            var discord = new Discord({token: 'abc', channelId: '123'});
            discord.request = fakeRequest({statusCode: 403, responseBody: '{"message":"Missing Permissions","code":50013}'});

            discord.send('hello', function (err) {
                err.should.be.an.Error();
                err.message.should.match(/403/);
                err.message.should.match(/50013/);
                done();
            });
        });

        it('calls back with an error on a transport failure', function (done) {
            var discord = new Discord({token: 'abc', channelId: '123'});
            discord.request = fakeRequest({transportError: new Error('ECONNREFUSED')});

            discord.send('hello', function (err) {
                err.should.be.an.Error();
                err.message.should.match(/ECONNREFUSED/);
                done();
            });
        });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/mocha/bin/mocha test/lib/discord.js > /tmp/t1.log 2>&1; cat /tmp/t1.log`
Expected: FAIL, cannot find module `../../lib/discord.js`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/discord.js`:

```js
var https = require('https');

var pkg = require('../package.json');

// The User-Agent Discord requires; a missing or invalid one gets the request blocked by Cloudflare
// (JSON error 40333). Format is mandated by the API reference: "DiscordBot ($url, $versionNumber)".
var userAgent = 'DiscordBot (https://github.com/Ionaru/arma-server-web-admin, ' + pkg.version + ')';

var Discord = function (config) {
    this.config = config || {};

    // Injectable so tests never open a socket.
    this.request = https.request;
};

// One definition of "configured", shared with lib/settings.js so the UI flag and the actual
// behaviour can never disagree.
Discord.isConfigured = function (config) {
    return !!(config && config.token && config.channelId);
};

Discord.prototype.isConfigured = function () {
    return Discord.isConfigured(this.config);
};

// send(content, cb). cb(err) on: not configured, transport error, or non-2xx. cb(null) on success.
// Never throws: a Discord outage must never look like an op mode failure to the caller.
Discord.prototype.send = function (content, cb) {
    cb = cb || function () {};

    if (!this.isConfigured()) {
        return cb(new Error('Discord is not configured'));
    }

    var payload = JSON.stringify({content: content});

    var options = {
        hostname: 'discord.com',
        path: '/api/v10/channels/' + this.config.channelId + '/messages',
        method: 'POST',
        headers: {
            'Authorization': 'Bot ' + this.config.token,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'User-Agent': userAgent
        }
    };

    var req = this.request(options, function (res) {
        var body = '';

        res.on('data', function (chunk) {
            body += chunk;
        });

        res.on('end', function () {
            if (res.statusCode >= 200 && res.statusCode < 300) {
                return cb(null);
            }

            cb(new Error('Discord responded ' + res.statusCode + ': ' + body));
        });
    });

    req.on('error', function (err) {
        cb(err);
    });

    req.write(payload);
    req.end();
};

module.exports = Discord;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/mocha/bin/mocha test/lib/discord.js > /tmp/t1.log 2>&1; cat /tmp/t1.log`
Expected: PASS, all cases in the `Discord` suite green.

- [ ] **Step 5: Commit**

```bash
git add lib/discord.js test/lib/discord.js
git commit -m "Add Discord REST delivery module"
```

---

### Task 2: `Server.prototype.waitUntilOnline` — the "joinable" signal

**Files:**
- Modify: `lib/server.js` (add a prototype method; add a named timeout default near `Server.stopTimeout` at line 50)
- Test: `test/lib/server.js` (extend the existing suite)

**Interfaces:**
- Consumes: the existing `state` event (`lib/server.js:104,209,224`) and `this.state` / `this.instance`.
- Produces: `server.waitUntilOnline(timeoutMs, cb)`. Calls `cb(null)` once, on the first `state` event where `this.state` is truthy. Calls `cb(err)` if `this.instance` becomes null first (process exited during load), or if `timeoutMs` elapses. Exactly one outcome; removes its own listener and clears its timer on resolution.

**Notes for the implementer:** the existing tests construct `new Server(null, null, {title: 'x'})` and drive events by hand with `server.emit('state')` and by setting `server.state` / `server.instance` directly. Follow that. Do not start a real Arma process.

- [ ] **Step 1: Write the failing tests**

Add to `test/lib/server.js`, inside the top-level `describe('Server', ...)` block (after the existing `restart()` describe):

```js
    describe('waitUntilOnline()', function () {
        it('resolves when a state poll first reports the server up', function (done) {
            var server = new Server(null, null, {title: 'test'});
            server.instance = {pid: 1234};
            server.state = null;

            server.waitUntilOnline(1000, function (err) {
                (err === null || err === undefined).should.be.true();
                done();
            });

            // A poll that still sees nothing must not resolve it.
            server.emit('state');

            // The next poll reports the server up.
            server.state = {players: []};
            server.emit('state');
        });

        it('does not resolve more than once', function (done) {
            var server = new Server(null, null, {title: 'test'});
            server.instance = {pid: 1234};
            var calls = 0;

            server.waitUntilOnline(1000, function () {
                calls++;
            });

            server.state = {players: []};
            server.emit('state');
            server.emit('state');

            setTimeout(function () {
                calls.should.eql(1);
                done();
            }, 10);
        });

        it('fails early when the process exits before coming up', function (done) {
            var server = new Server(null, null, {title: 'test'});
            server.instance = {pid: 1234};

            server.waitUntilOnline(1000, function (err) {
                err.should.be.an.Error();
                done();
            });

            // The process died during load: the close handler nulls instance and state, then emits.
            server.instance = null;
            server.state = null;
            server.emit('state');
        });

        it('fails when the timeout elapses with the server still down', function (done) {
            var server = new Server(null, null, {title: 'test'});
            server.instance = {pid: 1234};
            server.state = null;

            server.waitUntilOnline(20, function (err) {
                err.should.be.an.Error();
                done();
            });
        });
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/mocha/bin/mocha test/lib/server.js > /tmp/t2.log 2>&1; cat /tmp/t2.log`
Expected: FAIL, `server.waitUntilOnline is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `lib/server.js`, near `Server.stopTimeout = 5000;` (line 50), add:

```js
// How long waitUntilOnline waits for the gamedig poll to first report the server joinable before
// giving up. Named so callers and tests can shorten it, like Server.stopTimeout above.
Server.onlineTimeout = 15 * 60 * 1000;
```

Then add the method (place it after `restart`, around line 351):

```js
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

    var finish = function (err) {
        if (settled) {
            return;
        }

        settled = true;
        clearTimeout(timer);
        self.removeListener('state', onState);
        cb(err);
    };

    var onState = function () {
        if (self.state) {
            return finish(null);
        }

        // The process exited during load, so it is never coming up on this attempt.
        if (!self.instance) {
            return finish(new Error('Server "' + self.id + '" stopped before it came online'));
        }
    };

    var timer = setTimeout(function () {
        finish(new Error('Server "' + self.id + '" did not come online in time'));
    }, timeoutMs);

    this.on('state', onState);
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/mocha/bin/mocha test/lib/server.js > /tmp/t2.log 2>&1; cat /tmp/t2.log`
Expected: PASS, including the four new `waitUntilOnline()` cases.

- [ ] **Step 5: Commit**

```bash
git add lib/server.js test/lib/server.js
git commit -m "Add Server.waitUntilOnline to detect when a restarted server is joinable"
```

---

### Task 3: Op mode emits `run-started` and `run-failed`

**Files:**
- Modify: `lib/op-mode.js` (`OpMode.prototype.run`, lines 374-434)
- Test: `test/lib/op-mode.js` (extend the existing `run()` suite)

**Interfaces:**
- Consumes: the existing `run()` sequence, `this.manager.getServer`, the op server object.
- Produces two new events on the `OpMode` EventEmitter:
  - `run-started` with the **op server object** as its single argument, emitted after all guards pass and after `others` is computed, but before any server is stopped.
  - `run-failed` with `(opServer, err)`, emitted from the `done(err)` path when `err` is truthy.
- The existing `op-mode` event and all scheduler behaviour are unchanged.

**Note:** `fakeServer(id, running)` in this test file returns objects with `id`, `instance`, `stop`, `restart` (see lines 19-45). `run-started` will carry that fake object; assertions can check identity via `===`.

- [ ] **Step 1: Write the failing tests**

Add to `test/lib/op-mode.js`, inside `describe('run()', ...)`:

```js
        it('emits run-started with the op server before stopping anything', function (done) {
            var op = fakeServer('op', true);
            var other = fakeServer('other', true);
            var opMode = opModeWith([op, other]);

            var startedWith = null;
            opMode.on('run-started', function (server) {
                startedWith = server;
                // Nothing has been stopped yet at the moment run-started fires.
                other.stops.should.eql(0);
                op.restarts.should.eql(0);
            });

            opMode.run(function () {
                startedWith.should.equal(op);
                done();
            });
        });

        it('emits run-failed with the op server and error when the restart fails', function (done) {
            var op = fakeServer('op', true);
            op.restart = function (cb) {
                cb(new Error('did not stop in time'));
            };
            var opMode = opModeWith([op]);

            var failedWith = null;
            opMode.on('run-failed', function (server, err) {
                failedWith = {server: server, err: err};
            });

            opMode.run(function (err) {
                err.should.be.an.Error();
                failedWith.server.should.equal(op);
                failedWith.err.message.should.eql('did not stop in time');
                done();
            });
        });

        it('does not emit run-started when a guard refuses the run', function (done) {
            var other = fakeServer('other', true);
            // opServerId 'op' but no such server in the manager: run() refuses before touching anything.
            var opMode = opModeWith([other]);

            var started = false;
            opMode.on('run-started', function () {
                started = true;
            });

            opMode.run(function (err) {
                err.should.be.an.Error();
                started.should.be.false();
                other.stops.should.eql(0);
                done();
            });
        });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/mocha/bin/mocha test/lib/op-mode.js > /tmp/t3.log 2>&1; cat /tmp/t3.log`
Expected: FAIL on the run-started / run-failed assertions (`startedWith` stays null, `failedWith` stays null).

- [ ] **Step 3: Write minimal implementation**

In `lib/op-mode.js`, modify `run()`. After the `this.emit('op-mode');` at line 400 and the `done` definition, locate the block that computes `others` and logs, then emit `run-started` just before `async.each`. And in `done`, emit `run-failed` when there is an error.

Change the `done` function (lines 402-413) to:

```js
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
```

Then, between the `console.log('op-mode: stopping ...')` line (421) and the `async.each` call (423), add:

```js
    // Announce before stopping anything, so a Discord notification lands while the fleet is still
    // up. Carries the op server object itself: a consumer that follows the object is immune to the
    // title-derived-id changing under a rename mid-run.
    this.emit('run-started', opServer);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/mocha/bin/mocha test/lib/op-mode.js > /tmp/t3.log 2>&1; cat /tmp/t3.log`
Expected: PASS, the whole `OpMode` suite green (existing run() tests plus the three new ones).

- [ ] **Step 5: Commit**

```bash
git add lib/op-mode.js test/lib/op-mode.js
git commit -m "Emit run-started and run-failed events from op mode run"
```

---

### Task 4: `lib/op-mode-notifier.js` — decide what to say

**Files:**
- Create: `lib/op-mode-notifier.js`
- Test: `test/lib/op-mode-notifier.js`

**Interfaces:**
- Consumes:
  - `opMode` (EventEmitter emitting `run-started` (opServer) and `run-failed` (opServer, err)).
  - `discord` with `isConfigured()` and `send(content, cb)` (Task 1).
  - op server objects exposing `.title` and `.waitUntilOnline(timeoutMs, cb)` (Task 2).
  - `options.onlineTimeoutMs` (optional).
- Produces: `new OpModeNotifier(opMode, discord, options)`. Wires itself to the events in its constructor. Exposes `OpModeNotifier.onlineTimeoutMs` (default `15 * 60 * 1000`). No other public surface. Idempotent messaging: exactly one terminal message (online / timeout / failed) per run.

**Message copy (exact, from Global Constraints).** Duration format: whole minutes and seconds, `Xm Ys`, or `Ys` when under a minute.

- [ ] **Step 1: Write the failing tests**

Create `test/lib/op-mode-notifier.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/mocha/bin/mocha test/lib/op-mode-notifier.js > /tmp/t4.log 2>&1; cat /tmp/t4.log`
Expected: FAIL, cannot find module `../../lib/op-mode-notifier.js`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/op-mode-notifier.js`:

```js
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
```

**Note on `Date.now()`:** the surrounding app uses `new Date()` / `Date.now()` freely (e.g. `lib/op-mode.js` `tick`). This is production code, not a workflow script, so `Date.now()` is fine here. The duration test uses `formatDuration` directly with fixed inputs, so it does not depend on wall-clock timing.

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/mocha/bin/mocha test/lib/op-mode-notifier.js > /tmp/t4.log 2>&1; cat /tmp/t4.log`
Expected: PASS, all `OpModeNotifier` cases green.

- [ ] **Step 5: Commit**

```bash
git add lib/op-mode-notifier.js test/lib/op-mode-notifier.js
git commit -m "Add op mode notifier translating run events to Discord messages"
```

---

### Task 5: `routes/discord.js` — the test-message endpoint

**Files:**
- Create: `routes/discord.js`
- Test: `test/routes/discord.js`

**Interfaces:**
- Consumes: a `discord` instance with `isConfigured()` and `send(content, cb)`.
- Produces: an Express router. `POST /test` →
  - `400 {error: 'Discord is not configured'}` when `!discord.isConfigured()`,
  - `502 {error: <message>}` when `discord.send` calls back with an error,
  - `200 {ok: true}` on success.

- [ ] **Step 1: Write the failing test**

Create `test/routes/discord.js`:

```js
require('should');
var express = require('express');
var request = require('supertest');

var discordRoute = require('../../routes/discord.js');

var FakeDiscord = function (behaviour) {
    this.behaviour = behaviour || {};
    this.sent = [];
};
FakeDiscord.prototype.isConfigured = function () {
    return this.behaviour.configured !== false;
};
FakeDiscord.prototype.send = function (content, cb) {
    this.sent.push(content);
    cb(this.behaviour.sendError || null);
};

var appWith = function (discord) {
    var app = express();
    app.use('/api/discord', discordRoute(discord));
    return app;
};

describe('routes/discord', function () {
    it('POST /test returns 400 when Discord is not configured', function (done) {
        request(appWith(new FakeDiscord({configured: false})))
            .post('/api/discord/test')
            .expect('Content-Type', /json/)
            .expect(400, {error: 'Discord is not configured'}, done);
    });

    it('POST /test posts a message and returns 200 on success', function (done) {
        var discord = new FakeDiscord();

        request(appWith(discord))
            .post('/api/discord/test')
            .expect(200, {ok: true})
            .end(function (err) {
                if (err) {
                    return done(err);
                }

                discord.sent.length.should.eql(1);
                done();
            });
    });

    it('POST /test returns 502 with the message when Discord rejects it', function (done) {
        var discord = new FakeDiscord({sendError: new Error('Discord responded 403: Missing Permissions')});

        request(appWith(discord))
            .post('/api/discord/test')
            .expect('Content-Type', /json/)
            .expect(502, {error: 'Discord responded 403: Missing Permissions'}, done);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/mocha/bin/mocha test/routes/discord.js > /tmp/t5.log 2>&1; cat /tmp/t5.log`
Expected: FAIL, cannot find module `../../routes/discord.js`.

- [ ] **Step 3: Write minimal implementation**

Create `routes/discord.js`:

```js
var express = require('express');

module.exports = function (discord) {
    var router = express.Router();

    // Posts a real message so an operator can confirm the token, channel id and bot permissions are
    // right before op night, rather than discovering a 401/403/404 when it matters.
    router.post('/test', function (req, res) {
        if (!discord.isConfigured()) {
            return res.status(400).json({error: 'Discord is not configured'});
        }

        discord.send('Test message from the Arma server panel.', function (err) {
            if (err) {
                return res.status(502).json({error: err.message});
            }

            res.json({ok: true});
        });
    });

    return router;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/mocha/bin/mocha test/routes/discord.js > /tmp/t5.log 2>&1; cat /tmp/t5.log`
Expected: PASS, all three cases green.

- [ ] **Step 5: Commit**

```bash
git add routes/discord.js test/routes/discord.js
git commit -m "Add POST /api/discord/test endpoint for verifying Discord config"
```

---

### Task 6: `lib/settings.js` exposes the derived `discordEnabled` flag

**Files:**
- Modify: `lib/settings.js`
- Test: `test/lib/settings.js` (create; there is no existing settings test)

**Interfaces:**
- Consumes: `Discord.isConfigured` (Task 1), `this.config.discord`.
- Produces: `getPublicSettings()` returns the existing `{game, path, type}` plus `discordEnabled` (boolean). Never returns `config.discord` or the token.

- [ ] **Step 1: Write the failing test**

Create `test/lib/settings.js`:

```js
require('should');

var Settings = require('../../lib/settings.js');

describe('Settings', function () {
    describe('getPublicSettings()', function () {
        it('exposes game, path and type', function () {
            var settings = new Settings({game: 'arma3', path: '/arma', type: 'linux'});
            var pub = settings.getPublicSettings();
            pub.game.should.eql('arma3');
            pub.path.should.eql('/arma');
            pub.type.should.eql('linux');
        });

        it('reports discordEnabled true only when token and channelId are both set', function () {
            new Settings({discord: {token: 't', channelId: 'c'}})
                .getPublicSettings().discordEnabled.should.be.true();

            new Settings({discord: {token: 't'}})
                .getPublicSettings().discordEnabled.should.be.false();

            new Settings({}).getPublicSettings().discordEnabled.should.be.false();
        });

        it('never leaks the discord config or token', function () {
            var settings = new Settings({discord: {token: 'super-secret', channelId: 'c'}});
            var pub = settings.getPublicSettings();
            (pub.discord === undefined).should.be.true();
            JSON.stringify(pub).should.not.match(/super-secret/);
        });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/mocha/bin/mocha test/lib/settings.js > /tmp/t6.log 2>&1; cat /tmp/t6.log`
Expected: FAIL, `discordEnabled` is undefined.

- [ ] **Step 3: Write minimal implementation**

Replace `lib/settings.js` with:

```js
var _ = require('lodash');

var Discord = require('./discord');

var Settings = function (config) {
    this.config = config;
};

Settings.prototype.getPublicSettings = function () {
    var settings = _.pick(this.config, ['game', 'path', 'type']);

    // A derived boolean, never the raw config.discord: this object is broadcast over socket.io to
    // every connected browser, and config.discord holds the bot token.
    settings.discordEnabled = Discord.isConfigured(this.config.discord);

    return settings;
};

module.exports = Settings;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/mocha/bin/mocha test/lib/settings.js > /tmp/t6.log 2>&1; cat /tmp/t6.log`
Expected: PASS, all three cases green.

- [ ] **Step 5: Commit**

```bash
git add lib/settings.js test/lib/settings.js
git commit -m "Expose derived discordEnabled flag in public settings"
```

---

### Task 7: Wire everything into `app.js` and `config.js.example`

**Files:**
- Modify: `app.js`
- Modify: `config.js.example`
- Test: `test/app.js` (extend if it asserts on wiring; otherwise this task's proof is `npm test` staying green plus a manual boot check)

**Interfaces:**
- Consumes: `Discord` (Task 1), `OpModeNotifier` (Task 4), `routes/discord` (Task 5).
- Produces: a booting app that constructs `discord`, constructs `OpModeNotifier(opMode, discord)`, mounts `/api/discord`, and emits `settings` before `servers` on socket connection.

- [ ] **Step 1: Read the current `test/app.js`**

Run: `cat test/app.js`
Note whether it asserts on the socket emit order or route mounting. It most likely just boots the app via supertest. If it has no relevant assertions, no test change is needed here; the safety net is the full suite plus the boot check in Step 5.

- [ ] **Step 2: Add the config block to `config.js.example`**

In `config.js.example`, add before the final `logFormat` line (keep the trailing comma style of the file):

```js
  discord: { // Optional. When both are set, op mode restarts are announced in this Discord channel.
    token: '', // Bot token. Leave blank to disable Discord notifications.
    channelId: '', // Id of the channel to post restart messages in.
  },
```

- [ ] **Step 3: Modify `app.js`**

Add the requires near the other `lib` requires (after `var Settings = require('./lib/settings');`, line 17):

```js
var Discord = require('./lib/discord');
var OpModeNotifier = require('./lib/op-mode-notifier');
```

After `var opMode = new OpMode(manager);` (line 46), add:

```js
var discord = new Discord(config.discord);

// Subscribes to op mode's run events and posts to Discord. Kept in a variable so its subscriptions
// stay referenced for the life of the process.
var opModeNotifier = new OpModeNotifier(opMode, discord);
```

Mount the route alongside the others (after the `/api/settings` line, line 53):

```js
app.use('/api/discord', require('./routes/discord')(discord));
```

Reorder the connection handler so `settings` is emitted before `servers` (because `router.js` starts `Backbone.history` from inside the `servers` handler, and the Op Mode page reads `discordEnabled` from settings on first render). Change lines 55-61 to:

```js
io.on('connection', function (socket) {
    socket.emit('missions', missions.missions);
    socket.emit('mods', mods.mods);
    socket.emit('op-mode', opMode.getState());
    socket.emit('settings', settings.getPublicSettings());
    socket.emit('servers', manager.getServers());
});
```

(Only the `settings` line moves above `servers`; the others are unchanged.)

- [ ] **Step 4: Run the full test suite**

Run: `npm test > /tmp/t7.log 2>&1; cat /tmp/t7.log`
Expected: PASS, every suite green (existing + all new ones from Tasks 1-6).

- [ ] **Step 5: Boot check (no real Arma needed)**

Run:
```bash
cp -n config.js.example config.js 2>/dev/null; node -e "require('./app.js'); console.log('app.js loaded clean'); process.exit(0);" > /tmp/t7boot.log 2>&1; cat /tmp/t7boot.log
```
Expected: `app.js loaded clean` with no throw. (Requiring `app.js` does not call `listen` or `opMode.load`, per the `require.main === module` guard, but it does construct everything including `new Discord(config.discord)` and `new OpModeNotifier(...)`.)

Note: if `config.js` already existed it is left untouched by `cp -n`; that is fine.

- [ ] **Step 6: Commit**

```bash
git add app.js config.js.example
git commit -m "Wire Discord notifier and test route into the app"
```

---

### Task 8: Frontend — status row and test button on the Op Mode page

**Files:**
- Modify: `public/js/app/models/settings.js` (add `discordEnabled` default)
- Modify: `public/js/app/router.js` (pass `settings` into `OpModeView`)
- Modify: `public/js/app/views/op-mode.js` (store settings, listen, helper, test handler)
- Modify: `public/js/tpl/op-mode.html` (the row + button)
- Test: covered by `test/public/templates.js` (compiles every template; no new assertion needed) plus the manual browser check in Step 7.

**Interfaces:**
- Consumes: the `settings` Backbone model carrying `discordEnabled` (Task 6 + Task 7 socket emit).
- Produces: a read-only "Discord" row and a working "Send test message" button posting to `/api/discord/test` (Task 5).

- [ ] **Step 1: Add the model default**

In `public/js/app/models/settings.js`, add `discordEnabled: false` to the existing `defaults` (which currently holds only `path` and `type`):

```js
module.exports = Backbone.Model.extend({
    defaults: {
        path: '',
        type: '',
        discordEnabled: false
    },
    urlRoot: '/api/settings'
});
```

- [ ] **Step 2: Pass settings into the Op Mode view**

In `public/js/app/router.js`, change the `opMode` route (line 85-87) to pass the shared `settings` model:

```js
    opMode: function () {
        layoutView.content.show(new OpModeView({model: opMode, servers: servers, settings: settings}));
    },
```

- [ ] **Step 3: Store settings, listen, add helper and handler in the view**

In `public/js/app/views/op-mode.js`:

In `initialize` (after `this.servers = options.servers;`), add:

```js
        this.settings = options.settings;
        // Re-render when Discord config availability changes, but not on unrelated settings churn.
        if (this.settings) {
            this.listenTo(this.settings, 'change:discordEnabled', this.refresh);
        }
```

In `events`, add the test button handler:

```js
    events: {
        'click .save': 'save',
        'click .run': 'run',
        'click .test-discord': 'testDiscord',
        'change form': 'touched'
    },
```

In `templateHelpers`, add `discordEnabled` to the returned object:

```js
    templateHelpers: function () {
        var model = this.model;
        var settings = this.settings;

        return {
            dayNames: DAY_NAMES,
            servers: this.servers,
            discordEnabled: settings ? !!settings.get('discordEnabled') : false,

            isDaySelected: function (day) {
                return (model.get('days') || []).indexOf(day) !== -1 ? 'checked' : '';
            },

            isOpServer: function (id) {
                return model.get('opServerId') === id ? 'selected' : '';
            }
        };
    },
```

Add the `testDiscord` method (after `run`):

```js
    testDiscord: function (event) {
        event.preventDefault();

        var $button = this.$('.test-discord');
        if ($button.prop('disabled')) {
            return;
        }

        $button.prop('disabled', true);

        $.ajax({
            url: '/api/discord/test',
            type: 'POST',
            success: function () {
                $button.prop('disabled', false);
                sweetAlert({
                    title: 'Sent',
                    text: 'A test message was posted to Discord.',
                    type: 'success'
                });
            },
            error: function (err) {
                $button.prop('disabled', false);
                sweetAlert({
                    title: 'Error',
                    text: errorText(err),
                    type: 'error'
                });
            }
        });
    },
```

- [ ] **Step 4: Add the row to the template**

In `public/js/tpl/op-mode.html`, add a new `form-group` immediately after the "Next run" group (after its closing `</div>` around line 113, before the button group):

```html
    <div class="form-group">
        <label class="col-sm-2 control-label">Discord</label>
        <div class="col-sm-10">
            <% if (discordEnabled) { %>
            <p class="form-control-static">
                <span class="text-success">Restarts are announced in Discord.</span>
            </p>
            <button type="button" class="btn btn-default btn-sm test-discord">
                <span class="glyphicon glyphicon-envelope"></span> Send test message
            </button>
            <p class="help-block">
                Configured in <code>config.js</code>. Restart the panel to change it.
            </p>
            <% } else { %>
            <p class="form-control-static">
                <span class="text-muted">Not configured, no messages are sent.</span>
            </p>
            <p class="help-block">
                Set <code>discord.token</code> and <code>discord.channelId</code> in
                <code>config.js</code>, then restart the panel.
            </p>
            <% } %>
        </div>
    </div>
```

- [ ] **Step 5: Run the template compile + full suite**

Run: `npm test > /tmp/t8.log 2>&1; cat /tmp/t8.log`
Expected: PASS, including `test/public/templates.js` compiling the modified `op-mode.html` without a SyntaxError. (This guards the Underscore-template trap from commit `989c729`: use `<% %>` control blocks only, never `<%# %>`.)

- [ ] **Step 6: Lint**

Run: `npx eslint app.js webpack.config.js config.js.example lib routes public/js test > /tmp/t8lint.log 2>&1; cat /tmp/t8lint.log`
Expected: no errors.

- [ ] **Step 7: Manual browser check (optional but recommended)**

With a real `config.js` (Discord blank), `npm start`, open `http://localhost:3000/#op-mode`, confirm the Discord row reads "Not configured". Fill `config.js` `discord.token`/`channelId` with real values, restart, reload, confirm the row reads "announced in Discord" and "Send test message" posts to the channel and shows the success alert.

- [ ] **Step 8: Commit**

```bash
git add public/js/app/models/settings.js public/js/app/router.js public/js/app/views/op-mode.js public/js/tpl/op-mode.html
git commit -m "Show Discord status and add a test-message button on the Op Mode page"
```

---

### Task 9: Documentation

**Files:**
- Modify: `docs/op-mode.md` (add a "Discord notifications" section)
- Modify: `README.md` (add a `discord` config row)
- Modify: `CLAUDE.md` (add a short section under Op mode)

**Interfaces:** none (docs only).

- [ ] **Step 1: Add the operator section to `docs/op-mode.md`**

Append a new section (before "## Where the settings live", so the settings-location note stays last):

```markdown
## Discord notifications

If you give the panel a Discord bot token and a channel id, it posts to that channel when op mode
runs:

- When a run starts: **Restarting <op server> for the operation.**
- When the op server is back online and joinable: **<op server> is back online (took Xm Ys).** The
  time is measured from the restart message, so it includes the few seconds spent stopping the
  other servers.
- If the op server does not come back within 15 minutes: **<op server> has not come back online
  after 15 minutes.**
- If the restart fails outright (for example the op server would not stop in time): **<op server>
  failed to restart: ...**

Both the scheduled run and **Run now** post these messages.

### Turning it on

Add a `discord` block to `config.js` with a bot token and the target channel's id, then restart the
panel:

    discord: {
      token: 'your-bot-token',
      channelId: '123456789012345678',
    },

The bot must be a member of the server and have permission to send messages in that channel. It does
not need to appear online; it will show as offline in the member list, which is normal for a
notify-only bot.

Leave either field blank to turn notifications off.

### The Discord row on the Op Mode page

The page shows whether notifications are configured. When they are, a **Send test message** button
posts a real message to the channel so you can confirm the token, channel id and permissions are
right. If the token is wrong, the channel id is wrong, or the bot lacks permission, the test tells
you straight away rather than you finding out on op night. "Configured" on its own only means the
two fields are filled in; the test button is what proves it actually works.

Changing the token or channel means editing `config.js` and restarting the panel, the same as the
rest of that file.
```

- [ ] **Step 2: Add the README config row**

In `README.md`, in the Config table, add a row (match the existing table's columns):

```markdown
| discord | Optional `{ token, channelId }`. When both are set, op mode restarts are announced in that Discord channel. |
```

- [ ] **Step 3: Add the CLAUDE.md note**

In `CLAUDE.md`, under the "## Op mode" section (at its end, before "## Testing and linting"), add:

```markdown
### Discord notifications

Op mode restarts are announced to a Discord channel, wired as three decoupled modules so
`lib/op-mode.js` only gained two `emit()` calls (`run-started`, `run-failed`) and no new state:

- `lib/discord.js` posts one HTTPS POST to the Discord REST API (`POST /api/v10/channels/:id/messages`,
  built-in `https`, no dependency). Discord **requires** a `User-Agent: DiscordBot (url, version)`
  header or Cloudflare blocks the request. `Discord.isConfigured(config)` is the single source of
  truth for "is Discord on".
- `lib/op-mode-notifier.js` subscribes to the two op mode events and decides the message text. It
  owns the only new state: the in-flight run and its online-wait.
- `Server.prototype.waitUntilOnline` resolves off the gamedig `state` poll, because `restart()`'s
  callback fires at process spawn, minutes before the game is joinable. That is what the "back
  online, took X" timing is measured against.

Two traps:

1. The token lives in `config.js`. `lib/settings.js` exposes only a derived boolean
   `discordEnabled`, never `config.discord`, because `getPublicSettings()` is broadcast over
   socket.io to every browser. If you add fields to the public settings, keep the token out.
2. `app.js` emits `settings` before `servers` on socket connection on purpose: `router.js` starts
   `Backbone.history` from inside the `servers` handler, so the Op Mode page's Discord row needs
   `settings` to have arrived before the first render. The frontend also listens for
   `change:discordEnabled`, so the order is a belt-and-braces, not the sole guarantee.
```

- [ ] **Step 4: Commit**

```bash
git add docs/op-mode.md README.md CLAUDE.md
git commit -m "Document Discord op mode notifications"
```

---

### Task 10: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Full test suite**

Run: `npm test > /tmp/final-test.log 2>&1; cat /tmp/final-test.log`
Expected: all suites pass, including `Discord`, `Server` (with `waitUntilOnline`), `OpMode` (with the new event tests), `OpModeNotifier`, `routes/discord`, `Settings`, and the existing suites unchanged.

- [ ] **Step 2: Lint**

Run: `npx eslint app.js webpack.config.js config.js.example lib routes public/js test > /tmp/final-lint.log 2>&1; cat /tmp/final-lint.log`
Expected: no errors.

- [ ] **Step 3: Boot check**

Run: `node -e "require('./app.js'); console.log('ok'); process.exit(0);" > /tmp/final-boot.log 2>&1; cat /tmp/final-boot.log`
Expected: `ok`, no throw.

- [ ] **Step 4: Confirm no stray secrets in the public projection**

Manually confirm `lib/settings.js` `getPublicSettings()` returns only `game`, `path`, `type`, `discordEnabled`, and that grepping the frontend bundle sources shows no `token` reference:

Run: `grep -rn "config.discord\|\.token" public/js > /tmp/final-secret.log 2>&1; cat /tmp/final-secret.log`
Expected: no matches referencing the token in `public/js`.

---

## Self-Review

**Spec coverage:**
- Two messages (restarting / back online + duration) → Tasks 3, 4.
- Timeout + immediate-failure messages → Tasks 2, 3, 4.
- `config.js`-only config → Tasks 6, 7.
- Status row → Task 8. Test-message button → Tasks 5, 8.
- Built-in `https`, no dependency → Task 1, Global Constraints.
- Token never reaches the browser → Task 6 (derived boolean) + Task 10 Step 4.
- `settings`/`servers` emit order → Task 7.
- Docs (operator + README + CLAUDE.md) → Task 9.
- Op mode invariants untouched (only emits added) → Task 3.

**Placeholder scan:** none; every code step contains full code.

**Type/name consistency:** `Discord.isConfigured` (static) and `discord.isConfigured()` (instance) used consistently across Tasks 1, 4, 5, 6. `waitUntilOnline(timeoutMs, cb)` signature consistent across Tasks 2 and 4. `run-started` (opServer) and `run-failed` (opServer, err) payloads consistent across Tasks 3 and 4. `discordEnabled` key consistent across Tasks 6, 7, 8. `OpModeNotifier.formatDuration` used in Task 4 test and implementation.
