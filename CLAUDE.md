# browse

`browse` is a deterministic agent browser CLI: the fewest commands and least context needed to drive a real browser, verify UI behavior, diagnose failures, and produce recorded proof.

## Before changing the command surface

Run `browse help` and read `browse.mjs`. Verify Playwright APIs, flags, and selector syntax against the installed package or official docs rather than recalling them.

## Product boundaries

- Commands act once and return. The calling agent owns the loop; browse has no AI of its own.
- Recording is a core capability. Every change must account for video, cursor/key overlays, step screenshots, transcripts, chapters, dead-air processing, tabs, and teardown.
- Redaction of network logs stays on by default. Credentials never surface without an explicit flag.
- Add a command only when it beats existing commands or `eval` as a primitive. Not every Playwright method needs a wrapper.
- General scripting and workflow orchestration stay in the shell.
- Keep AI decisions, extraction, scheduling, CAPTCHA services, managed credentials and cloud fleets out of scope unless the user explicitly widens it.
- Connect to remote browsers over provider-neutral CDP.
- Output stays concise and agent-readable. Machine-readable output is a separate explicit mode.

## Engineering

- No backward compatibility. Delete obsolete paths instead of adding fallbacks or migrations.
- Grow in layers: keep a working end-to-end product at every commit.
- Keep local and remote-browser concerns separate.

## Change discipline

- Every new command and every bug fix gets integration coverage, testing success and failure output including exit status.
- Test Chromium and Camoufox separately where behavior is engine-dependent; fail loudly when a feature cannot work on an engine.
- `browse help` is the only agent-facing doc; there is no skill. Agents skim it with `| head -30` or `| grep`, so the bare index opens with the working rules, and each entry leads with its usage line. Add a sentence only when an agent would otherwise get it wrong; keep `browse help` under ~60 lines.
- Update docs only for behavior that exists.
- Bounded output must say it was truncated and offer a continuation or narrower query.
