# Recording craft

Read this when the video is the deliverable (a demo, walkthrough, or "show me it
working"), and read it BEFORE the session starts. For a quick check, `screenshot`
plus `errors` is enough.

## Frame size is fixed when the browser starts

Default 1280x800. If the app's bottom is clipped, or you want a phone-shaped demo,
START the session with `--viewport 1280x900` / `--viewport 390x844`. That is the
only way to record either, since `emulate viewport=` re-lays-out the page but
leaves the rest of the frame grey. A `screenshot` right after `open` catches
clipping before you record.

## Pacing

The video shows the macOS pointer gliding to elements (a pointing hand over
links/buttons), click ripples and a keystroke overlay. It is drawn at its true
macOS size; `BROWSE_CURSOR_SCALE=1.5` enlarges it when the recording will be
watched small. Pace steps naturally: a
short `browse wait 800` after key moments reads better.

Dead time while you think is cut automatically. For a long but visibly-active wait
(spinner, deploy log, progress bar), bracket it with `browse speed 10` …
`browse speed off` so the viewer still sees it happen, just faster. Never speed up
the actions you want shown, and keep captions OUTSIDE a speed region, since a
`toast` inside one is fast-forwarded along with it.

## Toasts are for what the screen cannot show

`browse toast "<one sentence>"` shows a NOTE chip on the video. Use it SPARINGLY,
only when the viewer needs context the screen itself doesn't give: why something
matters, a caveat, what to look at in a dense screen. The cursor already shows
what you're clicking. A good demo has 0-3. Plain prose, no markdown. Prefer it
over `eval`. A toast's on-screen time survives the dead-air cut, so
`browse wait 5000` its lifetime when the viewer should finish reading before the
next action.

## Tabs

Only tab 0 is recorded: a popup's time is cut from the video and a `target new`
tab is not in it at all. Park tab 0 on a STATIC page before working in another one
(motionless time there is cut; a spinner or live log is not).
