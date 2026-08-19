---
name: browse-box
description: Record a browse session on a disposable Upstash Box instead of this machine — the browser, the dev server and ffmpeg all run there, the mp4 lands here. Use when the user says "/browse-box", "on a box", "record this remotely", or when the laptop is too loaded to spare a browser.
---

# browse-box — a recorded session on a throwaway machine

Everything the `browse` skill says still applies: same commands, same loop, same
artifacts, same `close`. This skill only covers **where the browser runs**. Read
the `browse` skill for the session itself; read this for the box around it.

`browse-box help` is the command surface. `browse help` is browse's.

Why bother: a browser plus a dev server plus ffmpeg is the heaviest thing an
agent runs, and a box has RAM the laptop is already spending on other agents. A
box is disposable — about 13 seconds to make, deleted when you are done, nothing
billed in between.

## The session

```sh
export BROWSE_REMOTE=$(browse-box up)              # prints the --remote host
browse-box push $BROWSE_REMOTE ./my-app
browse-box exec $BROWSE_REMOTE 'cd /workspace/home/my-app && npm i && (npm run dev &)'
browse open http://127.0.0.1:3000                  # …then the normal browse loop
browse close                                       # mp4 lands HERE
browse-box down                                    # box deleted
```

`BROWSE_REMOTE` has to be set for **every** `browse` command in the session,
`close` included — export it once and keep the same shell, or pass `--remote`
each time.

## What actually differs

- **`127.0.0.1` is the BOX's.** Your laptop's dev server does not exist to it.
  Run the app on the box (that is the point) and confirm it listens *there*,
  with `browse-box exec … 'curl -sf …'`, before the first `browse` command —
  recording starts the moment the browser spawns.
- **`exec`, never `ssh`.** A box's ssh gateway throws away stdout, throws away
  the exit status, and kills whatever the command left running. `exec` goes
  through the box's API and does none of that, which is why a backgrounded dev
  server survives it.
- **Keep everything under `/workspace/home`** — the box user's half of the disk,
  and where `push` puts things.
- **Always `down`.** The box expires on its own eventually, but that is a
  backstop for a crashed session, not the ending.
- **The engine will be chromium**, because no server has camoufox. Fine for a
  demo; it matters only against a bot wall (`../engines.md`).

## Handing over something clickable

`browse-box url <box> <port>` gives the app a public https URL — worth offering
alongside the video when the user will want to poke at it themselves. It only
answers if the server is bound to `0.0.0.0`; a dev server on `127.0.0.1` records
perfectly and 502s on the link, so start it with `--host 0.0.0.0` when you plan
to share one. Say plainly that the link dies with the box.

## When it goes wrong

- **No API key** — `browse-box key <key>` saves it; the message says so.
- **A command that reads the box's disk** (`profiles`, `clear`, `setup`) prints
  nothing over ssh. browse refuses and names the `browse-box exec` form to use.
- **`browse` fails with an ssh error** — the box is usually gone (deleted, or
  expired). `browse-box ls` says. The recording goes with it; there is nothing
  to recover, so start over rather than hunting.
- **The image is stale** after a browse update: `browse-box image` re-bakes it
  (~6 min, once). `up` is only fast because that image exists.

`../remote.md` has the `--remote` mechanics underneath this — tunnels, what
gets mirrored, and pointing browse at a machine that is not a box.
