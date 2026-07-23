# Discord notifications for op mode restarts

## Problem

When op mode runs, an admin or mission maker has no signal off the box that it happened. Today the
only evidence a run occurred is a transient banner on the Op Mode page (visible only to a browser
that had the page open at the moment it fired) and a `console.log` line in the node process output.
The people who care (admins and mission makers, who want to know when they can log in and load the
mission) are not watching the panel.

This feature posts a message to a Discord channel when an op mode restart starts, and a second
message when the op server is back online and joinable, including how long that took. The unit
already has bot credentials in the target channel.

## Scope

In scope:

- A message when op mode begins a run ("restarting").
- A message when the op server is confirmed back online ("back online, took X"), with the elapsed
  time measured from the "restarting" message.
- A message when the op server does not come back within a timeout ("has not come back online
  after 15 minutes").
- A message when the restart itself errors immediately ("failed to restart: <reason>").
- Configuration via `config.js` only (bot token + channel id).
- A read-only status row on the Op Mode page showing whether Discord notifications are configured.
- A "Send test message" button on the Op Mode page that posts a real message and reports the
  outcome, so a bad token / wrong channel / missing permission is caught before op night.
- Operator docs, a README config row, and a CLAUDE.md addendum.

Out of scope (deliberately):

- Notifications for manual single-server Start/Stop/Restart clicks, or for crashes. Only op mode
  runs announce themselves. (The "run-started" event fires for both the scheduled run and "Run
  now", because both do the same thing to the fleet.)
- Role mentions / pings. Plain text, one line per message.
- Per-message custom bot name/avatar (only webhooks can do that; not needed).
- A persisted in-app run history. The Discord channel is the durable record.
- Any mutable, UI-editable Discord config. Token and channel live in `config.js` and change only by
  editing that file and restarting the panel, exactly like the existing HTTP basic-auth password.

## Why these design choices

### Delivery: Node's built-in `https`, no new dependency

The production box runs Node 20.1.0, which clears the `node >=18` floor of `@discordjs/rest`
(2.6.3) and `discord.js` (14.27.0), so a library is now possible rather than impossible. It is still
the wrong call here:

- The whole job is one `POST https://discord.com/api/v10/channels/{id}/messages`. Message volume is
  roughly three per week against Discord's documented 50 req/s global limit, so the rate-limit
  bucket handling and retry machinery those libraries exist to provide is dead weight.
- Global `fetch` exists on Node 20 but is documented Stability 1 (Experimental), disableable with
  `--no-experimental-fetch`. Building a production notifier on an experimental global is avoidable.
- The codebase is deliberately un-modernised: ES5 `var`, callbacks, no promises or `async`
  anywhere. A callback-style `https.request` helper matches it and pulls in nothing.

So `lib/discord.js` is a ~40-line, zero-dependency module in the existing style.

Verified Discord facts that shape it (checked against `github.com/discord/discord-api-docs` `main`):

- A bot token needs **no gateway/websocket connection** for REST posts. The bot will simply show as
  offline in the member list, which is harmless for a notifier.
- Endpoint: `POST https://discord.com/api/v10/channels/{channelId}/messages`. The `/v10/` segment
  is required; omitting the version silently targets the deprecated v6.
- Required headers: `Authorization: Bot <token>`, `Content-Type: application/json`, and
  `User-Agent: DiscordBot (<url>, <version>)`. The User-Agent is **not optional**: requests without
  a valid one "may be blocked and return a Cloudflare error" (JSON error code 40333).
- Body for a plain message: `{"content": "..."}` (up to 2000 chars).
- Failure modes: 401 (invalid token, code 50014), 403 (missing SEND_MESSAGES, code 50013), 404
  (unknown channel, code 10003), 429 (rate limited, `retry_after` in body).

### Structure: three small modules, wired in app.js

`lib/op-mode.js` is 436 dense lines holding invariants the commit history warns about (fail-closed
window consumption, every-guard-before-any-stop, serialised writes). A Discord client, a 15-minute
timer, and "wait until online" logic do not belong inside it. Instead op mode gains three `emit()`
calls and no new state, no new timers, and no behavioural change.

```
lib/op-mode.js           decides WHAT HAPPENED   emits run-started / run-restarted / run-failed
lib/op-mode-notifier.js  decides WHAT TO SAY     message text, waits for "online", timeout
lib/discord.js           decides HOW TO DELIVER  one HTTPS POST, knows nothing about Arma
```

This mirrors how the app already keeps transport concerns out of domain modules: `app.js` wires
`opMode.on('op-mode', ...)` to `io.emit`, and `lib/op-mode.js` never imports socket.io. The notifier
is the same shape: it subscribes to op mode events and calls Discord, and neither op mode nor Discord
knows the other exists.

### Config lives in config.js and reaches the UI as a derived boolean

`config.js` is gitignored and already holds the HTTP basic-auth password, so a bot token is at home
there. `lib/settings.js` is a read-only `_.pick` projection of `config.js` that is broadcast over
socket.io to every browser. This is the correct channel for a *whether-configured* flag (which is
read-only, static, and derived from `config.js`), and it is emphatically **not** the same as the
mutable UI-editable state CLAUDE.md says op mode deliberately kept out of settings.js.

The hard rule: settings.js must expose a **derived boolean**, never `config.discord`, because that
object contains the token and `getPublicSettings()` goes to every connected browser.

## Components

### `lib/discord.js` (new)

```js
var https = require('https');
var pkg = require('../package.json');

var Discord = function (config) {
    this.config = config || {};
    // Injectable so tests never open a socket.
    this.request = https.request;
};

// One definition of "configured", shared by the notifier and by settings.js, so the UI and the
// behaviour can never disagree about whether Discord is on.
Discord.isConfigured = function (config) {
    return !!(config && config.token && config.channelId);
};

Discord.prototype.isConfigured = function () {
    return Discord.isConfigured(this.config);
};

// send(content, cb). cb(err) where err is set on: not configured, transport error, or non-2xx.
// Never throws; a Discord outage must never look like an op mode failure.
Discord.prototype.send = function (content, cb) { ... };

module.exports = Discord;
```

- `send` builds the payload, sets the three required headers (User-Agent from
  `package.json` name/version + the repo URL), POSTs, and buffers the response so a non-2xx status
  yields a useful error message (status code + body) to the callback.
- If not configured, `send` calls back with an error immediately and posts nothing. Callers that
  fire on every run (the notifier) check `isConfigured()` first and stay silent; the test-message
  route surfaces the error to the operator.

### `lib/server.js` — `Server.prototype.waitUntilOnline(timeoutMs, cb)` (new)

The signal that makes the "back online" message possible. `restart()`'s callback fires when the new
process is **spawned**, which is minutes before Arma is joinable. The real readiness signal is the
gamedig poll (`lib/server.js:81`), which runs every 5s and emits `state`; `this.state` is truthy
once a query succeeds.

```js
Server.prototype.waitUntilOnline = function (timeoutMs, cb) {
    // Resolve on the first 'state' event where this.state is truthy. Event-driven, not a read of
    // current state, so a stale reading cannot resolve it instantly.
    // Fail early if this.instance goes null (process exited during load: bad mod / bad mission),
    // rather than waiting out the full timeout.
    // Single-shot: exactly one of online / offline-exit / timeout fires cb, then listeners are
    // removed. Uses util removeListener, following the existing EventEmitter usage in this file.
};
```

`cb(null)` on online, `cb(err)` on timeout or on the process exiting before it came up. The
`timeoutMs` is passed in (not hardcoded here) so the notifier owns the policy and tests can shorten
it.

### `lib/op-mode-notifier.js` (new)

Holds the only new state in the feature: the run start time and the in-flight online watcher.

- Constructed with `(opMode, discord, options)`. `options.onlineTimeoutMinutes` (from
  `config.discord`) is validated by `OpModeNotifier.resolveTimeoutMinutes`, falling back to
  `OpModeNotifier.defaultOnlineTimeoutMinutes` (15) for anything that is not a positive finite number.
- Subscribes to the three op mode events.
- On `run-started`: record start time, post "🔄 Restarting **<title>** for the operation.", then
  begin waiting for the op server to come online (`waitUntilOnline`). On success post "✅
  **<title>** is back online (took <duration>).", on timeout/early-exit post "⚠️ **<title>** has
  not come back online after 15 minutes." Duration measured from the run-started timestamp (what an
  admin actually experiences, including the ~10s of fleet stopping) and formatted as e.g. `4m 12s`.
- On `run-failed`: post "⚠️ **<title>** failed to restart: <reason>." and cancel any pending online
  wait. This is the immediate-error path (`restart()` errored, e.g. "did not stop in time").
- If Discord `isConfigured()` is false, the notifier does nothing (no wasted timers or waiters).
- Guards: exactly one terminal message per run (online / timeout / failed). A `run-failed` after a
  `run-started` cancels the waiter so a run can never emit both "back online" and "failed".

### `lib/op-mode.js` (edit) — three emits, no logic change

- `run-started`: emitted inside `run()` after all guards pass and after `others` is computed, but
  **before** `async.each` stops anything, so the announcement lands while the fleet is still up.
  Payload: the op server **object** (the notifier needs it both to read `title` for the message and
  to call `waitUntilOnline` on it). Holding that live reference for the duration of one run also
  sidesteps the title-derived-id rename trap: the notifier follows the object, not a re-resolved id.
  No server count (per product decision).
- `run-restarted`: emitted from op mode's `done()` success path (see the review-revision section
  below). This is the signal that the *replacement* process has been spawned, so the notifier can
  safely arm `waitUntilOnline` against the new instance rather than the old one. Payload: the op
  server object. (The original design omitted this event and armed the wait at `run-started`; that
  was the false-"back online" bug found in review.)
