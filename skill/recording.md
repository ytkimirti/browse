# Recording craft

Read this when the video is the deliverable (a demo, walkthrough, or "show me it
working"). For a quick check, `screenshot` + `errors` is enough.

## Frame size

Fixed when the browser starts. Default 1280x800. If the app's bottom is clipped,
or you want a phone-shaped demo, START the session with `BROWSE_VIEWPORT=1280x900`
/ `=390x844` — the only way to record either, since `emulate viewport=` re-lays-out
the page but leaves the rest of the frame grey. A `screenshot` right after `open`
catches clipping before you record.

## Pacing

The video shows an animated cursor gliding to elements (a pointing hand over
links/buttons), click ripples and a keystroke overlay. Pace steps naturally — a
short `browse wait 800` after key moments reads better.

Dead time while you think is CUT automatically (≥2s with no on-screen change).
For a long but visibly-active wait (spinner, deploy log, progress bar), bracket it
with `browse speed 10` … `browse speed off` so the viewer still sees it happen,
just faster (badged `10x`). Don't speed up the actions you want shown.

## Toasts

`browse toast "<one sentence>"` shows a NOTE chip on the video. Use it SPARINGLY —
only when the viewer needs context the screen itself doesn't give (why something
matters, a caveat, what to look at in a dense screen). The cursor already shows
what you're clicking. A good demo has 0–3. Plain prose, no markdown. Prefer it
over `eval`.

They auto-dismiss after ~reading time (`--for <sec>`, `--sticky` + `--clear` to
pin one) and their on-screen time survives the dead-air cut, so `browse wait 5000`
their lifetime when the viewer should finish reading first.

## Tabs

Only tab 0 is recorded: a popup's time is cut from the video and a `target new`
tab is not in it at all. Park tab 0 on a STATIC page before working in another one
(motionless time there is cut; a spinner or live log is not).

## Finalize

On `close`, ffmpeg trims the blank white lead-in/out, cuts static dead air,
fast-forwards `speed` regions with an `n×` badge pinned top-right, and writes a
shareable `recording.mp4` with a chapter per acting command (observation commands
get none, and chapters closer than 0.25s merge into `first (+N more)`) plus
`poster.jpg`. A `toast` shown inside a `speed` region is fast-forwarded with it,
so put captions outside the region. The temp
raw webm in `video/` is deleted once the mp4 exists (kept with `--keep-raw`).
