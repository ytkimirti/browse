# Engines

`--camoufox` is the **default**. Camoufox is a Firefox build with
fingerprint patches applied in C++; it clears Cloudflare's JS managed challenge
*headlessly*, which Chromium cannot do at all — its new-headless is handed an
unsolved `cf_clearance`, and headed Chrome can't be hidden on macOS because
`--window-position` is clamped onto the nearest real display. If camoufox isn't
installed, browse logs it and falls back to Chromium on its own.

Setup (one time): `uv tool install camoufox`, then
`~/.local/share/uv/tools/camoufox/bin/python -m camoufox fetch`, then
`browse setup`. Camoufox is built against a specific Playwright (0.5.4 → 1.60.0)
and its Firefox speaks that exact protocol, so browse loads Firefox from a pinned
`playwright-core@1.60.0` in `~/.browse/camoufox-pw` rather than the newer one it
uses for Chromium — that third step installs the pinned copy (the launcher also
installs it on its own the first time it sees camoufox). If browse ever falls
back to Chromium it says so in the `browse open` output.

That pinned copy is also **patched** at install time so camoufox can record at
all. Camoufox's Juggler wants a `screencastId` on every frame ack and sends
frames without a `timestamp`; stock Playwright does neither, so the ack is
rejected, the stream stalls, and the session ends with an empty video dir and a
`close` that blames ffmpeg. `browse setup` re-applies the patch whenever it is
missing, and says so if it ever stops applying.

Use `--chromium` when you need:

- a polished demo recording (see below)
- `browse emulate` (timezone/locale/cpu/network) — CDP-only
- saving a `.pdf` — `page.pdf()` is Chromium-only

Both raise a clear error under camoufox rather than a Playwright stack trace.

Under camoufox the three init scripts browse normally injects (cursor overlay,
keystroke overlay, same-tab popup rewrite) default **off**: they are injected into
every page, and on a bot-walled site that is the difference between passing and
not. Force any back on with `--cursor`, `--keylog`, `--no-popups`.

## Profiles are per engine

A Firefox profile and a Chromium user-data dir are incompatible formats, so `-p foo`
stores two separate logins: `~/.browse/profiles/foo` under chromium and
`~/.browse/profiles/foo-camoufox` under camoufox. **Log in on the engine you will
drive with** — a login made under one is invisible to the other, and looks like the
profile simply lost it.

`browse profiles` folds both dirs back into one row per name and shows which
engine(s) actually hold a login, so you can see which half you are missing:

```
gcloud   chromium     9M  3w ago
stealth  camoufox    73M  4d ago
```

`browse -p foo clear` wipes both halves; `browse -p foo --camoufox clear` wipes
just that one. `-p foo-camoufox` is refused — that dir belongs to `foo`.
