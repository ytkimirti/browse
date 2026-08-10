# browse

`browse` is a deterministic, agent browser CLI plus agent skill: the fewest commands and least context needed to drive a real browser, verify UI behavior, diagnose failures, and produce recorded proof.

## Before changing the command surface

Read `SKILL.md`, run `browse help`, and read `browse.mjs`. Verify Playwright APIs, flags, and selector syntax against the installed package or official docs rather than recalling them.

## Product boundaries

- Preserve the agent loop: act once, observe the result, decide the next action. `browse` is a browser primitive, not a test runner or autonomous agent.
- Recording is a core capability. Every change must account for video, cursor/key overlays, step screenshots, transcripts, chapters, dead-air processing, tabs, and teardown.
- Redaction of network logs stays on by default. Credentials never surface without an explicit flag.
- Add a command only when it beats existing commands or `eval` as a primitive. Not every Playwright method needs a wrapper.
- Composition happens in the shell. Batching, branching, loops, scripting, and workflow orchestration stay out of the CLI.
- Out of scope unless the user explicitly widens it: natural-language planning, autonomous task execution, AI extraction, scheduling, CAPTCHA services, managed credentials, cloud fleets.
- Connect to remote browsers over provider-neutral CDP.
- Output stays concise and agent-readable. Machine-readable output is a separate explicit mode.

## Engineering

- No backward compatibility. Delete obsolete paths instead of adding fallbacks or migrations.
- Grow in layers: keep a working end-to-end product at every commit.
- Keep local and remote-browser concerns separate.

## Change discipline

- Every new command and every bug fix gets integration coverage, testing success and failure output including exit status.
- Test Chromium and Camoufox separately where behavior is engine-dependent; fail loudly when a feature cannot work on an engine.
- `browse help` (and `browse help --env`) is the single source of truth for commands, flags, defaults and env vars. `SKILL.md` and `skill/*.md` carry only what help cannot state: when to reach for something, hazards, judgment. Never restate a flag, a default or a syntax rule there; point at help instead.
- Update docs only for behavior that exists.
- Bounded output must say it was truncated and offer a continuation or narrower query.
