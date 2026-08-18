# Troubleshooting

- **One browser per session name.** Reusing a live name keeps driving that same
  browser; `browse close` it (same `-s <name>`) to start fresh — closing a dead
  session is a safe no-op. Distinct `-s` names never share state.
- Daemon won't start → read `browsed.log` in the session dir it printed.
- A missing selector fails in ~4-12s by design and the error lists the closest
  matches from the a11y tree — use those instead of retrying blindly.
- **A hidden twin no longer eats the action.** UIs that keep a closed dialog or
  menu mounted (Ant Design, Radix `forceMount`) leave an invisible copy of the
  same input or button earlier in the DOM. An element command acts on the first
  VISIBLE match and says so (`selector matched 2, 1 hidden - …`); when every
  match is hidden it fails saying that, rather than looking like a typo.
  `setInputFiles` is exempt — a file input is normally `display:none`.
- `browse` needs Node 18+ on PATH; Playwright auto-installs on the first run into
  `~/.browse/` and Chromium into Playwright's shared cache (one-time, ~2 min —
  pre-install with `browse setup`, which is also the repair command;
  `rm -rf ~/.browse/node_modules` forces a reinstall). `browse help` and
  `browse version` never trigger it. The mp4 finalize uses system `ffmpeg`,
  falling back to Playwright's bundled copy.
- The `10x` badge needs an ffmpeg built with `drawtext` (libfreetype), which
  homebrew's current bottle lacks — the region is still sped up but unlabelled, so
  it reads as a jump cut. `browse speed` warns once per session when that is the
  case; a `browse toast` before it covers the gap.
