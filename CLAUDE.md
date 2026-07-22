# arma-server-web-admin

A web panel for running Arma dedicated servers. This is `Ionaru/arma-server-web-admin`, a fork of
`Dahlgren/arma-server-web-admin`, used by the 7R unit to run several Arma 3 servers on a Windows
box.

This file is the orientation a new contributor (human or agent) needs before changing anything. It
documents the traps as much as the design, because several of them are not visible from the code
you happen to be editing.

## Stack and vintage

The project is old and deliberately not modernised. Expect ES5-style `var` and prototype methods.

| Piece | What it is |
|---|---|
| Runtime | Node. `.travis.yml` targets Node 12; there is no `engines` field. It runs fine on modern Node. |
| Server | Express 4, socket.io 1 |
| Frontend | Backbone 1.3.3 + Marionette 2.4.7, Bootstrap 3, jQuery 3 |
| Bundling | webpack 1, compiled **in memory** by `webpack-dev-middleware` (`app.js`) |
| Process launcher | the `arma-server` package (0.0.7) actually spawns the game |
| Status polling | `gamedig`, every 5s per running server |
| Tests | mocha 3, `should`, `supertest`, `timekeeper` |

**There is no build step.** `npm start` is the whole story; webpack compiles the bundle on request.

Getting a fresh clone running:

```bash
npm install
cp config.js.example config.js     # then point `path` at an Arma install
npm start                          # http://localhost:3000
```

`config.js`, `servers.json` and `op-mode.json` are all gitignored, so a fresh clone has none of them.

## Boot sequence

`app.js` in order: basic auth → body parser → morgan → static files → `Manager.load()` (which
auto-starts servers) → `Mods.updateMods()` → mount routers → socket.io connection handler →
`server.listen`, but only when `require.main === module` so tests can import the app.

## Persistence: there is no database

Everything lives in JSON files written with `fs.writeFile`, relative to `process.cwd()`:

- `servers.json` — server definitions, written by `Manager.save` (`lib/manager.js`)
- `op-mode.json` — the op mode schedule, written by `OpMode.save` (`lib/op-mode.js`)

**Trap: adding one field to a server means editing six places.** `Manager.save` uses a
hand-maintained whitelist, so a field missing from it silently vanishes on restart, which looks like
a UI bug rather than a persistence bug.

1. `Server.prototype.update` — `lib/server.js`
2. `Server.prototype.toJSON` — `lib/server.js`
3. the whitelist in `Manager.prototype.save` — `lib/manager.js`
4. `defaults` in `public/js/app/models/server.js`
5. `serialize()` in `public/js/app/views/servers/form.js`
6. the input in `public/js/tpl/servers/form.html`

**Trap: paths are relative to the working directory,** not to `__dirname`. This matters for the
`winser` Windows service install, where the working directory is not obvious.

## Server identity is derived from the title

`Server.prototype.generateId()` is `slugify(this.title).replace(/\./g, '-')`, called from
`update()`. The title is editable in the UI. Therefore:

- **Renaming a server changes its id.** That invalidates `#servers/<slug>` links, orphans the
  generated `.cfg`, and breaks anything holding a reference to it.
- **Two titles that slugify identically collapse.** `serversHash` is keyed on the slug, so one
  entry wins while both servers remain in `serversArr`.

This is why op mode can only *detect and warn* when its configured server disappears, rather than
following it. The correct fix is a persisted, title-independent id: assign it once in the `Server`
constructor and add it to the `Manager.save` whitelist so it round-trips. That was consciously
deferred, not overlooked. If you touch anything that stores a server reference, read this section
first.

## `config.js` is required twice

`app.js` requires it and injects it into constructors, but `lib/server.js` **also** requires it
directly. So within `lib/server.js`, `config.additionalConfigurationOptions`, `config.admins`,
`config.game`, `config.parameters`, `config.prefix`, `config.serverMods` and `config.suffix` come
from the module-level require, while `this.config.path` and `this.config.type` come from the
injected copy. Upstream started untangling
this (commit `3c56bba`); this fork has not taken it. Do not assume the two are the same object.

## `lib/settings.js` is not a settings store

It is an eleven-line read-only `_.pick` over `config.js`. The route is GET-only and the UI renders
every field `disabled`. Op mode deliberately did **not** extend it: op mode needs mutable,
persisted, UI-editable state, and bolting that onto a read-only projection of a static file would
have made both jobs worse. It has its own module and its own file instead.

## Transport is hybrid

- **socket.io pushes reads.** Events: `missions`, `mods`, `op-mode`, `servers`, `settings`. All five
  are emitted on connection, but only the first four are re-emitted on change: `settings` is a
  read-only projection of `config.js`, which never changes at runtime, so nothing re-emits it.
- **REST handles writes**, under `/api/*`.

`Backbone.history.start()` is deliberately deferred until the first `servers` event arrives
(`public/js/app/router.js`), so nothing renders before there is data.

## EventEmitter: use util.inherits

`lib/server.js`, `lib/manager.js`, `lib/missions.js` and `lib/mods.js` used to do:

```js
Server.prototype = new events.EventEmitter();   // WRONG, do not reintroduce
```