- `run-failed`: emitted from op mode's `done(err)` path when `err` is set. Payload: op server +
  `err.message`.

These are additive `emit()` calls on the existing EventEmitter; no existing behaviour changes. The
existing `op-mode` event and its socket broadcast are untouched.

> Note: op mode emits **three** new events, `run-started`, `run-restarted`, and `run-failed`. The
> notifier derives the four terminal messages (online / went-offline / timed-out / failed) from
> these plus the server's own `state` poll.

### `lib/settings.js` (edit)

```js
Settings.prototype.getPublicSettings = function () {
    var settings = _.pick(this.config, ['game', 'path', 'type']);
    // Derived boolean, never the raw config.discord: this goes to every browser and config.discord
    // holds the bot token.
    settings.discordEnabled = Discord.isConfigured(this.config.discord);
    return settings;
};
```

### `routes/discord.js` (new) — the test-message endpoint

`POST /api/discord/test`, mounted in `app.js`. Constructed with the shared `discord` instance. Posts
a fixed "Test message from the Arma server panel." and reports the result:

- Not configured → `400 {error: 'Discord is not configured'}`.
- `discord.send` error → `502 {error: <message>}` (surfaces 401/403/404 text to the operator).
- Success → `200 {ok: true}`.

### `config.js.example` (edit)

