# Driving a browser on another machine

`browse --remote <sshhost>` runs the browser, the recording and ffmpeg on
another machine and copies the artifacts back. Reach for it when the browser is
the thing you cannot afford locally: RAM, CPU, battery, or a laptop already
running several agents. `browse help` has the flag and its env vars.

Everything else is unchanged. Same commands, same output, same loop, and the
paths it prints are local files, because each reply's artifacts are copied down
as it names them.

## The one thing that changes: what `127.0.0.1` means

`browse open` (and every relative URL) resolves on the REMOTE machine. A dev
server on your laptop does not exist to it. Either run the app on that machine
too, which is usually the point since a dev server is the other thing eating
your RAM, or lend it yours with `ssh -R 3000:127.0.0.1:3000 <sshhost>` and keep
that connection open for the whole session.

Start the server there and confirm it listens *before* the first `browse`
command, exactly as you would locally: recording starts the moment the browser
spawns, and pointing it at a dead port records the failure.

## What to expect

- **The first command on a cold machine is slow** (minutes): it installs
  Playwright and a browser. Later ones cost one network round trip on top of the
  action, which is not noticeable against a page load.
- **The engine will usually be chromium.** Camoufox is rarely installed on a
  server, and browse falls back and says so. If the site has a bot wall, that
  matters, see `engines.md`.
- **The mp4 only comes back on `close`.** Kill the session without closing and
  the recording stays on the remote (browse tells you where). Close it properly.
- **`--remote` goes on every command**, `close` included. Export `BROWSE_REMOTE`
  once and stay in that shell.
- Commands that read the remote's disk, `profiles`, `clear` and `setup`, run
  over there, because that is the machine they are about. `net` still answers
  here: it copies the session's request log down first.
- **`BROWSE_OUT` is the one knob that does nothing here.** The browser writes on
  the remote and the copies land in a mirror dir; take the artifact paths from
  `close` and `dir` rather than choosing them. Every other browser-side env var
  reaches the remote daemon, so a flag and its env twin still agree.

## Upstash Box: a machine that exists only for this session

`browse-box` makes the remote side disposable. `up` restores a pre-baked image
into a fresh box in about 13 seconds, `down` deletes it, and nothing of the
user's runs in between. Prefer it over a standing server: the laptop keeps its
RAM and there is nothing to clean up or pay for afterwards.

`browse-box help` is the command surface and ends with the whole session, both
CLIs interleaved. Read it before the first command. One credential covers both
halves, browse hands the same Box API key to the box's ssh as its password, and
`browse-box key` saves it. If there is no key yet, the README's setup section is
two lines and the error message names them too.

What a box changes on top of `--remote`:

- **The app must run on the box.** That is the point, and `127.0.0.1` is the
  box's. Confirm the server listens *there* before the first `browse` command.
- **`browse-box exec`, never `ssh`.** A box's ssh gateway throws away stdout and
  the exit status, and kills whatever the command left running, so a
  backgrounded dev server dies the moment ssh returns. `exec` goes through the
  box's API and does none of that. This is also why `profiles`, `clear` and
  `setup` come back empty over `--remote` on a box: browse refuses and names the
  `exec` form instead.
- **Keep everything under `/workspace/home`**, the box user's half of the
  volume, and where `push` and the provisioning both default.
- **Always `down`.** Boxes from `up` expire on their own (`--ttl`, 8h), but that
  is a backstop for a crashed session, not the ending.
- **Never create a keep-alive box.** They bill a flat monthly rate whether used
  or not, the opposite of what this is for. A box that ran and was deleted costs
  CPU seconds; the only standing cost is the image (~0.6GB, cents a month).

**Why `up` is fast: the image.** Installing browse on a bare box takes ~6
minutes, Chromium alone is ~1GB. `browse-box image` does that once and snapshots
the result, and a snapshot restores the whole disk, so the apt packages and
`/usr/local/bin/browse` come back with it, not just `/workspace`. It outlives
the box it came from, so the image is the only thing kept. Re-run `image` after
a browse update; a fresh box where `browse` is missing means the image is stale.

**Handing over something clickable.** `browse-box url` gives a port a public
`https://…preview.box.upstash.com` URL, worth offering alongside the video when
the user will want to poke at the app themselves. The proxy reaches the
container from outside, so it only answers if the server is bound to `0.0.0.0`;
a dev server on `127.0.0.1` records perfectly and 502s on the link. Start it
with `--host 0.0.0.0` when you plan to share one, and say plainly that the link
dies with the box.

**When `browse` fails with an ssh error**, the box is usually gone, deleted or
expired. `browse-box ls` says. The recording went with it and there is nothing
to recover, so start over rather than hunting.

## Before you point it at a shared machine

To be reachable through the tunnel from outside a container, the daemon binds
`0.0.0.0` on the remote. Anything that can route to that machine can then drive
your browser and read the session's recordings. That is fine for a box (its
network is its own) and fine for a VPS only you reach. On anything shared, set
`BROWSE_BIND` yourself, and remember a live session holds real logins if you
used `-p`.
