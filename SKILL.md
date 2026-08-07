---
name: browse
description: Drive a real, recorded Chromium browser step by step with the local `browse` CLI - every session is automatically captured as a video (with an animated cursor and keystroke overlay), a markdown transcript, and per-step screenshots. Use when the user wants to record a video/demo/walkthrough of a web app or flow, verify a UI change in a real browser, reproduce a frontend bug, test a local dev server end-to-end, or says "browse", "record the browser", "show me a video of it working".
---

# browse — recorded agentic browsing

`browse` (on PATH; source `browse.mjs` in this repo) drives a persistent headless
browser via a localhost daemon — one browser per session name (see Parallel
sessions). The first command spawns the browser with recording already on;
every later command drives the same live session. Commands
mirror Playwright's page API; selectors are Playwright strings (`text=`,
`role=button[name="…"]`, css, `xpath=`).

Use it AGENTICALLY: run one command, read the result, decide the next action,
repeat. It is not a script runner. Run `browse help` for the full command list.

## Quick start

```bash
browse open https://example.com        # spawns browser + starts recording
browse snapshot                        # accessibility tree — your "check" step
browse click "text=More information"
browse fill "input[name=q]" "hello"    # types key-by-key, shows keystroke overlay
browse press "input[name=q]" Enter
browse screenshot result.png
browse close                           # finalize recording → prints the mp4 path
```

## Core loop

1. **Act**: `open/goto/click/fill/type/press/check/hover/selectOption/setInputFiles/
   drag/scroll/reload/goBack`
2. **Observe** (do this often): `snapshot` (a11y tree), `text [sel]`, `title`, `url`,
   `errors` (console + page errors), `screenshot [name] [--full] [--sel <sel>]`
3. New console/page errors, answered dialogs and saved downloads are appended
   inline to the next command's result - read command output carefully.
4. **Always `browse close` when done** — it finalizes the video and prints the
   mp4 path. A forgotten session auto-closes after 30 min idle.
5. **After close, write `feedback.md`** into the session dir (see below).

## Wait, verify, target, emulate

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

Only tab 0 is recorded: a popup's time is cut from the video and a `target new`
tab is not in it at all, so park tab 0 on a STATIC page before working in one
(motionless time there is cut; a spinner or live log is not). Dialogs are
auto-accepted and reported inline; add `--dialog dismiss` / `--dialog "accept:my
answer"` to the action that triggers one. Downloads save to `downloads/` in the
session dir and print their path.

## Recording rules

- Recording starts the moment the browser spawns. Do NOT fire the first command
  at a dead port: start the dev server first, redirect its output to a log
  (`bun run dev > /tmp/dev.log 2>&1 &`), and wait until it really listens
  (`until curl -sf http://127.0.0.1:<port> >/dev/null; do sleep 1; done` — check
  the real port). `browse` only sees the browser; server-side stack traces are
  ONLY in that log. After `open`, confirm with `snapshot`/`text` that the page
  is not blank, connection-refused, or a framework error overlay.
- For a quick check ("does X work?"), a `browse screenshot` + `browse errors` is
  enough - no need to make the recording the deliverable. Record a full flow when
  the user wants a demo or the moving interaction is the point.
- The video shows an animated cursor gliding to elements (a pointing hand over
  links/buttons, like a real browser), click ripples and a keystroke overlay -
  pace steps naturally (a short `browse wait 800` after key moments reads better).
- Dead time while you think is CUT from the video automatically. If a step has a
  long but visibly-active wait (a spinner, a deploy log, a progress bar), bracket
  it with `browse speed 10` … `browse speed off` so the viewer still sees it
  happen, just faster (badged `10x`). Don't speed up the actions you want shown.
- The frame size is fixed when the browser starts. Default 1280x800; if the app's
  bottom is clipped, or you want a phone-shaped demo, START the session with
  `BROWSE_VIEWPORT=1280x900` / `=390x844` - the only way to record either, since
  `emulate viewport=` re-lays-out the page but leaves the rest of the frame grey.
  A `browse screenshot` right after `open` catches clipping before you record.
- `browse toast "<one sentence>"` shows a NOTE chip on the video. Use it
  SPARINGLY — only when the viewer needs context the screen itself doesn't give
  (why something matters, a caveat, what to look at in a dense screen). Never
  narrate what the viewer can already see ("clicking X") - the cursor shows that.
  A good demo has 0–3. They auto-dismiss after ~reading time (`--for <sec>`,
  `--sticky` + `--clear` to pin one) and their on-screen time survives the
  dead-air cut, so `browse wait 5000` their lifetime when the viewer should
  finish reading first. Plain prose, no markdown. Prefer it over `eval`.

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

