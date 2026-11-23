# Arma Server Admin

[![CI](https://github.com/Ionaru/arma-server-web-admin/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/Ionaru/arma-server-web-admin/actions/workflows/ci.yml)

A simple to use web admin panel for Arma servers.

[Screenshots](http://imgur.com/a/Xod6U)

## Features

- Create multiple instances of game servers in the same admin panel
- See server status queryed from the instances with current mission and players
- Download game logs
- Upload missions from your local computer to the server
- Download and update mods from withSIX
- Op mode: on a weekly schedule, stop every server except the one hosting an operation and restart
  that one, so it starts the op with clean memory. See [docs/op-mode.md](docs/op-mode.md)

## Requirements

- Node.js 20.19 or newer, 22.13 or newer, or 24 and up (the 21 and 23 lines are not supported). The panel runs on Node 26 in production. https://nodejs.org/
- Pre-installed Arma Server

## Supported Platforms

- Windows
- Linux
- Linux with Windows binary using Wine

## Supported Games

- arma1
- arma2
- arma2oa
- arma3
- arma3_x64
- cwa (does not support linux)
- ofp
- ofpresistance

## Config

Key | Description
--- | ---
game | Which game server to launch, see above
path | Folder path to game server
port | Web port to use
host | IP or Hostname to listen on
type | Which kind of server to use, can be 'linux', 'windows' or 'wine'
additionalConfigurationOptions | Additional configuration options appended to server.cfg file
parameters | Extra startup parameters added to servers and headless clients (a `-profiles` folder is given a subfolder per headless client, see [Logs and headless clients](#logs-and-headless-clients))
serverMods | Mods that always and only will be used by the game servers
auth | If both username and password is set, HTTP Basic Auth will be used
allowedOrigins | Extra origins (`scheme://host[:port]`) allowed to send state-changing requests and open the socket. Only needed when a plain-HTTP reverse proxy rewrites the Host header
prefix | Text prepended to all game servers name
suffix | Text appended to all game servers name
discord | Optional `{ token, channelId, onlineTimeoutMinutes }`. When token and channelId are set, op mode restarts are announced in that Discord channel. onlineTimeoutMinutes (default 15) is how long to wait for the op server before warning

## How to Use

1. Copy `config.js.example` to `config.js`

2. Change values in `config.js` as described above or in the file

3. Install [pnpm](https://pnpm.io/installation) once with `npm install -g pnpm`, then install all
   dependencies with `pnpm install`

   Switching an existing install from npm to pnpm (do this outside an operation: stopping the panel
   can also stop the game servers it started):
   1. Check `node --version` is within the supported range listed under Requirements.
   2. Stop the panel, or its Windows Service.
   3. Delete the `node_modules` folder. pnpm does not remove the packages npm left there.
   4. Run `pnpm install`.
   5. Start the panel again, or start the existing Windows Service (for example
      `net start arma-server-web-admin`). Don't run `install-windows-service` again: the service is
      already registered, so the command fails. The existing service keeps working because
      `pnpm install` recreates `node_modules\winser`.

4. Launch the web UI with `pnpm start` or install as a Windows Service with `pnpm run install-windows-service`

## Logs and headless clients

Arma names its `.rpt` log after the executable and its start time, to the second. A server and its
headless clients run the same executable, so two of them started in the same second in the same
profile folder write the same log file, and one of the logs is lost. To keep them apart:

- Headless clients start 5 seconds after their server, and 2 seconds apart from each other.
- When a server's parameters include `-profiles=<folder>`, each headless client is started with
  `-profiles=<folder>\HC_<n>` instead, so its log, cache and profile files stay out of the server's
  folder.
- The Logs page lists each server's `-profiles` folder (`.rpt`, `.log`, `.mdmp` and `.bidmp` files
  only) and its `HC_<n>` subfolders, plus the default log folder for servers without `-profiles`.
  The Source column shows which server each file belongs to and whether it is the server's log or a
  headless client's.
- On Linux, each headless client's output is also saved in the logs folder as
  `arma3server_<time>_<server id>_HC_<n>.log`, next to the server's own
  `arma3server_<time>_<server id>.log`.

## System Configuration

### Windows

Make sure to disable Windows Error Reporting or server control will be stuck on a server crash.

Install as a Windows Service with `pnpm run install-windows-service`.

Remove previously installed Windows Service with `pnpm run uninstall-windows-service`.

### Wine

Make sure to disable Wine GUI Crash Dialog or server control will be stuck on a server crash.
This is easiest solved using `winetricks` by running `winetricks nocrashdialog`.
It can also be disabled manually.
[Read more at Wine FAQ](http://wiki.winehq.org/FAQ#head-c857c433cf9fc1dcd90b8369ef75c325483c91d6).
