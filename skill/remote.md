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
  matters, see `skill/engines.md`.
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

`browse box` makes the remote side disposable: a fresh box from a pre-baked
image, deleted when you are done, nothing of the user's running in between.
Prefer it over a standing server. `browse box help` is the command surface and
ends with a whole session, both halves interleaved; read it before the first
command. One credential covers browse and the box's ssh both, and `browse box
key` prompts for it.

What a box changes on top of `--remote`:

- **The app runs on the box**, and `127.0.0.1` is the box's. Confirm the server
  is listening *there* with `browse box exec <box> 'curl -sf http://127.0.0.1:<port>'`
  before the first `browse` command, because recording starts the moment the
  browser spawns.
- **`browse box exec`, never `ssh`.** A box's ssh gateway drops the output and
  the exit status and kills whatever the command left running, so an
  `ssh box 'npm run dev &'` dev server dies the moment ssh returns. This is also
  why `profiles`, `clear` and `setup` come back empty over `--remote` on a box:
  browse refuses and names the `exec` form instead.
- **A saved login has to travel.** `state --save` and `--load` read and write on
  the machine the browser is on, so a state file saved here is not there: save
  it in a local session, `browse box push` it over, then `--load` the box's path.
  Load it with `--clean` when the app mints its own session cookie on load (any
  Clerk/NextAuth console does) — a merge leaves the page's newer cookie on top
  and the load quietly does nothing. browse says how many it replaced.
- **`down` is the ending.** The TTL that also deletes it is a backstop for a
  crashed session, not a plan. Export `BROWSE_REMOTE` and keep it exported and
  `down` needs no argument; without it, `down` refuses to choose between several
  boxes rather than deleting the one another agent is recording on.
- **Give a real app room.** Everything it installs lands on the box's disk, and
  a `node_modules` plus a framework build is several GB. A browser on a full
  disk dies as `Target crashed` — browse checks the disk when that happens and
  says so, but the cheaper move is not to run out (`browse box help`: `--size`).
- **Never make a keep-alive box.** They bill a flat monthly rate whether used or
  not, the opposite of what this is for.
- **A fresh box with no `browse` on it means the image is stale.** Rebuild it
  with `browse box image` rather than installing onto the session's own box.
- **`browse box url`** is worth offering alongside the video when the user will
  want to click around the app themselves. Say plainly that the link dies with
  the box.
- **An ssh error usually means the box is gone**, deleted or expired;
  `browse box ls` says. The recording went with it and there is nothing to
  recover, so start over rather than hunting.

## Before you point it at a shared machine

To be reachable through the tunnel from outside a container, the daemon binds
`0.0.0.0` on the remote. Anything that can route to that machine can then drive
your browser and read the session's recordings. That is fine for a box (its
network is its own) and fine for a VPS only you reach. On anything shared, set
`BROWSE_BIND` yourself, and remember a live session holds real logins if you
used `-p`.
