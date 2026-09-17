# TypeSafe decisions

Use AI when interpreting labels or distinguishing similar controls costs more
than an exact selector. Keep the surrounding task and next-step decisions in the
agent. Each command asks one narrow question about the current DOM and executes
at most one action. See `browse help` and `browse help --env` for syntax,
limits, credentials and configuration.

TypeSafe chooses only among actual enabled elements. Missing, uncertain, changed
or detached targets fail without an action. Narrow the region or inspect a
snapshot after a refusal. Rephrase with the visible label when a description is
too vague. Repeating the same request does not fix ambiguity.
Preview the selection when the intended target needs inspection before acting.
The probability threshold measures model certainty; it does not establish user
authorization or guarantee that a click has the intended business effect.

DOM labels and nearby visible text leave the browser for TypeSafe. Assertion
requests send visible text from the selected region. Scope private pages to the
minimum relevant region. Input values and the fill payload are excluded from the
model request, but a page that renders sensitive data as ordinary text can still
include it. The usual screenshots and recording show the resulting page.

Prefer deterministic assertions for exact copy, counts, network responses and
UI state. AI assertions judge visible text probabilistically; they do not inspect
pixels or establish backend success. Canvas-only controls and closed shadow DOM
need another browser primitive. Select an iframe explicitly before operating
inside it. AI fill replaces the value immediately; use regular typing commands
when paced typing is part of the recording.

Each answer includes API latency and input tokens. Compare full CLI duration,
including recording and remote artifact transfer, when judging runtime savings.
Known selectors make no model request and remain cheaper. There is no automatic
retry or cached selection: each action observes the current page.

For remote runs, the calling client reads the credential and sends it through the
existing SSH tunnel for that request. The Box needs this checkout's runtime
modules, but no dotenv upload. An image or git refresh cannot include local
uncommitted code; check the build before measuring.
