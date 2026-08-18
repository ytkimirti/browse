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

`browse-box` (next to `browse`; `browse-box help` is its command surface) is the
box side of this: bring one up, put files on it, run things on it, stop it. It
needs `UPSTASH_BOX_API_KEY`, which is also what browse hands the box's ssh as a
password, so a box needs no second credential.

The shape of a session — the app runs on the box, so `browse open` at
`127.0.0.1` finds it:

```sh
export BROWSE_REMOTE=$(browse-box up)          # resumes your box, ~1s
browse-box push $BROWSE_REMOTE ./my-app        # copy the code over
browse-box exec $BROWSE_REMOTE 'cd /workspace/home/my-app && npm i && (npm run dev &)'
browse open http://127.0.0.1:3000
...
browse close                                   # the mp4 lands here
browse-box down                                # meter off
```

**Use `exec`, not ssh, to run things on a box.** A box's ssh gateway runs your
command and then throws its output and exit status away, and kills whatever it
left running — so an `ssh box 'npm run dev &'` dev server dies the moment the
command returns. `browse-box exec` goes through the box's API, which does
neither.

**`up` resumes, it does not create.** A paused box keeps its whole disk — the
browse checkout, ~1GB of browsers, the apt packages — and comes back in under a
second, while costing only storage. The first `up` provisions one (a few
minutes); every later one resumes it. Snapshots are *not* a shortcut here: a
snapshot does not carry the install, so restoring one still means provisioning.

You can skip `up` entirely once a box is provisioned: a `browse --remote`
command wakes a paused box by itself (about 5 seconds to the first page). `down`
is the half that matters — nothing stops the meter for you except the idle
auto-pause.

**What it costs.** CPU only while the box is actually running, plus about
$0.10/GB/month for a paused box's disk. `down` stops the CPU meter immediately,
and a box you forget pauses itself when idle. Avoid keep-alive boxes for this:
they bill a flat monthly rate whether you use them or not.

**Keep everything under `/workspace/home`.** It is the box user's half of the
volume that survives a restart; the rest of the filesystem does not. `push` and
the provisioning both default there.

`browse-box url <box> <port>` gives a port a public
`https://<box-id>-<port>.preview.box.upstash.com` URL — the link to hand someone
who wants to click around the app themselves rather than watch the video.

## Before you point it at a shared machine

To be reachable through the tunnel from outside a container, the daemon binds
`0.0.0.0` on the remote. Anything that can route to that machine can then drive
your browser and read the session's recordings. That is fine for a box (its
network is its own) and fine for a VPS only you reach. On anything shared, set
`BROWSE_BIND` yourself — and remember a live session holds real logins if you
used `-p`.