That gives every instance the **same** `_events` object. `Manager` registers one `'state'` listener
per server, so one server's `emit('state')` ran every other server's listener: with N servers a
single state change produced N socket broadcasts, and op mode stopping N-1 servers at once made it
N². Past ten servers it also tripped `MaxListenersExceededWarning`.

The correct pattern, now used in all four:

```js
var Thing = function () {
    events.EventEmitter.call(this);
    // ...
};

util.inherits(Thing, events.EventEmitter);
```

`util.inherits` mutates the existing prototype rather than replacing it, so `Thing.prototype.method`
assignments can appear before or after it.

## Windows vs Linux

Driven by `config.type` (`linux` / `windows` / `wine`), passed to `arma-server` as `platform`.

- **Log capture only happens on Linux** (`lib/server.js`): stdout/stderr are piped to a file. On
  Windows the game writes its own logs, so nothing is captured.
- `Logs.logsPath()` differs per platform (`lib/logs.js`).
- Per the README, Windows Error Reporting must be disabled, or server control gets stuck on a crash
  because the dead process never exits.

## Op mode

Stops every server except a designated op server and restarts that one, on a weekly schedule, so an
operation starts with clean process memory. See `docs/op-mode.md` for the operator-facing guide.

- `lib/op-schedule.js` — pure date helpers, no I/O or state
- `lib/op-mode.js` — config persistence, the schedule tick, the run sequence
- `routes/op-mode.js`, `public/js/app/views/op-mode.js`, `public/js/tpl/op-mode.html`

Rules to preserve if you touch it:

1. **Never do day or week arithmetic in milliseconds.** Adding `7 * 24 * 60 * 60 * 1000` is off by
   exactly one hour across both Europe/Amsterdam DST transitions, so a 19:30 op would fire at 18:30
   or 20:30 twice a year. Go through `occurrenceOn()`, which builds a Date from local wall-clock
   fields. `test/lib/op-schedule.js` has regression tests for both transitions in both directions.
   They assert on `getHours()`, not on the epoch, because an epoch assertion would be tautological,
   and each case deliberately crosses a boundary: a case that stays on one side of a transition
   passes with millisecond arithmetic and proves nothing.
2. **Every reason to abort a run is checked before anything is stopped.** Never shut the fleet down
   and then discover there is nothing to bring back up.
3. **A window is consumed only if it is strictly newer than `lastWindow`.** An inequality test
   instead lets a backward clock step rewrite `lastWindow` to the previous week and fire the same
   window twice, killing the op server mid-operation. The deliberate cost is that a clock pulled
   backwards leaves a future-dated `lastWindow` that suppresses firing until the schedule passes it;
   that is fail-closed and is the right trade here.
4. **Writes are serialised** (`save()` queues behind an in-flight `writeNow()`). Two overlapping
   writes race on the shared `.tmp` path: one rename wins, the other fails ENOENT, and the operator
   sees a successful save reported as an error.

`opMode.load()` is called only under `require.main === module`, because the test suite requires
`app.js` and a tick firing from a test run would stop every server on the box. Note that
`setConfig()` also arms the ticker, unconditionally: in the running panel that only happens via
`PUT /api/op-mode`, which does not exist unless the app is serving, but a test constructing an
`OpMode` directly and calling `setConfig` does start a real interval and should call `stopTicker()`
afterwards (`test/lib/op-mode.js` does this in `afterEach`).

Note the related pre-existing hazard: `manager.load()` is **not** gated that way, so requiring
`app.js` does auto-start servers with `auto_start` set. Be careful running the test suite on the
production box.

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

## Testing and linting

```bash
npm test     # mocha --recursive
```

Time-dependent tests use `timekeeper` (`tk.freeze` / `tk.reset`); see `test/lib/logs.js`. The op
mode tests pin `process.env.TZ = 'Europe/Amsterdam'` so the DST cases mean the same thing on any
developer's machine.

`npm run lint` is `eslint */**/*.js webpack.config.js config.js.example`. **This is broken with
modern shells and npm:** bash expands `*/**/*.js` to include roughly 1250 files under
`node_modules`, and eslint then chokes on a nested `.eslintrc` in a dependency. Lint the project
directly instead:

```bash
npx eslint app.js webpack.config.js config.js.example lib routes public/js test
```

## Relationship to upstream

77 commits behind `Dahlgren/arma-server-web-admin` (upstream's last commit is 2025-07-12) and
deliberately not synced. Upstream has: CDLC support (Western Sahara, Spearhead 1944, Reaction
Forces, Expeditionary Forces, CSLA, GM/VN mod folders), a Dockerfile, mods list/filter UI work, log
handling improvements, GitHub Actions, and dependency bumps. Open upstream branches include
`base-url`, `battleye-rcon`, `reforger`, `react`, `steam-workshop-mods` and `virtual-server-folder`.

There is no scheduler, cron or automation concept anywhere upstream, which is why op mode was built
here rather than pulled in.

Intentional local divergence in this fork:

- Delete and Clone buttons are commented out in the templates (`734d3d1`, "Disable dangerous
  buttons"). They are commented rather than removed on purpose; leave them that way.
- Custom difficulty is the default (`bd917e9`)
- Mods in subfolders (`295fa29`)
- The panel uses the full screen width (`2d9b8fa`)
