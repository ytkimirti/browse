#!/usr/bin/env node
// Integration coverage for `browse middleware`. Drives the REAL CLI against a
// throwaway origin (test/fixture-server.mjs, its own process), asserting stdout
// AND exit status for both the success and the failure paths.
//
//   node test/middleware.test.mjs                       # chromium
//   BROWSE_ENGINE=camoufox node test/middleware.test.mjs
//
// The requested engine is VERIFIED against the daemon log, because browse falls
// back to chromium when camoufox is unavailable and a silent fallback would mean
// the camoufox run tested nothing new.
//
// Artifacts land in a temp dir (BROWSE_OUT) removed at the end, and the session
// name is unique per run, so this never touches a real session.

import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, "bin", "browse");
const ENGINE = process.env.BROWSE_ENGINE || "chromium";
const SESSION = `mwtest-${process.pid}`;
const OUT = mkdtempSync(join(tmpdir(), "browse-mw-"));

let failures = 0, checks = 0;
function check(name, ok, detail = "") {
  checks++;
  if (ok) { console.log(`  ok   ${name}`); return true; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n       ${String(detail).split("\n").join("\n       ")}` : ""}`);
  return false;
}

/** Run the CLI. Returns { code, out, err } — never throws, so a failing command
 *  is an assertion about its exit status rather than a dead test run. */
function browse(...args) {
  const r = spawnSync(BIN, ["-s", SESSION, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      BROWSE_ENGINE: ENGINE,
      BROWSE_OUT: OUT,
      BROWSE_HEADFUL: "0",
      // If this run is killed before `finally`, the orphaned daemon holds a
      // headless browser for BROWSE_IDLE_MS. The 30min default is far too long
      // to leave lying around on a dev machine.
      BROWSE_IDLE_MS: "120000",
    },
    timeout: 180000,
  });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

let fixture = null;
let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  try { browse("close"); } catch { /* best effort */ }
  try { fixture?.kill(); } catch { /* already gone */ }
  try { rmSync(OUT, { recursive: true, force: true }); } catch { /* best effort */ }
}
// Ctrl-C must not leave a detached browser and a temp dir behind.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { cleanup(); process.exit(130); });
}

/** The page signals readiness with #done once every fetch AND the image have
 *  settled, so this returns the instant the page is actually done. `wait` exits
 *  non-zero if it never happens, which surfaces as a timeout rather than as a
 *  mystery value mismatch ten assertions later. */
const reloadPage = () => {
  const a = browse("reload");
  const b = browse("wait", "#done", "--timeout", "15000");
  return [a.out, a.err, b.out, b.err].join("\n");
};
/** `browse eval` output. Notes (dialogs, middleware faults) are appended to
 *  whichever command's reply is being built, so compare on the FIRST line only —
 *  a note landing a millisecond late must not break a value assertion. */
const read = (expr) => {
  const r = browse("eval", expr);
  return r.code === 0 ? r.out.split("\n")[0] : `<eval failed: ${r.code} ${r.err || r.out}>`;
};

