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
  copies the session's request log down first. On a box those three run but their
  OUTPUT is swallowed by the ssh gateway, so browse tells you to re-run them
  through `browse-box exec` instead.
- **`BROWSE_OUT` is the one knob that does nothing here.** The browser writes on
  the remote and the copies land in a mirror dir; take the artifact paths from
  `close` and `dir` rather than choosing them. Every other browser-side env var
  reaches the remote daemon, so a flag and its env twin still agree.

## Upstash Box

`browse-box` (next to `browse`; `browse-box help` is its command surface) makes
the box side disposable: `up` gives you a fresh box in about 13 seconds, `down`
deletes it, and nothing of yours is left running in between. One credential
covers both halves — browse hands the same Box API key to the box's ssh as its
password — and `browse-box key` is how you save it.

For the session-shaped version of all this, there is a `browse-box` skill.

The shape of a session — the app runs on the box, so `browse open` at
`127.0.0.1` finds it:

```sh
export BROWSE_REMOTE=$(browse-box up)          # fresh box, ~13s
browse-box push $BROWSE_REMOTE ./my-app        # copy the code over
browse-box exec $BROWSE_REMOTE 'cd /workspace/home/my-app && npm i && (npm run dev &)'
browse open http://127.0.0.1:3000
...
browse close                                   # the mp4 lands here
browse-box down                                # box deleted
```

**Why it is fast: the image.** Installing browse on a bare box takes ~6 minutes
(Chromium alone is ~1GB). `browse-box image` does that once and snapshots the
result; `up` restores that snapshot instead of installing. A snapshot restores
the **whole disk** — the apt packages and `/usr/local/bin/browse` come back with
it, not just `/workspace` — and it outlives the box it was taken from, so the
image is the only thing you keep. Re-run `image` after a browse update.

**Boxes made by `up` expire on their own** (`--ttl`, 8h by default), so a session
you walk away from does not become an account full of boxes. `down` is still the
right ending; the TTL is the backstop.

**Use `exec`, not ssh, to run things on a box.** A box's ssh gateway runs your
command and then throws its output and exit status away, and kills whatever it
left running — so an `ssh box 'npm run dev &'` dev server dies the moment the
command returns. `browse-box exec` goes through the box's API, which does
neither.

**What it costs.** CPU seconds while the box actually runs, plus the image's
storage between sessions (~0.6GB, cents a month). Nothing is billed for a box
that no longer exists. Avoid keep-alive boxes here: they bill a flat monthly rate
whether you use them or not, which is the opposite of what this is for.

**Keep everything under `/workspace/home`.** It is the box user's half of the
volume; `push` and the provisioning both default there.

`browse-box url <box> <port>` gives a port a public
`https://<box-id>-<port>.preview.box.upstash.com` URL — the link to hand someone
who wants to click around the app themselves rather than watch the video. It
works on these boxes despite what the Box docs' feature table says, but only if
the server is bound to `0.0.0.0`: the proxy reaches the container from outside,
so a dev server on `127.0.0.1` answers 502. `browse open` does not care either
way, so a server started the usual way records fine and only the shareable link
is dead. Start it with `--host 0.0.0.0` (or your framework's equivalent) when you
want both.

## Before you point it at a shared machine

To be reachable through the tunnel from outside a container, the daemon binds
`0.0.0.0` on the remote. Anything that can route to that machine can then drive
your browser and read the session's recordings. That is fine for a box (its
network is its own) and fine for a VPS only you reach. On anything shared, set
`BROWSE_BIND` yourself — and remember a live session holds real logins if you
used `-p`.