`browse help` has the full flag list. Secret header/cookie VALUES are stored as a
sha256 prefix + length, so you can tell credentials apart and spot rotation
without the secret landing in a log. Typical use: note the last `#`, act, then
`browse net --since <#> --failed`.

## Parallel sessions (multiple agents)

Named sessions are fully isolated — own browser, own recording, own artifacts
dir: `browse -s <name> <cmd>` (or `BROWSE_SESSION=<name>`). Prefix EVERY
command with the same `-s <name>`, including the final `close`.

**Prefer passing your own `-s <name>`.** Pick a short name for the task
(`-s checkout-bug`, `-s dx2744`) on the very first command and keep it on every
command through `close`. It makes the artifacts dir self-describing, survives
anything that changes your process identity, and is the only way two browsers
under one agent (or your subagents) stay separate. The auto-derived name below
is a collision safety net, not the intended path.

With no `-s`, the session name is derived automatically from the calling agent
(its session-id env var, else the pid of the nearest agent process up the
process tree) — unique per agent, stable across that agent's commands, so two
agents that both omit `-s` get separate browsers instead of stomping on one.
A plain human terminal gets `default`. `browse whoami` prints the name in
effect; `browse sessions` lists what's live.

Subagents of the SAME agent session inherit that auto name, so when you spawn
subagents that each need a browser, give each a unique session name in its
prompt and tell it to use `browse -s <name> …` throughout.

## Artifacts & delivering the video

Each session gets its own dir: `~/.browse/sessions/<timestamp>/` containing
`transcript.md`, `recording.mp4`, `browsed.log`, `network.jsonl`, and auto
per-step screenshots under `shots/`. `browse dir` prints it; `browse close`
prints the recording path. Hand any artifact to the user as the bare `~/…` path
`close` printed: that is the deliverable, pasteable straight into their shell.

On `close`, ffmpeg trims the blank white lead-in/out, CUTS static "agent
thinking" dead air (≥2s with no on-screen change) out of the clip, and
fast-forwards any region you bracketed with `browse speed <n>` … `browse speed
off` at `n×` — with an `n×` badge pinned top-right while sped up, so viewers can
tell compressed time from real time — then writes a shareable `recording.mp4`,
so the video is mostly action, not dead air. The
temp raw webm in `video/` is deleted once the mp4 exists (kept only if ffmpeg
is missing/fails).

Screenshots under `shots/` can be Read (they are images) to see what a step
actually looked like.

## After every recording: write feedback.md

Right after `browse close`, write a short `feedback.md` into that session's dir
(`close` prints it). Cover: what flow you recorded, what worked, any friction
(selector misses, timing/pacing, missing commands, video quality), and one
concrete improvement idea for this skill. These files get reviewed across
sessions to keep improving the skill — be candid and specific, a few bullet
points is enough.

## Config (env, all optional)

| Var | Meaning |
| --- | --- |
| `BROWSE_APP_URL` | default url for `browse open` (default `http://127.0.0.1:3000`) |
| `BROWSE_VIEWPORT` | recording viewport `WxH` (default `1280x800`); or set `BROWSE_WIDTH` / `BROWSE_HEIGHT` individually |
| `BROWSE_OUT` | override session artifacts dir |
| `BROWSE_HEADFUL=1` | show the browser window (still records) |
| `BROWSE_ENGINE` | `camoufox` (default) or `chromium` — see **Engines** below |
| `BROWSE_CURSOR=0` / `BROWSE_KEYLOG=0` | disable cursor / keystroke overlays (already off under camoufox; `=1` forces them on) |
| `BROWSE_TYPE_DELAY` | ms per keystroke for fill/type (default 45, 0 = paste) |
| `BROWSE_SESSION` | session name, same as `-s <name>` (unset = auto-derived per calling agent, `default` for a human terminal) |
| `BROWSE_PROFILE` | persist cookies+localStorage in a named user-data dir (`~/.browse/profiles/<name>`) so logins/tokens survive `close`→`open` — same as the `-p <name>` flag. One live session per profile. Unset = throwaway clean context (the default). |
| `BROWSE_PORT` | pin the daemon control port (default: any free port) |
| `BROWSE_IDLE_MS` | idle auto-close (default 30 min, 0 = never) |
| `BROWSE_IDLE_MODE` | what to do with auto-detected static dead air: `cut` (default, drop it), `speed` (fast-forward at `BROWSE_IDLE_SPEED`), or `keep` (real time) |
| `BROWSE_IDLE_SPEED` | fast-forward factor: for `BROWSE_IDLE_MODE=speed`, and the default `N` for `browse speed` (default 10) |
| `BROWSE_FPS` | constant frame rate of the finalized mp4 (default 30) |
| `BROWSE_POPUPS=1` | let `target=_blank` / `window.open` make real popups (default: same-tab, keeps the video whole) |
| `BROWSE_KEEP_WEBM=1` | keep the raw webm after the mp4 is written, so the session can be re-cut |
| `BROWSE_NET=0` | disable network logging (on by default) |
| `BROWSE_NET_BODIES=0` / `BROWSE_NET_BODY_MAX` | skip capturing bodies / cap bytes kept per body (default 32768) |
| `BROWSE_NET_SECRETS=1` | keep auth headers + cookies verbatim (default: values hashed to a sha256 prefix + length) |

