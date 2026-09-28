---
name: browse
description: Drive a real, recorded browser step by step with the local `browse` CLI, capturing every session as a video plus transcript, per-step screenshots and a network log. Use when the user wants a video/demo/walkthrough of a web app, wants a UI change verified or a frontend bug reproduced in a real browser, wants a local dev server driven end to end, wants the run recorded on a remote machine or a throwaway box instead of this one, or says "browse".
---

# browse: recorded agentic browsing

`browse` (on PATH; source `browse.mjs` in this repo) drives a persistent headless
browser via a localhost daemon, one browser per session name. The first command
spawns the browser with recording already on; every later command drives the same
live session.

**`browse help` is the command and flag surface.** Bare `browse help` is a short
index; `browse help <command>` (or `browse <command> --help`) prints one command
in full. Look a command up before its first use this session rather than
recalling Playwright from memory, and look up only that command: `help --all` is
the whole reference and rarely worth its size.

## The loop

For individual commands, act, read the result and decide the next action. For a
delegated multistep goal, use task mode as described below; browse owns that loop
and returns the recorded steps and outcome.

1. **Act**, then read the output closely, stderr included. New console/page
   errors, answered dialogs, saved downloads and tips arrive on stderr with the
   next command; stdout holds only the result, so piping or capturing it is safe.
2. **Observe with `snapshot`, not `eval`.** `snapshot` is your check step: it
   shows what a user can see and act on. Scope it to the relevant region when a
   long feed or unrelated content crowds out the controls. Keep `eval` for state
   the page does not render (a global, storage, a computed value); reading
   visible UI through `eval` checks the DOM, not what the user sees.
3. **Wait for a condition, never a duration.** Before `wait`, name what proves
   the step finished (an element, its text, the URL) and wait on that: it
   doubles as your assertion and exits non-zero if the thing never happens. A
   fixed `wait <ms>` asserts nothing, is flaky when too short and leaves dead air
   when too long. If you cannot name the condition, `snapshot` to find one
   (`browse help wait`).
4. **Diagnose** from what the session already recorded: `errors` (the alarm),
   `console` (everything the page logged), and `net` (note the last entry `#`,
   act, then `net --since <#> --failed` to see only what that action caused).
5. **Reach states the UI can't get you to** with `middleware` for a REQUEST (an
   error path, an empty list, a slow endpoint, a paid tier) and `init` for page
   STATE that must exist before the app's own JS runs (an analytics stub, a
   consent flag, a frozen clock). Both only affect what happens after they are
   registered, so set them up before `open`, or `reload` after. Never rewrite a
   dev server's HTML document with `middleware` to inject a script: on Next/Vite
   that produces an endless reload loop that reads exactly like an app bug.
6. **Finish the recording.** Wait for `close` to finish and verify the reported
   artifacts exist locally before handing them off or deleting the remote.
   A tool returning a running process handle is still working. Preserve the
   full tool result and wait on that handle; printing only its output loses the
   handle. An empty live-session list does not prove finalization finished.

## Fast semantic decisions

Use `ai task` to delegate a browser goal that requires several interactions. It
observes the current controls and page text after each action, then decides the
next action without another turn from the calling agent. Read [AI decisions](skill/ai.md)
before the first use; help defines its command surface. A stopped task is partial
progress, not success. Inspect its recorded steps before resuming so submissions
and other completed actions are not repeated.

Use exact selectors when already known, or the single-action AI commands when
the surrounding agent needs to decide each step. Verify the expected page state
after an action; a successful click only establishes that the browser acted.

## Start the app before the first command

Recording starts the moment the browser spawns, so never fire `open` at a dead
port. Start the dev server first, redirect its output to a log
(`bun run dev > /tmp/dev.log 2>&1 &`), and wait until it really listens
(`until curl -sf http://127.0.0.1:<port> >/dev/null; do sleep 1; done`, checking
the real port). `browse` only sees the browser; server-side stack traces are ONLY
in that log. With `--remote`, that port has to be on the REMOTE machine
(`skill/remote.md`). After `open`, confirm with `snapshot`/`text` that the page
is not blank, connection-refused, or a framework error overlay.

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
  (`skill/engines.md`). The first command's `started session` line names the
  engine and profile you got. Cookie metadata is an inventory, not proof of login.
  For an authenticated task, read [authentication](skill/auth.md) and establish
  access to the exact target before the capture pass.
- **Launch flags** (`--headful`, `--chromium`, `--viewport`, …) only on the
  command that STARTS the session — which is whichever one you run first, so an
  `init` or `middleware` registered before `open` is the one that carries them.
  Repeating matching flags on later commands is fine; one that differs from the
  live session is refused, so a wrong frame size means close and re-open.

## Recording

For a quick check ("does X work?"), a `screenshot` plus `errors` is enough; the
recording need not be the deliverable. A shot you only need to look at can be
1x (`--scale css`, see help) instead of Retina; step shots already are. When the user wants a demo, or the moving
interaction is the point, read `skill/recording.md` BEFORE the session starts,
since the frame size is fixed the moment the browser spawns.

A run can also be recorded not at all (`browse help launch`). Reach for
that only when the session is a pure READ nobody will watch — asserting a count,
minting a token, exporting state. If there is any chance the user will ask "show
me" afterwards, keep the recording: it cannot be added later.

## Hand off artifacts

Track the requested surfaces as captured, blocked, or not visited. A fixture
or mock demonstrates only that fixture or mock. When real-page coverage is
blocked, tell the user promptly and keep the task incomplete until the requested
coverage is delivered or the user explicitly changes it.

Each session gets `~/.browse/sessions/<timestamp>/` with `transcript.md`,
`recording.mp4`, `browsed.log`, `network.jsonl`, `console.jsonl`, and auto per-step screenshots
under `shots/` (Read them as images to see what a step looked like). Give the user
the bare `~/…` path that `close` printed, pasteable straight into their shell.

When reporting a failure, separate the observed command and result from your
suspected cause, and keep tool-wrapper failures distinct from browser failures.
Check help before calling a capability missing.

## More

- `browse help` - index; `browse help <command>` one command in full; `--all` everything; `--env` env vars
- `skill/recording.md` — recording craft, when the video is the deliverable
- `skill/engines.md` — camoufox (default, clears bot walls) vs chromium (needed for
  `emulate`, PDF, and polished demos)
- `skill/remote.md` — running the browser on another machine (`--remote`), and on
  a disposable Upstash Box (`browse box`)
- `skill/troubleshooting.md` — daemon won't start, selector misses, install, ffmpeg
- `skill/auth.md` - authenticated capture, expired profiles and redirect loops
