---
name: browse
description: Drive a real, recorded browser step by step with the local `browse` CLI - every session is captured as a video (animated cursor + keystroke overlay), a markdown transcript, per-step screenshots and a network log. Use when the user wants a video/demo/walkthrough of a web app, wants a UI change verified or a frontend bug reproduced in a real browser, wants a local dev server driven end to end, or says "browse".
---

# browse — recorded agentic browsing

`browse` (on PATH; source `browse.mjs` in this repo) drives a persistent headless
browser via a localhost daemon — one browser per session name. The first command
spawns the browser with recording already on; every later command drives the same
live session. Commands mirror Playwright's page API; selectors are Playwright
strings (`text=`, `role=button[name="…"]`, css, `xpath=`).

Use it AGENTICALLY: run one command, read the result, decide the next action,
repeat. It is not a script runner. `browse help` is the full command + flag list.

```bash
browse open https://example.com        # spawns browser + starts recording
browse snapshot                        # accessibility tree — your "check" step
browse click "text=More information"
browse fill "input[name=q]" "hello"    # types key-by-key, keystroke overlay
browse press "input[name=q]" Enter
browse close                           # finalize recording → prints the mp4 path
```

## Core loop

1. **Act**: `open/goto/click/fill/type/press/check/hover/selectOption/setInputFiles/
   drag/scroll/reload/goBack`
2. **Observe** (do this often): `snapshot` (a11y tree), `text [sel]`, `title`, `url`,
   `errors`, `screenshot [name] [--full] [--sel <sel>]`
3. New console/page errors, answered dialogs and saved downloads are appended
   inline to the next command's result — read command output carefully.
4. **Always `browse close` when done** — it finalizes the video and prints the mp4
   path. A forgotten session auto-closes after 30 min idle.
5. **After close, write `feedback.md`** into the session dir (see below).

```bash
browse wait "text=Deployed"        # also your ASSERTION: non-zero exit if it never appears
browse wait "#row-3" --gone        # assert something disappeared
browse wait --url "/dashboard"     # a navigation · browse wait 800 = plain pause (ms)
browse press Escape                # no selector = global key (Escape, Tab, "Meta+k")
browse scroll 600 | top | bottom | "#footer"     # smooth-scrolls, reads well on video
browse target                      # list tabs; popups are switched to AUTOMATICALLY
browse target 0 | new [url] | close | "iframe#checkout" | top
browse emulate dark=1 tz=Europe/Istanbul net=3g    # off = reset all
browse state --save auth.json      # …then --load auth.json (+ --clean to switch accounts)
```

Dialogs are auto-accepted and reported inline; add `--dialog dismiss` /
`--dialog "accept:my answer"` to the action that triggers one. Downloads save to
`downloads/` in the session dir and print their path.

## Start the app before the first command

Recording starts the moment the browser spawns, so never fire `open` at a dead
port. Start the dev server first, redirect its output to a log
(`bun run dev > /tmp/dev.log 2>&1 &`), and wait until it really listens
(`until curl -sf http://127.0.0.1:<port> >/dev/null; do sleep 1; done` — check the
real port). `browse` only sees the browser; server-side stack traces are ONLY in
that log. After `open`, confirm with `snapshot`/`text` that the page is not blank,
connection-refused, or a framework error overlay.

## Recording

For a quick check ("does X work?"), a `screenshot` + `errors` is enough — the
recording need not be the deliverable. When the user wants a demo or the moving
interaction is the point, read `skill/recording.md` first: frame size (must be set
before the session starts), pacing, `speed`, `toast`, and tab rules.

## Network requests

Every request is logged, always on, to `network.jsonl` in the session dir (url,
method, status, timing, size, headers, text/JSON bodies up to 32kB). `browse net`
is a pure read of it, so it works **live and after `close`**, and never spawns a
browser.

```bash
browse net                        # last 30 requests, one line each
browse net -d api.upstash.com --failed --full     # by domain, errors only, headers+bodies
browse net --since 42             # only what happened after entry #42
browse net --json | jq 'select(.ms > 500) | .url'  # escape hatch: every field, no limits
```

Typical use: note the last `#`, act, then `browse net --since <#> --failed`. Secret
header/cookie VALUES are stored as a sha256 prefix + length, so you can tell
credentials apart and spot rotation without the secret landing in a log.

## Sessions

**Pass your own `-s <name>`.** Pick a short name for the task (`-s checkout-bug`,
`-s dx2744`) on the very first command and keep it on every command through
`close`. Named sessions are fully isolated — own browser, own recording, own
artifacts dir — and this is the only way two browsers under one agent (or your
subagents) stay separate. When you spawn subagents that each need a browser, give
each a unique session name in its prompt.

With no `-s`, the name is auto-derived from the calling agent: a collision safety
net, not the intended path. `browse whoami` prints the name in effect;
`browse sessions` lists what's live.

## Artifacts

Each session gets `~/.browse/sessions/<timestamp>/` with `transcript.md`,
`recording.mp4`, `browsed.log`, `network.jsonl`, and auto per-step screenshots
under `shots/` (Read them as images to see what a step looked like). `browse dir`
prints the dir; `close` prints the recording path. Hand any artifact to the user
as the bare `~/…` path `close` printed — pasteable straight into their shell.

## After every recording: write feedback.md

Right after `browse close`, write a short `feedback.md` into that session's dir.
Cover: what flow you recorded, what worked, any friction (selector misses,
timing/pacing, missing commands, video quality), and one concrete improvement idea
for this skill. These get reviewed across sessions to keep improving the skill —
be candid and specific, a few bullets is enough.

## More

- `skill/recording.md` — recording craft, when the video is the deliverable
- `skill/engines.md` — camoufox (default, clears bot walls) vs chromium (needed for
  `emulate`, PDF, and polished demos)
- `skill/config.md` — every `BROWSE_*` env var
- `skill/troubleshooting.md` — daemon won't start, selector misses, install, ffmpeg
