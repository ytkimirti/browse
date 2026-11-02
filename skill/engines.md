# Engines

`--camoufox` is the **default** for headless sessions; a `--headful` window
opens as Chromium unless you name an engine, since a person is driving it. Camoufox is a Firefox build with fingerprint
patches applied in C++; it clears Cloudflare's JS managed challenge *headlessly*,
which Chromium cannot do at all: its new-headless is handed an unsolved
`cf_clearance`, and headed Chrome can't be hidden on macOS because
`--window-position` is clamped onto the nearest real display. An unavailable engine can change which saved state is accessible.
An explicit engine or a named profile must keep that identity; browse fails
startup when it cannot. Check `browse help launch` for engine selection and `browse help setup` for setup.

Reach for `--chromium` when you need `browse emulate tz= locale= cpu= net=`
or `cdp()` inside `run` (both CDP-only), or a `.pdf` (`page.pdf()` is
Chromium-only). These raise a clear error rather than a Playwright stack trace.

The cursor and keystroke overlays are on under camoufox too, so a demo records
the same on either engine. They are scripts injected into every page, though, and
on a bot-walled site that is the difference between clearing the challenge and
sitting on it forever: on a stealth run pass `--no-cursor --no-keylog`. (Camoufox
paints its own red debug pointer; browse turns that off, since it draws the real
macOS one itself.)

`eval` and `init` run in the page's own world on camoufox, as on Chromium, so
they see and patch what the site sees. A page that hooks built-ins can watch
that code run; on a stealth run prefer commands, and `snapshot`/`text` for
reads. browse's own overlays stay in camoufox's isolated world, which is where
`page.evaluate` inside `run` lands (`browse help run`).

## Log in on the engine you will drive with

A Firefox profile and a Chromium user-data dir are incompatible formats, so `-p foo`
stores two separate logins. A login made under one engine is invisible to the
other, and reads as the profile simply having lost it. `browse profiles` shows
which engine(s) each name has stored data under, so you can see which half
you are missing. A local session with no engine named reopens a profile on its
last-used half, so name the engine when both halves exist and the older one
holds the login.

## Setup (one time)

`uv tool install -U camoufox` (0.5.9 or newer), then
`~/.local/share/uv/tools/camoufox/bin/python -m camoufox fetch`, then
`browse setup`.

Camoufox's Firefox speaks the protocol of one specific Playwright (1.60.0, still
true of 0.5.9's build), so browse loads Firefox from a pinned
`playwright-core@1.60.0` in `~/.browse/camoufox-pw` rather than the newer one it
uses for Chromium. That third step installs the pinned copy (the launcher also
installs it on its own the first time it sees camoufox).

That pinned copy is also **patched** at install time so camoufox can record at
all. Camoufox's Juggler wants a `screencastId` on every frame ack and sends frames
without a `timestamp`; stock Playwright does neither, so the ack is rejected, the
stream stalls, and the session ends with an empty video dir and a `close` that
blames ffmpeg. `browse setup` re-applies the patch whenever it is missing, and
says so if it ever stops applying.
