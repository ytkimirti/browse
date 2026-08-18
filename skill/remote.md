# Driving a browser on another machine

`browse --remote <sshhost>` runs the browser, the recording and ffmpeg on
another machine and copies the artifacts back. Reach for it when the browser is
the thing you cannot afford locally: RAM, CPU, battery, or a laptop already
running several agents. `browse help` has the flag and its env vars.

Everything else is unchanged. Same commands, same output, same loop — the paths
it prints are local files, because each reply's artifacts are copied down as it
names them.

## The one thing that changes: what `127.0.0.1` means

`browse open` (and every relative URL) resolves on the REMOTE machine. A dev
server on your laptop does not exist to it. Either run the app on that machine
too — which is usually the point, since a dev server is the other thing eating
your RAM — or lend it yours with `ssh -R 3000:127.0.0.1:3000 <sshhost>` and keep
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
  matters — see `skill/engines.md`.
- **The mp4 only comes back on `close`.** Kill the session without closing and
  the recording stays on the remote (browse tells you where). Close it properly.
- Commands that read the remote's disk — `profiles`, `clear`, `setup` — run over
  there, because that is the machine they are about. `net` still answers here: it
  copies the session's request log down first.

## Upstash Box

`node scripts/box.mjs create` provisions one end to end and prints the exact
`--remote` destination; `install <box-id>` does it to a box you already have. It
needs `UPSTASH_BOX_API_KEY`, which is also what browse hands the box's ssh as its
password, so there is nothing further to configure.

Two box behaviours worth knowing before they confuse you:

- **Its ssh relays no output back.** A command runs on the box and returns
  nothing, not even an exit status. browse works around this where it can (it
  proves the daemon started by asking it, not by trusting ssh) and says so where
  it cannot: `browse --remote <box> profiles` will tell you to read the answer
  from an interactive `ssh` session instead of printing an empty list. The
  commands you actually run in the loop are unaffected — they go over the tunnel,
  not over ssh's stdout.
- **A paused box loses its public URLs and its running processes.** Use a
  keep-alive box for anything you want to come back to, and keep the work under
  `/workspace/home` (the writable half of the volume that survives a restart —
  `/workspace` itself is root-owned). Chromium alone is ~1GB, which is why
  `scripts/box.mjs` points Playwright's cache there and asks for a medium box.

## Before you point it at a shared machine

To be reachable through the tunnel from outside a container, the daemon binds
`0.0.0.0` on the remote. Anything that can route to that machine can then drive
your browser and read the session's recordings. That is fine for a box (its
network is its own) and fine for a VPS only you reach. On anything shared, set
`BROWSE_BIND` yourself — and remember a live session holds real logins if you
used `-p`.
