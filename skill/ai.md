# TypeSafe decisions

Use task mode for a goal with multiple browser interactions. It sends the goal,
current visible controls, bounded page text and action history to TypeSafe. The
model chooses one concrete action, browse executes and records it, then observes
the changed page before deciding again. The calling agent resumes when the task
finishes or stops. Help defines the commands, limits and configuration.

Describe the intended outcome and any required order. Supply text to type as
quoted literals in the goal, or named values when the content should stay out of
the model request. TypeSafe chooses among those strings; it cannot compose new
text. Quoted goal text goes to the model. Named value contents remain local,
though a page may echo them as ordinary visible text after entry.

When a reliable completion selector exists, provide it. Otherwise completion is
a model judgment over the current page and executed actions, checked separately
from choosing the next action. A partial flow, a visible submit button or a plan
to act is insufficient. Verify consequential outcomes independently when the
page does not establish them.

A stopped task preserves its executed steps, screenshots and recording. Inspect
those before resuming; already performed submissions must not be replayed. Cancel
the invoking command to stop the loop. Another command on the same browser session
is rejected while the task is running. Close the session to finalize the video.

Task mode operates on visible controls in the active tab and selected frame.
It can scroll to reveal more controls and select native dropdown options.
Select an iframe before delegating an in-frame task. Popups follow browse's
existing active-tab behavior, including its recording limitations. Use individual
commands when the flow needs a capability outside the task action set.

Use exact selectors when already known. The single-action AI commands remain
useful when the calling agent needs to decide each step itself.

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

Answers include API latency and input tokens; tasks also report action and query counts. Compare full CLI duration,
including recording and remote artifact transfer, when judging runtime savings.
Known selectors make no model request and remain cheaper. There is no automatic
retry of a failed action or cached selection: each decision observes the current page.

For remote runs, the calling client reads the credential and sends it through the
existing SSH tunnel for that request. The Box needs this checkout's runtime
modules, but no dotenv upload. An image or git refresh cannot include local
uncommitted code; check the build before measuring.
