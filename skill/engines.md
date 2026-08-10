# Engines

`--camoufox` is the **default**. Camoufox is a Firefox build with fingerprint
patches applied in C++; it clears Cloudflare's JS managed challenge *headlessly*,
which Chromium cannot do at all: its new-headless is handed an unsolved
`cf_clearance`, and headed Chrome can't be hidden on macOS because
`--window-position` is clamped onto the nearest real display. If camoufox isn't
installed, browse logs it and falls back to Chromium on its own, and says so in
the `browse open` output.

Reach for `--chromium` when you need a polished demo recording (the overlays
below), `browse emulate tz= locale= cpu= net=` (CDP-only), or a `.pdf`
(`page.pdf()` is Chromium-only). Both raise a clear error under camoufox rather
than a Playwright stack trace.

Under camoufox the three init scripts browse normally injects (cursor overlay,
keystroke overlay, same-tab popup rewrite) default **off**: they are injected into
every page, and on a bot-walled site that is the difference between passing and
not. Force any back on with `--cursor`, `--keylog`, `--no-popups`.

## Log in on the engine you will drive with

A Firefox profile and a Chromium user-data dir are incompatible formats, so `-p foo`
stores two separate logins. A login made under one engine is invisible to the
other, and reads as the profile simply having lost it. `browse profiles` shows
which engine(s) each name actually holds a login under, so you can see which half
you are missing.

## Setup (one time)

`uv tool install camoufox`, then
`~/.local/share/uv/tools/camoufox/bin/python -m camoufox fetch`, then
`browse setup`.

Camoufox is built against a specific Playwright (0.5.4 → 1.60.0) and its Firefox
speaks that exact protocol, so browse loads Firefox from a pinned
`playwright-core@1.60.0` in `~/.browse/camoufox-pw` rather than the newer one it
uses for Chromium. That third step installs the pinned copy (the launcher also
installs it on its own the first time it sees camoufox).

That pinned copy is also **patched** at install time so camoufox can record at
all. Camoufox's Juggler wants a `screencastId` on every frame ack and sends frames
without a `timestamp`; stock Playwright does neither, so the ack is rejected, the
stream stalls, and the session ends with an empty video dir and a `close` that
blames ffmpeg. `browse setup` re-applies the patch whenever it is missing, and
says so if it ever stops applying.
