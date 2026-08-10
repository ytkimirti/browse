# Config (all optional)

## Launch flags

These configure the browser at **start-up**, so they go before the command that
opens the session:

```
browse --headful --chromium -p google open https://accounts.google.com
browse --viewport 390x844 open        # record phone-shaped
```

Passing one to an already-live session is an **error**, not a silent no-op —
close it and re-open, or use a separate `-s <name>`.

| Flag | Meaning |
| --- | --- |
| `--headful` / `--headless` | show the browser window while driving it (still records) |
| `--camoufox` / `--chromium` | engine (default `camoufox`) — see `skill/engines.md` |
| `--viewport WxH` | recording frame size (default `1280x800`). The one to use for a phone-shaped **recording**; `browse emulate viewport=` only resizes the page inside an already-fixed frame |
| `--cursor` / `--no-cursor` | animated on-page cursor overlay (on for chromium, off for camoufox) |
| `--keylog` / `--no-keylog` | keystroke overlay (same defaults) |
| `--popups` / `--no-popups` | let `target=_blank` / `window.open` make real popups, vs rewriting them into same-tab navigation so the video stays one file |
| `--net` / `--no-net` | network logging (on by default) |
| `--type-delay <ms>` | ms per keystroke for `fill`/`type` (default 45, 0 = paste) |
| `--idle <ms>` | idle auto-close (default 1800000 = 30 min, 0 = never) |

Session/profile selection is `-s <name>` and `-p <name>`, on **every** command
aimed at that session (see `SKILL.md`).

## Env

Every flag above is also an env var — `BROWSE_HEADFUL=1`, `BROWSE_ENGINE`,
`BROWSE_VIEWPORT`, `BROWSE_CURSOR`, `BROWSE_KEYLOG`, `BROWSE_POPUPS`,
`BROWSE_NET`, `BROWSE_TYPE_DELAY`, `BROWSE_IDLE_MS` — plus `BROWSE_SESSION` /
`BROWSE_PROFILE` for `-s` / `-p`. A flag on the command wins over the env.

These have no flag (set once in a shell profile). `browse help --env` prints the
same table.

| Var | Meaning |
| --- | --- |
| `BROWSE_HOME` | data home: profiles, sessions, deps (default `~/.browse`) |
| `BROWSE_APP_URL` | default url for `browse open` (default `http://127.0.0.1:3000`) |
| `BROWSE_OUT` | override session artifacts dir |
| `BROWSE_PORT` | pin the daemon control port (default: any free port) |
| `BROWSE_WIDTH` / `BROWSE_HEIGHT` | viewport one dimension at a time (`--viewport` sets both) |
| `BROWSE_IDLE_MODE` | what to do with auto-detected static dead air: `cut` (default, drop it), `speed` (fast-forward at `BROWSE_IDLE_SPEED`), or `keep` (real time) |
| `BROWSE_IDLE_SPEED` | fast-forward factor: for `BROWSE_IDLE_MODE=speed`, and the default `N` for `browse speed` (default 10) |
| `BROWSE_FPS` | constant frame rate of the finalized mp4 (default 30) |
| `BROWSE_KEEP_WEBM=1` | keep the raw webm after the mp4 is written, so the session can be re-cut |
| `BROWSE_NET_BODIES=0` / `BROWSE_NET_BODY_MAX` | skip capturing bodies / cap bytes kept per body (default 32768) |
| `BROWSE_NET_SECRETS=1` | keep auth headers + cookies verbatim (default: values hashed to a sha256 prefix + length) |
| `BROWSE_FFMPEG` | the ffmpeg used to finalize the mp4 |
| `BROWSE_PW_BASE` | path whose parent dir holds `node_modules/playwright` |
| `BROWSE_CAMOUFOX_PYTHON` | python that can `import camoufox` (default: the `uv tool` venv, then `python3`) |
