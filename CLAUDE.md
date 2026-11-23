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
| Runtime | Node. Production runs Node 26. `engines` in `package.json` is `^20.19.0 || ^22.13.0 || >=24` (the eslint 10 and mocha 12 floor). CI runs Node 26 on GitHub Actions (`.github/workflows/ci.yml`). |
| Package manager | pnpm 12 (needs Node >= 18), pinned by `packageManager` in `package.json`; see *Dependencies: pnpm* |
| Server | Express 5, socket.io 4 |
| Frontend | Backbone 1.3.3 + Marionette 2.4.7, Bootstrap 3, jQuery 3 |
| Bundling | webpack 1, compiled **in memory** by `webpack-dev-middleware` (`app.js`) |
| Process launcher | the `arma-server` package (0.0.10) actually spawns the game |
| Status polling | `gamedig`, every 5s per running server |
| Tests | mocha 12, `should`, supertest 7, timekeeper 2; a Playwright smoke run of the real UI (`smoke/`) |

**There is no build step.** `pnpm start` is the whole story; webpack compiles the bundle on request.

Getting a fresh clone running:

```bash
npm install -g pnpm                # once per machine
pnpm install
cp config.js.example config.js     # then point `path` at an Arma install
pnpm start                         # http://localhost:3000
```

`config.js`, `servers.json` and `op-mode.json` are all gitignored, so a fresh clone has none of them.

## Dependencies: pnpm

The lockfile is `pnpm-lock.yaml`. There is no `package-lock.json`: `npm install` would ignore the
lock, resolve afresh and write one, so don't use npm for installs.

- **The pnpm pin carries a hash.** `packageManager` is `pnpm@<version>+sha512.<hash>`, and Corepack
  refuses a download that doesn't match it. Change it with `corepack use pnpm@<version>`, not by
  editing the version: Corepack ships with Node 24 and older; on Node 25+ install it first with
  `npm install -g corepack`.
- **Settings live in `pnpm-workspace.yaml`.** pnpm 11+ ignores the `pnpm` field of `package.json`
  and reads only auth and registry settings from `.npmrc`. The file has no `packages:` field; the
  repo is a single package.
- **Dependency install scripts are blocked.** pnpm 12 fails the install on any dependency with an
  install script that `allowBuilds` doesn't list. The only one is `fsevents` (macOS only, from
  webpack 1's watcher), set to `false`: chokidar falls back to `fs.watch` without it.
- **The layout is strict.** A package can only require what it declares. Every bare `require()` in
  `app.js`, `lib`, `routes`, `public/js`, `test`, `smoke` and `scripts` is declared in
  `package.json`; keep it that way. The `json-loader` rule in `webpack.config.js` names a loader
  that isn't installed (it wasn't under npm either); it is harmless only because nothing in the
  bundle requires a `.json` file.
- **webpack 1 follows pnpm's symlinks** to their real paths under `node_modules/.pnpm`, so the
  bundle holds one copy each of jQuery and Backbone. Marionette 2.4.7 still gets its own underscore
  1.8.3, as it did under npm.
- **Fresh releases wait a day.** pnpm 12's `minimumReleaseAge` defaults to 1440 minutes, so a
  version published in the last 24 hours may not be picked.
- **Switching an existing npm install** (the production box): stop the service and delete
  `node_modules` first. pnpm installs over an npm-made `node_modules` without complaint but leaves
  npm's hoisted packages in place. The README lists the steps.
- **A Windows service installed under pnpm points into the virtual store.** pnpm's bin shim runs
  winser from its real path and winser locates `nssm64.exe` from `__dirname`, so the service binary
  is `node_modules\.pnpm\winser@1.0.3\node_modules\winser\bin\nssm64.exe`. Changing winser's version
  removes that folder: uninstall and reinstall the service afterwards. A service installed under npm
  points at `node_modules\winser\bin`, which pnpm recreates as a junction.

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

- **Log capture only happens on Linux** (`lib/server.js`): stdout/stderr of the server and of each
  headless client are piped to `<path>/logs/arma3server_<time>_<server id>.log` and
  `..._<server id>_HC_<n>.log`; the id keeps servers started in the same second (`Manager.load()`
  auto-start) out of each other's file. The Linux game writes no `.rpt` and ignores `-profiles`. On Windows the game writes its own `.rpt`, so
  nothing is captured.
- `Logs.logsPath()` (the default log folder) differs per platform (`lib/logs.js`). It is only one of
  the folders the log view lists; see *Logs and headless clients*.