```js
discord: {
  token: '',                // Bot token. Leave blank to disable Discord notifications.
  channelId: '',            // Id of the channel to post restart messages in.
  onlineTimeoutMinutes: 15, // Online-wait before the warning. Optional, defaults to 15.
},
```

No `enabled` flag: on iff both credential fields are set, mirroring `lib/setup-basic-auth.js` (auth
is on iff username and password are both set). `onlineTimeoutMinutes` is optional; the notifier
validates it (positive finite number, else 15) and the warning message derives its wording from the
value in force, so the two can never disagree.

### `app.js` (edit) — wiring

- Construct `var discord = new Discord(config.discord);`.
- Construct the notifier after `opMode` and `manager` exist:
  `new OpModeNotifier(opMode, manager, discord);` (kept in a variable so it is not GC-surprising,
  though it stays referenced via its event subscriptions).
- Mount `app.use('/api/discord', require('./routes/discord')(discord));`.
- Pass `config.discord` into `Settings` (already receives `config`), no change needed beyond
  settings.js using it.
- **Emit `settings` before `servers` in the connection handler.** `router.js` starts
  `Backbone.history` from inside the `servers` handler, so on a direct load of `#op-mode` the page
  would otherwise render before `settings` arrived and show "Not configured" then flip. Reordering
  makes `settings` present before history starts; the frontend `listenTo` (below) is kept as well so
  the ordering is not silently load-bearing.

### Frontend

- `public/js/app/models/settings.js`: add `discordEnabled: false` to model defaults (the collection
  already sets from the socket payload).
- `public/js/app/router.js`: pass `settings` into `OpModeView` the same way `servers` is already
  passed (`opMode:` route, line 86).
- `public/js/app/views/op-mode.js`:
  - store `this.settings = options.settings`,
  - `this.listenTo(this.settings, 'change:discordEnabled', this.refresh)` (narrow, matching the
    existing `'add remove change:title'` listener and its "don't re-render on unrelated changes"
    rationale),
  - add a `discordEnabled` template helper,
  - add a `'click .test-discord': 'testDiscord'` event that POSTs to `/api/discord/test` and reports
    via the existing `sweetAlert` + `errorText` helpers (same pattern as `save`/`run`).
- `public/js/tpl/op-mode.html`: a read-only row next to "Next run", labelled **Discord** (not
  "Enabled", which the schedule checkbox already uses):
  - configured: "✓ Restarts are announced in Discord." + help note "Configured in config.js. Restart
    the panel to change it." and an enabled **Send test message** button.
  - not configured: "Not configured, no messages are sent." + help note "Set discord.token and
    discord.channelId in config.js, then restart the panel." The test button is hidden or disabled.

