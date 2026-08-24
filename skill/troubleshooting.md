# Troubleshooting

- **One browser per session name.** Reusing a live name keeps driving that same
  browser; `browse close` it (same `-s <name>`) to start fresh — closing a dead
  session is a safe no-op. Distinct `-s` names never share state.
- Daemon won't start → read `browsed.log` in the session dir it printed.
- A missing selector fails in ~4-12s by design and the error lists the closest
  matches from the a11y tree — use those instead of retrying blindly.
- **A selector that matches several things is a guess, and a guess under a modal
  is a guaranteed timeout.** When the match browse picks turns out to be covered
  by something else it gives up quickly and lists every match with what is on top
  of it — nearly always the dialog that just opened. Scope the selector to the
  thing you actually mean (`role=dialog >> …`) rather than raising the wait;
  waiting longer cannot uncover it.
- **A hidden twin no longer eats the action.** UIs that keep a closed dialog or
  menu mounted (Ant Design, Radix `forceMount`) leave an invisible copy of the
  same input or button earlier in the DOM. An element command acts on the first
  VISIBLE match and says so (`selector matched 2, 1 hidden - …`); when every
  match is hidden it fails saying that, rather than looking like a typo.
  `setInputFiles` is exempt — a file input is normally `display:none`.
- **A sign-in wall you did not expect ends the run.** `open`/`goto` flag a url
  that looks like one, but they only read the url — the check can miss, and it
  fires on a login page you meant to visit. If it is the app's own login and you
  have no live profile, stop and ask for a `--headful` login or a `browse state`
  file; do not drive someone's OAuth. If the redirect is infrastructure
  (`vercel.com/sso-api`, Cloudflare Access, Okta), that host is not reachable by
  you at all — report it rather than burning sessions on it.
- **An empty `text`/`snapshot` is usually hydration, not a blank page.** Both
  give a still-loading page a short settle and then say whether it stayed empty;
  if it did, check `url` and `errors` before concluding the app is broken.
- **Clicks timing out on camoufox while other camoufox sessions are running.**
  Seen at roughly 1 in 15 sessions under parallel load and never on an idle
  machine (17/18 and 16/16 clean in back-to-back runs). The locator resolves and
  `elementFromPoint` returns it, but the click never lands, and the session never
  recovers - `goto`, `eval` and `scroll` keep working, only pointer input is
  dead. Close that session and open a new one, or run it under `--chromium`;
  retrying inside the same session does not help.
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
