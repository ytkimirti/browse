# browse

Drive a real browser step by step from the CLI, and get a video of it.

One command starts a persistent browser behind a localhost daemon; every later
command drives that same live session. On `browse close` you get an mp4 with an
animated cursor and keystroke overlay, static dead air cut out, plus a markdown
transcript, per-step screenshots and a network log.

Built to be used *agentically*: run one command, read the result, decide the
next one. It is not a script runner.

```bash
browse open https://example.com     # spawns the browser + starts recording
browse snapshot                     # accessibility tree — your "check" step
browse click "text=More information"
browse fill "input[name=q]" "hello" # types key-by-key, keystroke overlay
browse screenshot result.png
browse close                        # finalizes the video, prints the mp4 path
```

Commands mirror Playwright's page API and selectors are Playwright selector
strings (`text=`, `role=button[name="…"]`, css, `xpath=`), so there is nothing
new to learn. `browse help` lists everything.

## Install

Needs `node` on PATH (`ffmpeg` optional but better).

```bash
git clone git@github.com:ytkimirti/browse.git
ln -s "$PWD/browse/bin/browse" ~/.local/bin/browse
browse setup      # installs playwright + chromium into data/ (one-time, ~2 min)
```

Stealth engine (default, optional but recommended) — camoufox is a Firefox build
with C++-level fingerprint patches that clears Cloudflare's managed challenge
headlessly:

```bash
uv tool install camoufox
~/.local/share/uv/tools/camoufox/bin/python -m camoufox fetch
```

Without it, browse logs a note and falls back to Chromium. `BROWSE_ENGINE=chromium`
switches back explicitly (needed for `browse emulate` and PDF export, both CDP-only).

## Use it as an agent skill

`SKILL.md` at the repo root is a Claude Code skill. Symlink or copy it into your
skills directory:

```bash
ln -s "$PWD/browse" ~/.claude/skills/browse
```

Then read `SKILL.md` for the full command surface: tabs and iframes, dialogs,
downloads, `wait` as an assertion, `emulate` (dark mode / timezone / throttling),
saved auth state, network log querying, request interception (`middleware`), video
speed control and toasts.

## Tests

```bash
node test/middleware.test.mjs                        # chromium
BROWSE_ENGINE=camoufox node test/middleware.test.mjs
```