## Engines

`BROWSE_ENGINE=camoufox` is the **default**. Camoufox is a Firefox build with
fingerprint patches applied in C++; it clears Cloudflare's JS managed challenge
*headlessly*, which Chromium cannot do at all — its new-headless is handed an
unsolved `cf_clearance`, and headed Chrome can't be hidden on macOS because
`--window-position` is clamped onto the nearest real display. If camoufox isn't
installed, browse logs it and falls back to Chromium on its own.

Setup (one time): `uv tool install camoufox`, then
`~/.local/share/uv/tools/camoufox/bin/python -m camoufox fetch`, then
`browse setup`. Camoufox is built against a specific Playwright (0.5.4 → 1.60.0)
and its Firefox speaks that exact protocol, so browse loads Firefox from a
pinned `playwright-core@1.60.0` in `~/.browse/camoufox-pw` rather than the newer
one it uses for Chromium — that third step is what installs the pinned copy
(the launcher also installs it automatically the first time it sees camoufox).
If browse ever falls back to Chromium it says so in the `browse open` output.

That pinned copy is also **patched** at install time so camoufox can record at
all. Camoufox's Juggler wants a `screencastId` on every frame ack and sends
frames without a `timestamp`; stock Playwright does neither, so the ack is
rejected, the stream stalls, and the session ends with an empty video dir and a
`close` that blames ffmpeg. `browse setup` re-applies the patch whenever it is
missing, and says so if it ever stops applying.

Switch back with `BROWSE_ENGINE=chromium` when you need:

- `browse emulate` (timezone/locale/cpu/network) — CDP-only
- saving a `.pdf` — `page.pdf()` is Chromium-only

Both raise a clear error under camoufox rather than a Playwright stack trace.

Under camoufox the three init scripts browse normally injects (cursor overlay,
keystroke overlay, same-tab popup rewrite) default **off**: they are injected
into every page, and on a bot-walled site that is the difference between passing
and not. Force any of them back on with `BROWSE_CURSOR=1`, `BROWSE_KEYLOG=1`,
`BROWSE_POPUPS=0`. If you want a polished demo recording, use
`BROWSE_ENGINE=chromium`; if you want to get past a bot wall, keep the default.

Camoufox profiles are Firefox-format, so `-p foo` under camoufox uses
`~/.browse/profiles/foo-camoufox`, separate from the Chromium `foo`. Log in once
per engine.

## Troubleshooting

- **One browser per session name.** Reusing a live name keeps driving that same
  browser; `browse close` it (same `-s <name>`) to start fresh - closing a dead
  session is a safe no-op. Distinct `-s` names never share state.
- Daemon won't start → read `browsed.log` in the session dir it printed.
- A missing selector fails in ~4-12s by design and the error now lists the closest
  matches from the a11y tree - use those instead of retrying blindly.
- `browse` needs Node 18+ on PATH; Playwright auto-installs on the first run
  into `~/.browse/` and Chromium into playwright's shared cache (one-time,
  ~2 min — pre-install with `browse setup`, which is also the repair command;
  `rm -rf ~/.browse/node_modules` forces a reinstall).
  `browse help` / `browse version` never trigger it. The
  mp4 finalize uses system `ffmpeg`, falling back to Playwright's bundled copy.
- The `10x` badge needs an ffmpeg built with `drawtext` (libfreetype), which
  homebrew's current bottle lacks - the region is still sped up but unlabelled,
  so it reads as a jump cut. `browse speed` warns once per session when that is
  the case; a `browse toast` before it covers the gap.