console.log(`browse middleware — engine ${ENGINE}, session ${SESSION}`);
let r, BASE;
try {
  /* --------------------------------------------------------- test origin */
  // Inside the try, so a fixture that never comes up still runs cleanup().
  fixture = spawn(process.execPath, [join(ROOT, "test", "fixture-server.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
  BASE = await new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error("fixture server never came up")), 10000);
    fixture.stdout.on("data", (c) => {
      buf += c;
      const m = /PORT (\d+)/.exec(buf);
      if (m) { clearTimeout(t); resolve(`http://127.0.0.1:${m[1]}`); }
    });
  });
  const originHits = async () => await (await fetch(`${BASE}/__hits`)).json();
  const resetHits = async () => await (await fetch(`${BASE}/__reset`)).json();
  console.log(`origin ${BASE}\n`);

  // --- with no live session, the read-only forms must answer WITHOUT spawning
  //     a browser (which would also start a recording nobody asked for). A
  //     MALFORMED command must fail the same way either side of that line.
  console.log("no live session");
  r = browse("middleware");
  check("bare list is a no-op, exit 0", r.code === 0 && /no active browser session/.test(r.out), `${r.code} ${r.out}${r.err}`);
  r = browse("middleware", "--clear");
  check("--clear is a no-op, exit 0", r.code === 0 && /no active browser session/.test(r.out), `${r.code} ${r.out}${r.err}`);
  r = browse("middleware", "**/api/user", "--remove");
  check("--remove is a no-op, exit 0", r.code === 0 && /no active browser session/.test(r.out), `${r.code} ${r.out}${r.err}`);
  const noSessionForgotHandler = browse("middleware", "**/api/x");
  check("a malformed command exits 1 even with no session",
    noSessionForgotHandler.code === 1 && /needs a pattern AND a handler/.test(noSessionForgotHandler.err),
    `${noSessionForgotHandler.code} ${noSessionForgotHandler.err}`);
  r = browse("middleware", "--bogus");
  check("an unknown flag exits 1", r.code === 1 && /unknown flag '--bogus'/.test(r.err), `${r.code} ${r.err}`);
  // A glob is tested against the WHOLE url, so one that neither starts with a
  // wildcard nor carries a scheme can never match. It used to register happily,
  // print "middleware + /api/user" and then let every request through to the real
  // API — the mock silently not existing, with a recording that presents live
  // data as mocked. Refused in the shared parser, so it costs no browser.
  for (const bad of ["/api/user", "api/user"]) {
    r = browse("middleware", bad, "route => route.fulfill({json: {}})");
    check(`'${bad}' is refused as unmatchable`, r.code === 1 && /can never match/.test(r.err), `${r.code} ${r.err}`);
    check(`...and is told the ** spelling`, /\*\*\/api\/user/.test(r.err), r.err);
  }

  check("no browser was spawned by any of that", browse("whoami").out.includes("not running"), browse("whoami").out);

  // --- registering before `open` is the intended flow: it spawns the browser.
  console.log("\nregister");
  r = browse("middleware", "**/api/user", "route => route.fulfill({json: {id: 1, name: 'mocked'}})");
  check("mock registers, exit 0", r.code === 0 && /^middleware \+ \*\*\/api\/user/.test(r.out), `${r.code} ${r.out}${r.err}`);
  check("registration does not echo the handler", !r.out.includes("fulfill"), r.out);

  // The engine actually in use, not the one we asked for: browse falls back to
  // chromium when camoufox can't launch, and it only says so in the daemon log.
  const engineLine = /engine (\w+)/.exec(readFileSync(join(OUT, "browsed.log"), "utf8"));
  check(`the daemon really launched ${ENGINE}`, engineLine && engineLine[1] === ENGINE,
    `daemon reports engine '${engineLine ? engineLine[1] : "?"}' — a silent fallback means this run tested nothing new`);

  r = browse("middleware", "**/*.png", "route => route.abort()");
  check("block registers and reports rule count", r.code === 0 && /2 rules, this one runs first/.test(r.out), `${r.code} ${r.out}`);

  r = browse("middleware", "**/api/config", `async route => {
    const response = await route.fetch();
    const json = await response.json();
    await route.fulfill({ response, json: { ...json, debug: true } });
  }`);
  check("rewrite registers", r.code === 0 && /^middleware \+ \*\*\/api\/config/.test(r.out), `${r.code} ${r.out}${r.err}`);

  r = browse("middleware", "**/api/**", "route => { console.log('seen', route.request().url()); return route.fallback(); }");
  check("inspect+fallback registers", r.code === 0, `${r.code} ${r.out}${r.err}`);

  // --- listing
  r = browse("middleware");
  check("list shows 4 rules newest first", r.code === 0
    && /4 rules, newest first/.test(r.out)
    && r.out.indexOf("**/api/**") < r.out.indexOf("**/api/user"), `${r.code}\n${r.out}`);
  check("list never shows handler source", !/fulfill|abort|fallback\(\)|=>/.test(r.out), r.out);

  // --- the rules actually apply
  console.log("\nbehaviour");
  r = browse("open", BASE);
  check("open, exit 0", r.code === 0, `${r.code} ${r.out}${r.err}`);
  r = browse("wait", "#done", "--timeout", "20000");
  check("the page finished loading", r.code === 0, `${r.code} ${r.out}${r.err}`);

  let hits = await originHits();
  check("mock replaced the response",
    read("JSON.stringify(window.__r.user)") === '{"id":1,"name":"mocked"}', read("JSON.stringify(window.__r.user)"));
  check("the mocked request never reached the origin", hits.user === 0, JSON.stringify(hits));
  check("rewrite merged onto the real response",
    read("JSON.stringify(window.__r.config)") === '{"env":"prod","debug":true}', read("JSON.stringify(window.__r.config)"));
  check("rewrite DID reach the origin (route.fetch)", hits.config === 1, JSON.stringify(hits));
  check("fallback passed the unmatched api through",
    read("JSON.stringify(window.__r.other)") === '{"from":"server"}', read("JSON.stringify(window.__r.other)"));
  check("abort blocked the image", read("window.__pic") === "failed", read("window.__pic"));
  check("the blocked image never reached the origin", hits.pixel === 0, JSON.stringify(hits));

  r = browse("middleware");
  check("match counts are reported", /\*\*\/api\/user[ \t]+1 matched/.test(r.out), r.out);
  check("console.* from a handler lands in browsed.log",
    /middleware console\.log: seen http/.test(readFileSync(join(OUT, "browsed.log"), "utf8")),
    "no 'middleware console.log' line in browsed.log");

  // --- an intercepted request must be MARKED in the log, or an agent's own
  //     abort() reads as an organic network failure.
  r = browse("net", "/api/user", "--last", "5");
  check("intercepted requests still show in `browse net`", r.code === 0 && /\/api\/user/.test(r.out), `${r.code} ${r.out}`);
  check("`browse net` marks a mocked request", /⟨mock \*\*\/api\/user⟩/.test(r.out), r.out);
  r = browse("net", ".png", "--last", "5");
  check("`browse net` marks a blocked request", /⟨block \*\*\/\*\.png⟩/.test(r.out), r.out);
  // '**/api/**' matched this one and fell back. It was NOT altered, and marking
  // it would be the same lie as leaving a real mock unmarked.
  r = browse("net", "/api/other", "--last", "5");
  check("a fallback()'d request is NOT marked", !/⟨/.test(r.out), r.out);

  // --- rules are on the CONTEXT, so a new tab is covered too
  console.log("\nscope");
  browse("target", "new", BASE);
  browse("wait", "#done", "--timeout", "15000");
  check("the mock applies in a second tab",
    read("JSON.stringify(window.__r.user)") === '{"id":1,"name":"mocked"}', read("JSON.stringify(window.__r.user)"));
  browse("target", "close");

  // --- replacement, not duplication
  console.log("\nreplace / remove");
  r = browse("middleware", "**/api/user", "route => route.fulfill({json: {id: 2, name: 'second'}})");
  check("the same pattern says 'replaced'", r.code === 0 && /^middleware replaced \*\*\/api\/user/.test(r.out), `${r.code} ${r.out}`);
  const afterReplace = browse("middleware").out;
  check("still 4 rules, not 5", /4 rules, newest first/.test(afterReplace), afterReplace);
  reloadPage();
  check("the replacement rule is the live one",
    read("JSON.stringify(window.__r.user)") === '{"id":2,"name":"second"}', read("JSON.stringify(window.__r.user)"));

  r = browse("middleware", "**/api/user", "--remove");
  check("--remove, exit 0", r.code === 0 && r.out === "removed middleware **/api/user", `${r.code} ${r.out}`);
  await resetHits();
  reloadPage();
  check("a removed rule no longer applies (the origin serves it)",
    read("JSON.stringify(window.__r.user)") === '{"id":99,"name":"real-user"}', read("JSON.stringify(window.__r.user)"));
  check("and the origin really was hit again", (await originHits()).user === 1, JSON.stringify(await originHits()));

  // --- continue(), the fourth answer verb, with a header override
  console.log("\ncontinue");
  browse("middleware", "**/api/**", "--remove");
  browse("middleware", "**/api/user", "route => route.continue({headers: {...route.request().headers(), 'x-browse-test': 'yes'}})");
  reloadPage();
  check("continue() passes the request on to the origin",
    read("JSON.stringify(window.__r.user)") === '{"id":99,"name":"real-user"}', read("JSON.stringify(window.__r.user)"));
  r = browse("net", "/api/user", "--last", "1", "--full");
  check("continue()'s header override reached the wire", /x-browse-test: yes/.test(r.out), r.out);
  check("`browse net` marks a continue()d request", /⟨continue \*\*\/api\/user⟩/.test(r.out), r.out);
  browse("middleware", "**/api/user", "--remove");

  // --- handler shapes that must compile
  console.log("\nhandler shapes");
  for (const [label, src] of [
    ["trailing semicolon", "route => route.fallback();"],
    ["trailing line comment", "route => route.fallback() // let it through"],
    ["block body + semicolon", "route => { route.fallback(); };"],
    ["function declaration", "function h(route) { return route.fallback(); }"],
    ["async block body", "async route => { await route.fallback(); }"],
  ]) {
    r = browse("middleware", "**/api/shape", src);
    check(`compiles: ${label}`, r.code === 0, `${r.code} ${r.out}${r.err}`);
  }
  browse("middleware", "**/api/shape", "--remove");

  // A handler that answers WITHOUT awaiting is the shape everyone writes. It
  // used to fall through untouched and then kill the daemon outright.
  console.log("\nun-awaited answer");
  await resetHits();
  browse("middleware", "**/api/user", "route => { route.fulfill({json: {id: 7, via: 'no-await'}}); }");
  const saidUnawaited = reloadPage();
  check("an un-awaited fulfill() still mocks the response",
    read("JSON.stringify(window.__r.user)") === '{"id":7,"via":"no-await"}', read("JSON.stringify(window.__r.user)"));
  check("...and the origin was never hit", (await originHits()).user === 0, JSON.stringify(await originHits()));
  check("...and it is NOT reported as a pass-through",
    !/returned without calling/.test(saidUnawaited), saidUnawaited);
  check("...and the daemon is still alive", browse("whoami").out.includes("live"), browse("whoami").out);
  check("...and only one daemon was ever started",
    (readFileSync(join(OUT, "browsed.log"), "utf8").match(/starting daemon/g) || []).length === 1,
    "the daemon crashed and a later command silently spawned a replacement");
  browse("middleware", "**/api/user", "--remove");

  // --- failure paths: every one non-zero, with a message you can act on
  console.log("\nfailures");
  r = browse("middleware", "**/api/nope", "--remove");
  check("removing an unknown pattern exits 1", r.code === 1 && /nothing registered for/.test(r.err), `${r.code} ${r.err}`);

  r = browse("middleware", "**/api/x", "route => { const apiSecret = 'SEKRIT-abc123'; !!!");
  check("a handler that won't compile exits 1", r.code === 1 && /didn't compile/.test(r.err), `${r.code} ${r.err}`);
  check("...and the V8 detail is off the first line, so the transcript can't keep it",
    r.err.split("\n")[0] === "browse: middleware: that handler didn't compile.", r.err.split("\n")[0]);

  r = browse("middleware", "**/api/x", "({not: 'a function'})");
  check("a non-function handler exits 1", r.code === 1 && /expected a function expression, got object/.test(r.err), `${r.code} ${r.err}`);

  r = browse("middleware", "**/api/x");
  check("a missing handler exits 1", r.code === 1 && /needs a pattern AND a handler/.test(r.err), `${r.code} ${r.err}`);

  const afterFailures = browse("middleware").out;
  check("no failed registration leaked into the list", !afterFailures.includes("**/api/x"), afterFailures);

  // A pattern that can never match is REFUSED at registration. It used to
  // register and carry a note at exit 0, which an agent chaining on `&&` sailed
  // straight past — leaving the page on the real API while the run believed it
  // was mocked, and a recording that presents live data as mocked.
  r = browse("middleware", "/api/other", "route => route.abort()");
  check("a bare-path pattern is refused, exit 1",
    r.code === 1 && /can never match/.test(r.err), `${r.code} ${r.out}${r.err}`);
  check("...and no such rule was created", !browse("middleware").out.includes("/api/other"), browse("middleware").out);

  // A throwing handler must abort its request and REPORT, not hang the page.
  console.log("\nhandler faults");
  r = browse("middleware", "**/api/other", "route => { throw new Error('boom in handler'); }");
  check("a throwing handler registers", r.code === 0, `${r.code} ${r.out}${r.err}`);
  let said = reloadPage() + browse("url").out;
  check("the throw is reported on the next command",
    /middleware '\*\*\/api\/other' threw.*boom in handler/.test(said), said);
  check("...and says the request was aborted", /request aborted/.test(said), said);
  check("its request was aborted, not passed through",
    /fetchError/.test(read("JSON.stringify(window.__r.other)")), read("JSON.stringify(window.__r.other)"));
  const throwList = browse("middleware").out;
  check("the throw is counted in the listing",
    /\*\*\/api\/other[ \t]+\d+ matched, \d+ threw/.test(throwList), throwList);
  browse("middleware", "**/api/other", "--remove");

  // Many throws must collapse into ONE line: 50 near-identical notes would bury
  // the command's actual result and silently evict dialog/download notes.
  browse("middleware", "**/api/**", "route => { throw new Error('boom everywhere'); }");
  said = reloadPage() + browse("url").out;
  check("many throws collapse into one counted line",
    /threw on \d+ requests — last,/.test(said) && (said.match(/boom everywhere/g) || []).length <= 2, said);
  browse("middleware", "**/api/**", "--remove");

  // Throwing AFTER answering must not claim the request was aborted.
  browse("middleware", "**/api/user", "async route => { await route.fulfill({json: {id: 5}}); throw new Error('late boom'); }");
  said = reloadPage() + browse("url").out;
  check("a throw after answering does not claim an abort",
    /late boom/.test(said) && /NOT aborted/.test(said), said);
  check("...and the mock it already sent still stands",
    read("JSON.stringify(window.__r.user)") === '{"id":5}', read("JSON.stringify(window.__r.user)"));
  browse("middleware", "**/api/user", "--remove");

  // A handler that answers nothing would wedge that request until it times out —
  // it must fall through and say so instead.
  r = browse("middleware", "**/api/other", "route => { /* answers nothing */ }");
  check("a no-op handler registers", r.code === 0, `${r.code} ${r.out}${r.err}`);
  said = reloadPage() + browse("url").out;
  check("a no-op handler is reported as a pass-through",
    /returned without calling fulfill\/abort\/continue\/fallback/.test(said), said);
  check("its request went through rather than hanging",
    read("JSON.stringify(window.__r.other)") === '{"from":"server"}', read("JSON.stringify(window.__r.other)"));

  // A missing console method must not become a mystery TypeError mid-request.
  browse("middleware", "**/api/other", "--remove");
  browse("middleware", "**/api/other", "route => { console.table([{a: 1}]); console.group('g'); return route.fallback(); }");
  reloadPage();
  check("an exotic console.* method does not break the request",
    read("JSON.stringify(window.__r.other)") === '{"from":"server"}', read("JSON.stringify(window.__r.other)"));
  check("...and it was logged", /middleware console\.table/.test(readFileSync(join(OUT, "browsed.log"), "utf8")),
    "no console.table line in browsed.log");

  // --- clear
  console.log("\nclear");
  r = browse("middleware", "--clear");
  check("--clear reports the count", r.code === 0 && /^cleared \d+ middleware rules?$/.test(r.out), `${r.code} ${r.out}`);
  const afterClear = browse("middleware").out;
  check("the list is empty afterwards", afterClear === "(no middleware)", afterClear);
  r = browse("middleware", "--clear");
  check("clearing an empty list is exit 0", r.code === 0 && r.out === "(no middleware to clear)", `${r.code} ${r.out}`);
  reloadPage();
  check("nothing is intercepted after --clear",
    read("JSON.stringify(window.__r.user)") === '{"id":99,"name":"real-user"}', read("JSON.stringify(window.__r.user)"));
  check("images load again after --clear", read("window.__pic") === "loaded", read("window.__pic"));

  // --- a handler passed where the pattern belongs must not reach any artifact
  console.log("\nredaction");
  r = browse("middleware", "route => route.fulfill({json: {token: 'SEKRIT-abc123'}})");
  check("a handler given as the only arg is rejected, exit 1",
    r.code === 1 && /needs a pattern AND a handler/.test(r.err), `${r.code} ${r.err}`);
  check("...without echoing it back", !r.err.includes("SEKRIT-abc123"), r.err);

  // --- close finalizes the recording with rules still active, and discloses them
  console.log("\nclose");
  browse("middleware", "**/api/user", "route => route.fulfill({json: {plan: 'pro'}})");
  const closed = browse("close");
  check("close, exit 0", closed.code === 0, `${closed.code} ${closed.out}${closed.err}`);
  check("close still finalizes the recording with rules active",
    /recording saved/.test(closed.out) && /mp4:/.test(closed.out), closed.out);
  check("close discloses which rules were live (the mp4 shows mocked data as real)",
    /middleware rule was active during this recording/.test(closed.out) && closed.out.includes("**/api/user"), closed.out);
  check("...without the handler", !closed.out.includes("plan: 'pro'"), closed.out);
  check("the mp4 exists on disk", existsSync(join(OUT, "recording.mp4")), `no recording.mp4 in ${OUT}`);

  // --- no handler body may reach an artifact people share. Matched on
  //     fingerprints of the handlers registered above rather than on "looks like
  //     JS", so browse's own error messages (which quote an EXAMPLE handler)
  //     don't count as a leak.
  //     "boom in handler" is deliberately NOT a fingerprint: that is the
  //     exception MESSAGE, a diagnostic the agent needs, not source.
  const SOURCE_FINGERPRINTS = [
    "id: 1, name: 'mocked'", "id: 2, name: 'second'", "answers nothing",
    "route.request().url()", "debug: true", "route.fetch()", "SEKRIT-abc123",
    "plan: 'pro'", "via: 'no-await'", "=>",
  ];
  const leaks = (s) => SOURCE_FINGERPRINTS.filter((f) => s.includes(f));
  const transcript = readFileSync(join(OUT, "transcript.md"), "utf8");
  check("the transcript records middleware steps by pattern",
    /`middleware \*\*\/api\/user <handler>`/.test(transcript),
    transcript.split("\n").filter((l) => l.includes("middleware")).join("\n"));
  check("the transcript carries no handler source", leaks(transcript).length === 0, leaks(transcript).join(" · "));
  const daemonLog = readFileSync(join(OUT, "browsed.log"), "utf8");
  check("the daemon log carries no handler source", leaks(daemonLog).length === 0, leaks(daemonLog).join(" · "));
  // The exception MESSAGE has to survive for a post-mortem: the inline report is
  // shown once and then drained.
  check("a handler's exception is kept in browsed.log", /threw on .*boom in handler/.test(daemonLog),
    "no 'threw on … boom in handler' line in browsed.log");
  check("the daemon never crashed", !/unhandled rejection|uncaught exception/.test(daemonLog),
    daemonLog.split("\n").filter((l) => /unhandled|uncaught/.test(l)).join("\n"));
} finally {
  cleanup();
}

console.log(`\n${checks - failures}/${checks} passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
