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

For continuous real-time evidence, enable full-timeline recording before launch
(see `browse help --env`). It preserves startup, idle time and the ending, ignores
cut marks, and rejects speed edits. Use Chromium when fresh 30 fps motion matters;
Camoufox still supplies frames at its upstream cadence. Keep the raw video when
you need to verify the capture independently of the MP4 export.

## Toasts are for what the screen cannot show

`browse toast "<one sentence>"` shows a NOTE chip on the video. Use it SPARINGLY,
only when the viewer needs context the screen itself doesn't give: why something
matters, a caveat, what to look at in a dense screen. The cursor already shows
what you're clicking. A good demo has 0-3. Plain prose, no markdown. Prefer it
over `eval`. A toast's on-screen time survives the dead-air cut, so
`browse wait 5000` its lifetime when the viewer should finish reading before the
next action.

## Tabs

A deliberate secondary tab contributes footage while active. Switching back
continues the earlier tab's footage, and closing a secondary tab retains what
was already recorded. Popups begin excluded: inspect a consent or login screen
before choosing to include it. Recording selection applies from that moment,
so choose before the interaction that needs proof; see `browse help`.

If finalization fails, retained raw files can contain excluded popup footage.
Treat them as editing sources, not deliverables. Review the finished MP4 before
sharing; retaining raw sources deliberately also retains those excluded screens.

## Comparable stills

Match viewport, theme, data, scroll and hover state across an A/B pair. Keep the
normal viewport when capturing popups: shrinking it to crop a tooltip can flip
the tooltip's placement. Inspect the saved images, especially tall elements under
sticky headers, before claiming the layout is verified.

For short-lived states, use the screenshot condition in help to wait and capture
inside one browser command. This removes the agent round trip; it does not freeze
time. If a state can disappear during capture, use a disclosed fixture or the
recording as evidence instead of claiming a later still shows it.
