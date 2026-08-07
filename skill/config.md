# Config (env, all optional)

| Var | Meaning |
| --- | --- |
| `BROWSE_APP_URL` | default url for `browse open` (default `http://127.0.0.1:3000`) |
| `BROWSE_VIEWPORT` | recording viewport `WxH` (default `1280x800`); or set `BROWSE_WIDTH` / `BROWSE_HEIGHT` individually |
| `BROWSE_OUT` | override session artifacts dir |
| `BROWSE_HEADFUL=1` | show the browser window (still records) |
| `BROWSE_ENGINE` | `camoufox` (default) or `chromium` — see `skill/engines.md` |
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
