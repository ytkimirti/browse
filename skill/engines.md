# Engines

`BROWSE_ENGINE=camoufox` is the **default**. Camoufox is a Firefox build with
fingerprint patches applied in C++; it clears Cloudflare's JS managed challenge
*headlessly*, which Chromium cannot do at all — its new-headless is handed an
unsolved `cf_clearance`, and headed Chrome can't be hidden on macOS because
`--window-position` is clamped onto the nearest real display. If camoufox isn't
installed, browse logs it and falls back to Chromium on its own.

Setup (one time): `uv tool install camoufox` then
`~/.local/share/uv/tools/camoufox/bin/python -m camoufox fetch`. Camoufox is built
against a specific Playwright (0.5.4 → 1.60.0) and its Firefox speaks that exact
protocol, so browse loads Firefox from a pinned `playwright-core@1.60.0` in
`~/.browse/camoufox-pw` rather than the newer one it uses for Chromium.

Use `BROWSE_ENGINE=chromium` when you need:

- a polished demo recording (see below)
- `browse emulate` (timezone/locale/cpu/network) — CDP-only
- saving a `.pdf` — `page.pdf()` is Chromium-only

Both raise a clear error under camoufox rather than a Playwright stack trace.

Under camoufox the three init scripts browse normally injects (cursor overlay,
keystroke overlay, same-tab popup rewrite) default **off**: they are injected into
every page, and on a bot-walled site that is the difference between passing and
not. Force any back on with `BROWSE_CURSOR=1`, `BROWSE_KEYLOG=1`,
`BROWSE_POPUPS=0`.

Camoufox profiles are Firefox-format, so `-p foo` under camoufox uses
`~/.browse/profiles/foo-camoufox`, separate from the Chromium `foo`. Log in once
per engine.