- arma-server 0.0.10 starts the dedicated server with its working directory set to `config.path` on
  every platform (headless clients only on Linux).
- Per the README, Windows Error Reporting must be disabled, or server control gets stuck on a crash
  because the dead process never exits.

## Logs and headless clients

Arma names its `.rpt` `<exe>_<date>_<time to the second>.rpt` in the `-profiles` folder (default
`%LOCALAPPDATA%\Arma 3`). A server and its headless clients run the same exe, so two of them started
in the same second with the same profiles folder write the same file and one log is lost. That
happened in production: the dedicated server's log was gone and only a headless client's survived.

- **Headless clients start staggered** (`Server.headlessClientStartDelay`, 5 s after the server, then
  `Server.headlessClientStartInterval`, 2 s apart). Pending starts are timers that
  `stopHeadlessClients()` cancels when the server process closes, and `stop()` cancels before it
  kills (the timer's instance check still passes while the process exits or hangs). Do not go back
  to spawning them in the `start()` loop.
- **A headless client's options are captured when its start is scheduled** (`headlessClientOptions`),
  not when it spawns: `PUT /api/servers/:id` updates the running server, and a port, password or mod
  change saved in the first seconds must not reach headless clients of the process already running.
- **Each headless client gets its own profiles folder.** `getHeadlessClientParameters(i)` strips any
  inherited `-profiles=` and adds `-profiles=<server profiles>\HC_<i>`, which also stops the shared
  `DataCache` lock wait. Without a server `-profiles` the parameters pass through and only the stagger
  protects the log. `-name` is deliberately left alone (it is the in-game identity).
- **`lib/profiles.js` is string-only on purpose.** It parses Windows paths on a Linux host (tests,
  wine), so it must not use `path`. The last `-profiles=` wins, names match case-insensitively, and
  quotes are stripped.
- **The log view lists several folders** (`Logs.prototype.logDirectories`): each server's profiles
  folder plus its `HC_<n>` subfolders, and the default folder when a server has no `-profiles`
  (always on Linux and wine). Relative `-profiles` paths resolve against `config.path`, as Arma
  resolves them from its install folder. On wine, drive paths such as `C:\Arma\P` are mapped through
  `~/.wine/dosdevices/<drive>:`, since the host's `path.resolve` would treat them as relative names.
- **Profile folders only show `.rpt`, `.log`, `.mdmp` and `.bidmp`.** Operators keep config files
  (with passwords) in them, and the log view can download and delete. Do not widen the filter.
- **Logs are addressed by `id`** (a hash of the path plus the name), never by bare name, because two
  folders can hold the same name. `getLogFile` only resolves ids from the current listing, which is
  also what stops path traversal; keep every read, download and delete going through it.
- The Source column's role comes from the `HC_<n>` folder, else the `-client` argument in the first
  10 lines of an `.rpt` (read up to 64 KB: `arma-server` puts `-client` after the whole `-mod=` list,
  which can run past 5 KB), else the `_HC_<n>.log` suffix of a Linux capture.

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
`lib/op-mode.js` only gained three `emit()` calls (`run-started`, `run-restarted`, `run-failed`) and
no new state:

- `lib/discord.js` posts one HTTPS POST to the Discord REST API (`POST /api/v10/channels/:id/messages`,
  built-in `https`, no dependency). Discord **requires** a `User-Agent: DiscordBot (url, version)`
  header or Cloudflare blocks the request. `send()` also sets `allowed_mentions: {parse: []}` (the
  op server title is operator-editable and interpolated in, so an `@everyone` in a title must not
  ping) and truncates to 2000 chars. `Discord.isConfigured(config)` is the single source of truth
  for "is Discord on".
- `lib/op-mode-notifier.js` subscribes to the op mode events and decides the message text. It owns
  the only new state: the in-flight run and its online-wait, plus a cancel handle so an overlapping
  run supersedes rather than stacks.
- `Server.prototype.waitUntilOnline` resolves off the gamedig `state` poll, because `restart()`'s
  callback fires at process spawn, minutes before the game is joinable. That is what the "back
  online, took X" timing is measured against.

Three traps:

1. The token lives in `config.js`. `lib/settings.js` exposes only a derived boolean
   `discordEnabled`, never `config.discord`, because `getPublicSettings()` is broadcast over
   socket.io to every browser. If you add fields to the public settings, keep the token out.
2. `app.js` emits `settings` before `servers` on socket connection on purpose: `router.js` starts
   `Backbone.history` from inside the `servers` handler, so the Op Mode page's Discord row needs
   `settings` to have arrived before the first render. The frontend also listens for
   `change:discordEnabled`, so the order is a belt-and-braces, not the sole guarantee.
3. The online-wait is armed on `run-restarted` (emitted once the *replacement* process is spawned),
   never on `run-started`. At `run-started` the op server is still the old process and still
   answering gamedig every 5s, so a wait armed there resolves a false "back online" before anything
   is even stopped. This was the shipped-then-fixed bug; do not move the wait back to `run-started`.

## Testing and linting

```bash
pnpm test    # plain mocha, configured by .mocharc.yml
```

`.mocharc.yml` sets `recursive: true` (the spec defaults to `./test`) and `exit: true`. Mocha 4+ no
longer force-exits, and the app and its tests leave handles open, so without `exit` the process
lingers after the summary. Measured with `mocha --no-exit` it still ended by itself a few seconds
later, but `exit: true` stays so a leaked handle can never hang a run or CI.

`pnpm test` requires `app.js`, so it needs a `config.js` whose `path` exists: with `config.js.example`
copied unchanged, `mods.updateMods()` throws on the missing folder before any test runs. Point `path`
at any empty folder.

### Smoke run and bundle check

There are no frontend unit tests. Before and after any change that touches the frontend, the bundle
or the transport, run:

```bash
pnpm run check-bundle  # one webpack compile into a temp dir; exits 1 on a compile error
pnpm run smoke         # starts the real app and clicks through every page in headless Chromium
```

- First time only: `pnpm exec playwright install --only-shell chromium`.
- `smoke/run.js` builds a throwaway environment under the OS temp dir (a fake Arma folder with one
  mission, one mod and one log, `servers.json` with one server that has `auto_start: false`, and op
  mode disabled), starts `app.js` there on a free port, and visits the dashboard, every server tab,
  missions, mods, logs and op mode, plus the Add server and Settings modals and the op mode Run now
  confirm (cancelled, never confirmed).
- It fails on any console error, page error, app response >= 400 or failed script, stylesheet or
  font load, and on a missing DOM marker, including the Glyphicons font actually loading. There is
  no allowlist on purpose: fix the cause instead of filtering the message.
- The config cannot be swapped by changing the working directory: `app.js` and `lib/server.js`
  resolve `config.js` against the repo. `smoke/config-shim.js` (loaded with `node --require`)
  redirects both requires to the temp config, so a developer's real `config.js` is never read or
  touched.
- `SMOKE_SCREENSHOTS=<dir>` saves a PNG per page, tab and dialog at desktop width and per page at
  375 px, for before/after comparison. `SMOKE_KEEP=1` keeps the temp folder; it is always kept, and
  its path printed, when the run fails.
- `smoke/` is outside `test/` so mocha does not pick it up.

Time-dependent tests use `timekeeper` (`tk.freeze` / `tk.reset`); see `test/lib/logs.js`. The op
mode tests pin `process.env.TZ = 'Europe/Amsterdam'` so the DST cases mean the same thing on any
developer's machine.

`pnpm run lint` is `eslint .`, using the flat config in `eslint.config.js` (eslint 10,
`@eslint/js` recommended plus `no-unused-vars: off` and `semi: always`). Three blocks: Node files
(`lib`, `routes`, `scripts`, `smoke`, the root scripts and `config.js.example`, which has no `.js`
extension and is matched by name), `test/` (adds the mocha globals), and `public/js` (`ecmaVersion`
2015 because webpack 1 bundles it, browser globals plus the `ProvidePlugin` globals `_`, `$`,
`Backbone` and `jQuery`). `no-undef` is on everywhere, so a stray global fails the lint.

### CI

`.github/workflows/ci.yml` runs on pushes to `master` and on pull requests. `pnpm/setup` installs
pnpm (the `packageManager` version), Node 26 and the dependencies (`require-lockfile: true`, so the
install is frozen); then it runs `pnpm run lint`, `pnpm test` and `pnpm run check-bundle`. It writes its own
`config.js` from `config.js.example` with `path` pointed at an empty folder, since an unchanged copy
crashes the tests (see above). The smoke run is not part of CI.

Actions are pinned to a full commit SHA with the release tag in a trailing comment
(`uses: owner/action@<40-hex sha> # vX.Y.Z`), as GitHub recommends: a tag can be moved, a SHA
cannot. To bump one, resolve the new tag's commit (`git ls-remote https://github.com/<owner>/<action>
'refs/tags/vX.Y.Z^{}'`, or `refs/tags/vX.Y.Z` for a lightweight tag) and update both.

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
