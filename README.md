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

Needs **Node 18+** on PATH. `ffmpeg` is optional (`brew install ffmpeg`) but
gives you nicer videos.

```bash
git clone https://github.com/ytkimirti/browse.git
mkdir -p ~/.local/bin
ln -s "$PWD/browse/bin/browse" ~/.local/bin/browse
```

Make sure `~/.local/bin` is on your PATH (`echo $PATH | tr : '\n' | grep -q "$HOME/.local/bin" || echo 'add it'`),
then:

```bash
browse setup      # installs playwright + chromium into ~/.browse (one-time, ~2 min)
browse open https://example.com
```

Everything machine-local — Playwright, Chromium, recordings, profiles — lives in
`~/.browse` (override with `BROWSE_HOME`). The clone stays a few files, and
uninstalling is `rm -rf ~/.browse` plus the symlink.

`browse help` and `browse version` work before setup and never download
anything. If you skip `browse setup`, the first real command installs for you.

### Stealth engine (optional, recommended)

camoufox is a Firefox build with C++-level fingerprint patches that clears
Cloudflare's managed challenge *headlessly*, which Chromium cannot do at all.
It is the default engine when present:

```bash
uv tool install camoufox
~/.local/share/uv/tools/camoufox/bin/python -m camoufox fetch
browse setup      # links camoufox to the playwright build it needs
```

Without it, browse falls back to Chromium and says so on the first `browse open`.
`BROWSE_ENGINE=chromium` switches back explicitly (needed for `browse emulate`
and PDF export, both CDP-only).

## Use it as an agent skill

`SKILL.md` at the repo root is a Claude Code skill. Symlink or copy the repo
into your skills directory:

```bash
ln -s "$PWD/browse" ~/.claude/skills/browse
```

Then read `SKILL.md` for the full command surface: tabs and iframes, dialogs,
downloads, `wait` as an assertion, `emulate` (dark mode / timezone / throttling),
saved auth state, network log querying, video speed control and toasts.

## License

MIT
