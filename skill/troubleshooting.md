# Troubleshooting

- **One browser per session name.** Reusing a live name keeps driving that same
  browser; `browse close` it (same `-s <name>`) to start fresh — closing a dead
  session is a safe no-op. Distinct `-s` names never share state.
- Daemon won't start → read `browsed.log` in the session dir it printed.
- A missing selector fails in ~4-12s by design and the error lists the closest
  matches from the a11y tree — use those instead of retrying blindly.
- `browse` needs `node` on PATH; Playwright (+ Chromium) auto-installs on the
  first run into `<repo>/data/browse/` (one-time, ~2 min — pre-install with
  `browse setup`; delete that dir to force a reinstall). The mp4 finalize uses
  system `ffmpeg`, falling back to Playwright's bundled copy.
- The `10x` badge needs an ffmpeg built with `drawtext` (libfreetype), which
  homebrew's current bottle lacks — the region is still sped up but unlabelled, so
  it reads as a jump cut. `browse speed` warns once per session when that is the
  case; a `browse toast` before it covers the gap.
