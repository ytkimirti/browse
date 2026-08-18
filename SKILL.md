---
name: browse
description: Drive a real, recorded browser step by step with the local `browse` CLI, capturing every session as a video plus transcript, per-step screenshots and a network log. Use when the user wants a video/demo/walkthrough of a web app, wants a UI change verified or a frontend bug reproduced in a real browser, wants a local dev server driven end to end, or says "browse".
---

# browse — recorded agentic browsing

`browse` (on PATH; source `browse.mjs` in this repo) drives a persistent headless
browser via a localhost daemon, one browser per session name. The first command
spawns the browser with recording already on; every later command drives the same
live session.

**`browse help` is the command and flag surface** (`browse help --env` for env
vars). Read it before reaching for a command or flag you have not used this
session, rather than recalling Playwright from memory.

## The loop

Run one command, read the result, decide the next action, repeat. It is not a
script runner.

1. **Act**, then read the output closely. New console/page errors, answered
   dialogs and saved downloads are appended inline to the next command's result.
2. **Observe often.** `snapshot` is your check step. `wait` doubles as your
   assertion: it exits non-zero if the thing never happens. Hold for what the UI
   SAYS (`wait <sel> --text Complete`) rather than guessing a duration — a bare
   `wait <ms>` asserts nothing, slows the run and paces the video worse.
3. **Diagnose** from what the session already recorded: `errors` (the alarm),
   `console` (everything the page logged), and `net` (note the last entry `#`,
   act, then `net --since <#> --failed` to see only what that action caused).
4. **Reach states the UI can't get you to** with `middleware` for a REQUEST (an
   error path, an empty list, a slow endpoint, a paid tier) and `init` for page
   STATE that must exist before the app's own JS runs (an analytics stub, a
   consent flag, a frozen clock). Both only affect what happens after they are
   registered, so set them up before `open`, or `reload` after. Never rewrite a
   dev server's HTML document with `middleware` to inject a script: on Next/Vite
   that produces an endless reload loop that reads exactly like an app bug.
5. **Always `close`** when done, with the same `-s`. It finalizes the video and
   prints the mp4 path. A forgotten session auto-closes after 30 min idle.

## Start the app before the first command

Recording starts the moment the browser spawns, so never fire `open` at a dead
port. Start the dev server first, redirect its output to a log
(`bun run dev > /tmp/dev.log 2>&1 &`), and wait until it really listens
(`until curl -sf http://127.0.0.1:<port> >/dev/null; do sleep 1; done`, checking
the real port). `browse` only sees the browser; server-side stack traces are ONLY
in that log. After `open`, confirm with `snapshot`/`text` that the page is not
blank, connection-refused, or a framework error overlay.

## Decide these before the first command

- **`-s <name>`, on every command.** Pick a short name for the task
  (`-s checkout-bug`, `-s dx2744`) on the very first command and keep it through
  `close`. Named sessions are fully isolated, and this is the only way two
  browsers under one agent stay separate; give each subagent that needs a browser
  its own name in its prompt. With no `-s` the name is derived from the calling
  agent: a collision safety net, not the intended path.
- **`-p <name>`, on every command**, when you need to stay logged in across
  `close` → `open`. Log in by hand once under `--headful`, `close`, then reuse it.
  A profile is stored per engine, so log in on the engine you will drive with
  (`skill/engines.md`). Check it is still good with `browse profiles <name>`
  BEFORE opening: a saved login that quietly expired is the most common way a
  run dies, and that check costs no browser and no recording.
- **Launch flags** (`--headful`, `--chromium`, `--viewport`, …) only on the
  command that OPENS the session. On a live one browse refuses rather than
  ignoring them, so a wrong frame size means close and re-open.

## Recording

For a quick check ("does X work?"), a `screenshot` plus `errors` is enough; the
recording need not be the deliverable. When the user wants a demo, or the moving
interaction is the point, read `skill/recording.md` BEFORE the session starts,
since the frame size is fixed the moment the browser spawns.

## Hand off artifacts

Each session gets `~/.browse/sessions/<timestamp>/` with `transcript.md`,
`recording.mp4`, `browsed.log`, `network.jsonl`, and auto per-step screenshots
under `shots/` (Read them as images to see what a step looked like). Give the user
the bare `~/…` path that `close` printed, pasteable straight into their shell.

## After every recording: write feedback.md

Right after `browse close`, write a short `feedback.md` into that session's dir.
Cover: what flow you recorded, what worked, any friction (selector misses,
timing/pacing, missing commands, video quality), and one concrete improvement idea
for this skill. These get reviewed across sessions to keep improving the skill, so
be candid and specific; a few bullets is enough.

## More

- `browse help` — every command, flag and default; `browse help --env` for env vars
- `skill/recording.md` — recording craft, when the video is the deliverable
- `skill/engines.md` — camoufox (default, clears bot walls) vs chromium (needed for
  `emulate`, PDF, and polished demos)
- `skill/troubleshooting.md` — daemon won't start, selector misses, install, ffmpeg
