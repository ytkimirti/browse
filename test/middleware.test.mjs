#!/usr/bin/env node
// Integration coverage for `browse middleware`. Drives the REAL CLI against a
// throwaway origin (test/fixture-server.mjs, its own process), asserting stdout
// AND exit status for both the success and the failure paths.
//
//   node test/middleware.test.mjs                       # chromium
//   BROWSE_ENGINE=camoufox node test/middleware.test.mjs
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
    env: { ...process.env, BROWSE_ENGINE: ENGINE, BROWSE_OUT: OUT, BROWSE_HEADFUL: "0" },
    timeout: 180000,
  });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

/* ----------------------------------------------------------- test origin */
const fixture = spawn(process.execPath, [join(ROOT, "test", "fixture-server.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
const BASE = await new Promise((resolve, reject) => {
  let buf = "";
  const t = setTimeout(() => reject(new Error("fixture server never came up")), 10000);
  fixture.stdout.on("data", (c) => {
    buf += c;
    const m = /PORT (\d+)/.exec(buf);
    if (m) { clearTimeout(t); resolve(`http://127.0.0.1:${m[1]}`); }
  });
});
/** How many times each endpoint reached the ORIGIN — the only way to tell a
 *  mocked request (never sent) from a fetched-then-rewritten one. */
const originHits = async () => await (await fetch(`${BASE}/__hits`)).json();

/* -------------------------------------------------------------------- run */
console.log(`browse middleware — engine ${ENGINE}, session ${SESSION}, origin ${BASE}\n`);
const read = (expr) => browse("eval", expr).out;
/** Reload and wait until the page's fetches have all settled, so every read
 *  below sees the state the CURRENT set of rules produced. Returns everything
 *  the two commands printed: a middleware diagnostic is appended to whichever
 *  command happens to run after it was queued, so an assertion about one has to
 *  look at the whole window. */
const reloadPage = () => {
  const a = browse("reload"), b = browse("wait", "1500");
  return [a.out, a.err, b.out, b.err].join("\n");
};
let r;
try {
  // --- with no live session, the read-only forms must answer WITHOUT spawning
  //     a browser (which would also start a recording nobody asked for).
  console.log("no live session");
  r = browse("middleware");
  check("bare list is a no-op, exit 0", r.code === 0 && /no active browser session/.test(r.out), `${r.code} ${r.out}${r.err}`);
  r = browse("middleware", "--clear");
  check("--clear is a no-op, exit 0", r.code === 0 && /no active browser session/.test(r.out), `${r.code} ${r.out}${r.err}`);
  r = browse("middleware", "**/api/user", "--remove");
  check("--remove is a no-op, exit 0", r.code === 0 && /no active browser session/.test(r.out), `${r.code} ${r.out}${r.err}`);
  check("no browser was spawned", browse("whoami").out.includes("not running"), browse("whoami").out);

  // --- registering before `open` is the intended flow: it spawns the browser.
  console.log("\nregister");
  r = browse("middleware", "**/api/user", "route => route.fulfill({json: {id: 1, name: 'mocked'}})");
  check("mock registers, exit 0", r.code === 0 && /^middleware \+ \*\*\/api\/user/.test(r.out), `${r.code} ${r.out}${r.err}`);
  check("registration does not echo the handler", !r.out.includes("fulfill"), r.out);

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
  browse("wait", "1500");

  let hits = await originHits();
  check("mock replaced the response",
    read("JSON.stringify(window.__r.user)") === '{"id":1,"name":"mocked"}', read("JSON.stringify(window.__r.user)"));
  check("the mocked request never reached the origin", hits.user === 0, JSON.stringify(hits));
  check("rewrite merged onto the real response",
    read("JSON.stringify(window.__r.config)") === '{"env":"prod","debug":true}', read("JSON.stringify(window.__r.config)"));
  check("rewrite DID reach the origin (route.fetch)", hits.config === 1, JSON.stringify(hits));
  check("fallback passed the unmatched api through",
    read("JSON.stringify(window.__r.other)") === '{"from":"server"}', read("JSON.stringify(window.__r.other)"));
  check("abort blocked the image", read("String(window.__picFailed)") === "1", read("String(window.__picFailed)"));
  check("the blocked image never reached the origin", hits.pixel === 0, JSON.stringify(hits));

  r = browse("middleware");
  check("hit counts are reported", /\*\*\/api\/user\s+1 handled/.test(r.out), r.out);
  check("console.* from a handler lands in browsed.log",
    existsSync(join(OUT, "browsed.log")) && /middleware console\.log: seen http/.test(readFileSync(join(OUT, "browsed.log"), "utf8")),
    "no 'middleware console.log' line in browsed.log");

  // --- an intercepted request is still visible to `browse net`
  r = browse("net", "/api/user", "--last", "5");
  check("intercepted requests still show in `browse net`", r.code === 0 && /\/api\/user/.test(r.out), `${r.code} ${r.out}`);

  // --- replacement, not duplication
  console.log("\nreplace / remove");
  r = browse("middleware", "**/api/user", "route => route.fulfill({json: {id: 2, name: 'second'}})");
  check("the same pattern says 'replaced'", r.code === 0 && /^middleware replaced \*\*\/api\/user/.test(r.out), `${r.code} ${r.out}`);
  check("still 4 rules, not 5", /4 rules, newest first/.test(browse("middleware").out), browse("middleware").out);
  reloadPage();
  check("the replacement rule is the live one",
    read("JSON.stringify(window.__r.user)") === '{"id":2,"name":"second"}', read("JSON.stringify(window.__r.user)"));

  r = browse("middleware", "**/api/user", "--remove");
  check("--remove, exit 0", r.code === 0 && r.out === "removed middleware **/api/user", `${r.code} ${r.out}`);
  reloadPage();
  check("a removed rule no longer applies (the origin serves it)",
    read("JSON.stringify(window.__r.user)") === '{"id":99,"name":"real-user"}', read("JSON.stringify(window.__r.user)"));

  // --- failure paths: every one non-zero, with a message you can act on
  console.log("\nfailures");
  r = browse("middleware", "**/api/nope", "--remove");
  check("removing an unknown pattern exits 1", r.code === 1 && /nothing registered for/.test(r.err), `${r.code} ${r.err}`);

  r = browse("middleware", "**/api/x", "route => {");
  check("a handler that won't compile exits 1", r.code === 1 && /didn't compile/.test(r.err), `${r.code} ${r.err}`);

  r = browse("middleware", "**/api/x", "({not: 'a function'})");
  check("a non-function handler exits 1", r.code === 1 && /expected a function expression, got object/.test(r.err), `${r.code} ${r.err}`);

  r = browse("middleware", "**/api/x");
  check("a missing handler exits 1", r.code === 1 && /needs a handler/.test(r.err), `${r.code} ${r.err}`);

  check("no failed registration leaked into the list", !browse("middleware").out.includes("**/api/x"), browse("middleware").out);

  // A pattern that can never match is caught at registration, not after the hunt.
  r = browse("middleware", "/api/other", "route => route.abort()");
  check("a bare-path pattern warns it will never match",
    r.code === 0 && /never match. Use '\*\*\/api\/other'/.test(r.out), `${r.code} ${r.out}`);
  browse("middleware", "/api/other", "--remove");

  // A throwing handler must abort its request and REPORT, not hang the page.
  console.log("\nhandler faults");
  browse("middleware", "**/api/**", "--remove");
  r = browse("middleware", "**/api/other", "route => { throw new Error('boom in handler'); }");
  check("a throwing handler registers", r.code === 0, `${r.code} ${r.out}${r.err}`);
  let said = reloadPage() + browse("url").out;
  check("the throw is reported on the next command",
    /middleware '\*\*\/api\/other' threw.*boom in handler/.test(said), said);
  check("its request was aborted, not passed through",
    /fetchError/.test(read("JSON.stringify(window.__r.other)")), read("JSON.stringify(window.__r.other)"));
  check("the throw is counted in the listing",
    /\*\*\/api\/other\s+\d+ handled, \d+ threw/.test(browse("middleware").out), browse("middleware").out);

  // A handler that answers nothing would wedge that request until it times out —
  // it must fall through and say so instead.
  browse("middleware", "**/api/other", "--remove");
  r = browse("middleware", "**/api/other", "route => { /* answers nothing */ }");
  check("a no-op handler registers", r.code === 0, `${r.code} ${r.out}${r.err}`);
  said = reloadPage() + browse("url").out;
  check("a no-op handler is reported as a pass-through",
    /returned without calling fulfill\/abort\/continue\/fallback/.test(said), said);
  check("its request went through rather than hanging",
    read("JSON.stringify(window.__r.other)") === '{"from":"server"}', read("JSON.stringify(window.__r.other)"));

  // --- clear
  console.log("\nclear");
  r = browse("middleware", "--clear");
  check("--clear reports the count", r.code === 0 && /^cleared \d+ middleware rules?$/.test(r.out), `${r.code} ${r.out}`);
  check("the list is empty afterwards", browse("middleware").out === "(no middleware)", browse("middleware").out);
  r = browse("middleware", "--clear");
  check("clearing an empty list is exit 0", r.code === 0 && r.out === "(no middleware to clear)", `${r.code} ${r.out}`);
  reloadPage();
  check("nothing is intercepted after --clear",
    read("JSON.stringify(window.__r.user)") === '{"id":99,"name":"real-user"}', read("JSON.stringify(window.__r.user)"));
  check("images load again after --clear", read("String(window.__picFailed)") === "0", read("String(window.__picFailed)"));

  // --- no handler body may reach an artifact people share. Matched on
  //     fingerprints of the handlers registered above rather than on "looks like
  //     JS", so `browse`'s own error messages (which quote an EXAMPLE handler)
  //     don't count as a leak.
  console.log("\nredaction");
  //     ("boom in handler" is deliberately NOT a fingerprint: that is the
  //     exception MESSAGE, which is a diagnostic the agent needs, not source.)
  const SOURCE_FINGERPRINTS = [
    "id: 1, name: 'mocked'", "id: 2, name: 'second'", "answers nothing",
    "route.request().url()", "debug: true", "route.fetch()", "=>",
  ];
  const leaks = (s) => SOURCE_FINGERPRINTS.filter((f) => s.includes(f));
  const transcript = readFileSync(join(OUT, "transcript.md"), "utf8");
  check("the transcript records middleware steps by pattern",
    /`middleware \*\*\/api\/user <handler>`/.test(transcript),
    transcript.split("\n").filter((l) => l.includes("middleware")).join("\n"));
  check("the transcript carries no handler source", leaks(transcript).length === 0, leaks(transcript).join(" · "));
  const daemonLog = readFileSync(join(OUT, "browsed.log"), "utf8");
  check("the daemon log carries no handler source", leaks(daemonLog).length === 0, leaks(daemonLog).join(" · "));
  // The exception MESSAGE is a diagnostic, not source: it has to survive for a
  // post-mortem, since the inline report is shown once and then drained.
  check("a handler's exception is kept in browsed.log", /threw on .*boom in handler/.test(daemonLog),
    "no 'threw on … boom in handler' line in browsed.log");
} finally {
  browse("close");
  fixture.kill();
  rmSync(OUT, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