## Messages

```
🔄 Restarting **7R Op Server** for the operation.
✅ **7R Op Server** is back online (took 4m 12s).
⚠️ **7R Op Server** started but went offline again before coming online.
⚠️ **7R Op Server** has not come back online after 15 minutes.
⚠️ **7R Op Server** failed to restart: did not stop in time, not restarting.
```

Server name is the op server's `title`. Duration formatted `<m>m <s>s` (or `<s>s` under a minute).
Exactly one terminal message (online / went-offline / timed-out / failed) is posted per run.

### Detecting "back online" against the right process (revised after review)

The online-wait must not be armed at `run-started`: at that point the op server is still the *old*
process, still answering the 5s gamedig poll, so the next poll resolves a false "back online" before
the server is even stopped, and the removed listener means the real transition posts nothing. Op
mode therefore emits a third event, `run-restarted`, from its `done()` success path once the
replacement process has been spawned; the notifier arms `waitUntilOnline` only then, so it watches
the new instance. `waitUntilOnline` distinguishes its two failure modes (`reason: 'timeout'` vs
`reason: 'offline'` when the process exits during load) and returns a cancel handle, so an
overlapping run (op mode's `running` clears at spawn, not at joinable) supersedes the previous
wait instead of stacking a second `state` listener.

## Error handling

- A failed Discord POST (network, 4xx, 5xx) for the automatic notifications is logged with
  `console.error` and otherwise swallowed. It never sets `lastError` or any op mode banner: a Discord
  outage must not read as an op mode failure.
- The test-message route is the one place a Discord error is surfaced to a human, on demand.
- `waitUntilOnline` always resolves exactly once (online, early-exit, or timeout); its listeners are
  removed on resolution so a long-lived server cannot accumulate them across runs.
- The notifier tolerates `run-failed` arriving while an online wait is pending: the wait is
  cancelled and only the failure message is sent.

## Testing

Following the existing hand-rolled-fakes style (no mocking library; `should` + mocha):

- `test/lib/discord.js` (new): request shape (URL, method, three headers incl. exact
  `Authorization: Bot <token>` and a valid `User-Agent`), payload body, `isConfigured` truth table,
  disabled → no request + error callback, non-2xx → error callback with status/body, transport
  error → error callback. Uses an injected fake `request`.
- `test/lib/server.js` (extend): `waitUntilOnline` resolves on first truthy `state`; times out; fails
  early when `instance` goes null; removes its listeners on each outcome.
- `test/lib/op-mode-notifier.js` (new): message text for each of the four cases; duration formatting;
  silence when Discord not configured; only one terminal message per run; `run-failed` cancels a
  pending online wait. Uses a fake Discord (records `send` calls) and a fake server emitting `state`.
- `test/lib/op-mode.js` (extend): `run-started` is emitted before any server is stopped;
  `run-started` / `run-failed` payloads; guard-aborted runs emit neither.
- `test/routes/discord.js` (new): 400 when unconfigured, 200 on success, 502 on send error, via
  supertest against a route built with a fake Discord.
- `test/public/templates.js` already compiles every template; the new op-mode.html markup is covered
  by it automatically.

Timeout constants (`OpModeNotifier.defaultOnlineTimeoutMinutes`) are named module properties so tests can shorten
them, following `Server.stopTimeout` and `OpMode.tickMs`.

Run: `npm test`. Lint: `npx eslint app.js webpack.config.js config.js.example lib routes public/js test`
(the packaged `npm run lint` glob is broken under modern bash, per CLAUDE.md).

## Documentation deliverables

Matching how op mode itself shipped (code + operator doc + CLAUDE.md in one change):

- `docs/op-mode.md`: a "Discord notifications" section (what triggers a message, the four message
  types, that it is config.js-only and needs a panel restart, what the status row and test button
  mean, that "configured" is not "verified" without the test button).
- `README.md`: a `discord` row in the config table.
- `CLAUDE.md`: a short section noting the three-module split, the settings.js derived-boolean rule
  (never emit the token), the `waitUntilOnline` gamedig-state signal, and the app.js settings/servers
  emit-order dependency.

## Open decisions already made

1. "Run now" posts to Discord too (same `run()`, same effect on the fleet).
2. Duration measured from the "restarting" message, not from process spawn.
3. Online timeout defaults to 15 minutes and is operator-configurable via
   `discord.onlineTimeoutMinutes`; the warning message always names the value actually in force.
4. A failed Discord POST is console-only, never a panel banner.
5. No role ping; plain text.
6. Status row proves config is filled; a **Send test message** button turns that into real
   verification (catches 401/403/404) on demand.
