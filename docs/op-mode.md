# Op Mode

Op mode clears the decks for an operation. At a time you choose, the panel stops every server except
one, and restarts that one so the operation begins with clean process memory.

Open it from **Op Mode** in the top navigation.

## What it does

At the scheduled moment, in this order:

1. Every server **except** the op server is stopped. Anyone still connected to them is disconnected
   immediately, with no warning.
2. The op server is stopped and started again. If it was not running, it is simply started.

That is all it does.

## What it does not do

**It does not put anything back afterwards.** There is no "end of op" step. The other servers stay
down until something else starts them, which in our setup means their own `auto_start` setting plus
the nightly restart of the panel. If you need a server back sooner, start it yourself from the
dashboard.

**It does not warn players.** The panel has no RCon support, so there is no way to send an in-game
message before the shutdown. Tell people out of band.

## Setting the schedule

| Field | Meaning |
|---|---|
| **Enabled** | Untick to disarm the schedule entirely. The manual Run now button still works. |
| **Days** | Which days of the week it runs. Tick more than one if you have more than one op night. |
| **Time** | One time of day, applied to every day you ticked. |
| **Op server** | The server that gets restarted. Everything else gets stopped. |

Press **Save**. **Next run** then shows exactly when it will fire, so you can confirm you set it up
the way you meant to.

Enabling the schedule requires both a day and an op server. If either is missing, the save is
rejected rather than accepted into a state that looks armed but can never fire. Untick **Enabled**
if you want to park an incomplete schedule.

### Times are the panel host's clock

The time you enter, and the time shown under Next run, are the clock on the machine the panel runs
on, including summer time. The page names the host's timezone next to the Time field. They are
**not** your browser's timezone: if you are away and open the panel from another country, the times
on this page do not shift to match you.

Daylight saving is handled: an op set for 19:30 stays at 19:30 wall-clock across both the March and
October changes.

## Run now

**Run now** does exactly what the schedule does, immediately. It asks for confirmation first,
because it disconnects everyone on the other servers.

Use it to check your setup works without waiting for op night, or to run the sequence for an
unscheduled op.

Running it manually does **not** consume the scheduled run. If you press it at 19:00 and the
schedule says 19:30, the scheduled run still happens at 19:30.

## Things that can go wrong

### "The op server no longer exists"

A red banner, and op mode refuses to run.

A server's identity in this panel is derived from its title, so **renaming the op server breaks the
link**, and so does deleting it. The banner names the server it was pointing at.

Op mode deliberately refuses to run in this state rather than stopping everything and having nothing
to bring back up. **Fix it by picking the server again from the dropdown and pressing Save.**

The dropdown keeps the old entry listed as "(no longer exists)" and selected, so saving without
choosing a replacement leaves the setting as it was rather than silently blanking it.

If you rename the op server, expect to come back here and re-save.

### "The last op mode run failed"

A red banner naming what went wrong. The most likely cause is the op server refusing to stop within
the timeout, in which case it was deliberately **not** started again, to avoid a second copy running
on the same port.

Check the dashboard before assuming the op server is up.

### "The run scheduled for ... was skipped"

An amber banner. The panel was not running when the schedule came due, so the window passed
unnoticed.

Nothing was stopped. This is deliberate: firing a missed run late would mean a machine that resumed
from sleep at three in the morning killing every server at three in the morning. A run is only fired
if it is less than about 90 seconds late.

If you still want it, press **Run now**. The banner clears once a later run fires, or when you save
the schedule again.

### "The schedule could not be loaded and is not running"

A red banner. `op-mode.json` exists but could not be read or understood, so the schedule is not
armed. This should only happen if the file was hand-edited or the disk had a problem.

The banner shows the underlying reason. Filling in the form and pressing **Save** replaces the
unreadable file with what is on screen.

## Discord notifications

If you give the panel a Discord bot token and a channel id, it posts to that channel when op mode
runs:

- When a run starts: **Restarting <op server> for the operation.**
- When the op server is back online and joinable: **<op server> is back online (took Xm Ys).** The
  time is measured from the restart message, so it includes the few seconds spent stopping the
  other servers. "Joinable" means the panel's own status query answered, not just that the process
  started, so this is the point where people can actually log in.
- If the op server started but dropped out again before it finished loading (a bad modset or
  mission, for example): **<op server> started but went offline again before coming online.**
- If it simply never answers within the timeout (15 minutes by default, see below): **<op server>
  has not come back online after 15 minutes.**
- If the restart fails outright (for example the op server would not stop in time): **<op server>
  failed to restart: ...**

Exactly one of the last three (online, gave up, or failed) is posted per run. Both the scheduled run
and **Run now** post these messages.

### Turning it on

Add a `discord` block to `config.js` with a bot token and the target channel's id, then restart the
panel:

    discord: {
      token: 'your-bot-token',
      channelId: '123456789012345678',
      onlineTimeoutMinutes: 15,
    },

The bot must be a member of the server and have permission to send messages in that channel. It does
not need to appear online; it will show as offline in the member list, which is normal for a
notify-only bot.

`onlineTimeoutMinutes` is how long the panel waits for the op server to come back before it posts the
"has not come back online" warning. It is optional and defaults to 15 minutes; the warning always
names whatever value is in force. Set it higher for a heavy modset that takes longer to load. If you
leave it out, or set it to something that is not a positive number, it falls back to 15.

Leave the token or channel id blank to turn notifications off.

### The Discord row on the Op Mode page

The page shows whether notifications are configured. When they are, a **Send test message** button
posts a real message to the channel so you can confirm the token, channel id and permissions are
right. If the token is wrong, the channel id is wrong, or the bot lacks permission, the test tells
you straight away rather than you finding out on op night. "Configured" on its own only means the
two fields are filled in; the test button is what proves it actually works.

Changing the token or channel means editing `config.js` and restarting the panel, the same as the
rest of that file.

## Where the settings live

`op-mode.json`, next to `servers.json` in the panel's working directory. You should not need to edit
it by hand, but it is plain JSON if you ever have to.
