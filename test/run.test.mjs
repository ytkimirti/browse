#!/usr/bin/env node
// Integration coverage for `browse run`. Drives the REAL CLI against the test
// origin (test/fixture-server.mjs), asserting stdout AND exit status for both
// the success and the failure paths.
//
//   node test/run.test.mjs                       # chromium
//   BROWSE_ENGINE=camoufox node test/run.test.mjs
//
// cdp() is Chromium-only, so under camoufox the test asserts it fails loudly.

import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, "bin", "browse");
const ENGINE = process.env.BROWSE_ENGINE || "chromium";
const SESSION = `runtest-${process.pid}`;
const OUT = mkdtempSync(join(tmpdir(), "browse-run-"));

let failures = 0, checks = 0;
function check(name, ok, detail = "") {
  checks++;
  if (ok) { console.log(`  ok   ${name}`); return true; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n       ${String(detail).split("\n").join("\n       ")}` : ""}`);
  return false;
}

function browse(...args) {
  const r = spawnSync(BIN, ["-s", SESSION, ...args], {
    encoding: "utf8",
    env: { ...process.env, BROWSE_ENGINE: ENGINE, BROWSE_OUT: OUT, BROWSE_HEADFUL: "0", BROWSE_IDLE_MS: "120000" },
    timeout: 180000,
  });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
const show = (r) => `${r.code} ${r.out}\n${r.err}`;

let fixture = null, cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  try { browse("close"); } catch { /* best effort */ }
  try { fixture?.kill(); } catch { /* already gone */ }
  try { rmSync(OUT, { recursive: true, force: true }); } catch { /* best effort */ }
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(130); });

console.log(`browse run — engine ${ENGINE}, session ${SESSION}`);
let r;
try {
  fixture = spawn(process.execPath, [join(ROOT, "test", "fixture-server.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
  const BASE = await new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error("fixture server never came up")), 10000);
    fixture.stdout.on("data", (c) => {
      buf += c;
      const m = /PORT (\d+)/.exec(buf);
      if (m) { clearTimeout(t); resolve(`http://127.0.0.1:${m[1]}`); }
    });
  });

  // --- malformed commands are refused in the client, before any browser starts
  console.log("no live session");
  r = browse("run");
  check("no code exits 1", r.code === 1 && /run: needs code/.test(r.err), show(r));
  r = browse("run", "await (");
  check("code that does not parse exits 1", r.code === 1 && /run: that code does not parse/.test(r.err), show(r));
  r = browse("run", "--file", join(OUT, "missing.js"));
  check("an unreadable --file exits 1", r.code === 1 && /run: cannot read/.test(r.err), show(r));
  r = browse("run", "1", "--timeout", "soon");
  check("a bad --timeout exits 1", r.code === 1 && /--timeout wants milliseconds/.test(r.err), show(r));
  r = browse("run", "1", "--file", join(OUT, "x.js"));
  check("code and --file together exit 1", r.code === 1 && /pass code OR --file/.test(r.err), show(r));
  r = browse("run", "1", "--bogus");
  check("an unknown flag exits 1", r.code === 1 && /unknown flag '--bogus'/.test(r.err), show(r));
  r = browse("run", "1", "--timeout", "99999999999");
  check("a --timeout past the timer max exits 1", r.code === 1 && /longer than a timer can run/.test(r.err), show(r));
  writeFileSync(join(OUT, "empty.js"), "  \n");
  r = browse("run", "--file", join(OUT, "empty.js"));
  check("an empty --file exits 1", r.code === 1 && /is empty/.test(r.err), show(r));
  r = browse("run", "return 1 +");
  check("code that stops short says so", r.code === 1 && /it ends early/.test(r.err), show(r));
  r = browse("run", "1", "--dialog", "deny");
  check("a bad --dialog value exits 1", r.code === 1 && /--dialog needs a value/.test(r.err), show(r));
  r = browse("sessions");
  check("...and none of them started a browser", !r.out.includes(SESSION), r.out);

  console.log("\nlive session");
  r = browse("open", `${BASE}/`);
  check("open, exit 0", r.code === 0, show(r));
  browse("wait", "#done", "--timeout", "15000");
  const engineLine = /engine (\w+)/.exec(readFileSync(join(OUT, "browsed.log"), "utf8"));
  check(`the daemon really launched ${ENGINE}`, engineLine && engineLine[1] === ENGINE, `daemon reports '${engineLine?.[1]}'`);

  r = browse("run", "await page.title()");
  check("one expression prints its value", r.code === 0 && r.out === "mw", show(r));
  check("...and records a step screenshot", /\.png\]/.test(r.err), r.err);
  check("...whose name carries no code", !/title/i.test(r.err), r.err);
  r = browse("run", "const t = await page.title(); return t.toUpperCase()");
  check("a body prints what it returns", r.code === 0 && r.out === "MW", show(r));
  r = browse("run", "({a: 1, b: [2]})");
  check("an object prints as JSON", r.code === 0 && r.out === '{"a":1,"b":[2]}', show(r));
  r = browse("run", "new Map([[1, 2]])");
  check("what JSON loses prints inspected", r.code === 0 && /Map\(1\)/.test(r.out), show(r));
  r = browse("run", "console.log('hi', {x: 1}); return 2");
  check("console lines print before the value", r.code === 0 && r.out === 'hi { x: 1 }\n2', show(r));
  r = browse("run", "await page.locator('#out').waitFor()");
  check("a script that returns nothing says where the page is", r.code === 0 && /^ok - /.test(r.out), show(r));
  r = browse("run", "async (page) => page.title()");
  check("a function expression is called with page", r.code === 0 && r.out === "mw", show(r));
  r = browse("run", "Number('x')");
  check("NaN prints as NaN, not null", r.code === 0 && r.out === "NaN", show(r));
  r = browse("run", "console.assert(1 < 2, 'fine'); console.log('%s items', 3); console.log(page.locator('pre')); return 1");
  check("console behaves like Node's (assert, %s) and names handles",
    r.code === 0 && r.out === "3 items\n<Locator>\n1", show(r));
  r = browse("run", "console.log(new Error('oops')); return 1");
  check("console prints an Error, not {}", r.code === 0 && /Error: oops/.test(r.out), show(r));
  r = browse("run", "await page.evaluate(() => { setTimeout(() => alert('hey'), 0); }); await page.waitForTimeout(300)", "--dialog", "dismiss");
  check("--dialog is accepted on run", r.code === 0 && /dismiss/i.test(r.err + r.out), show(r));
  r = browse("run", "[NaN, {a: undefined}]");
  check("nested values JSON would lose print inspected", r.code === 0 && /NaN/.test(r.out) && /undefined/.test(r.out), show(r));
  r = browse("run", `await page.goto('${BASE}/')`);
  check("a returned Playwright handle is named, not dumped", r.code === 0 && /^ok - .*\(returned a Response\)$/.test(r.out), show(r));
  browse("wait", "#done", "--timeout", "15000");
  r = browse("run", "page.locator('pre')");
  check("...a Locator too", r.code === 0 && /\(returned a Locator\)$/.test(r.out), show(r));
  r = browse("run", "({n: await page.locator('pre').count(), all: await page.locator('pre').all()})");
  check("nested handles print as their type", r.code === 0 && r.out === '{"n":1,"all":["<Locator>"]}', show(r));
  r = browse("run", "try { await page.locator('#nope').click({timeout: 100}) } catch (e) { return e }");
  check("a caught Playwright error keeps its message", r.code === 0 && /TimeoutError/.test(r.out) && /100ms/.test(r.out), show(r));
  r = browse("run", "({m: new Map([[1, 2]])})");
  check("a nested Map prints inspected, not {}", r.code === 0 && /Map\(1\)/.test(r.out), show(r));
  r = browse("run", "const frame = 'mine'; const cdp = 2; return frame + cdp");
  check("code may declare its own frame/cdp", r.code === 0 && r.out === "mine2", show(r));
  r = browse("run", "''");
  check("an empty string is quoted, not blank", r.code === 0 && r.out === '""', show(r));

  const file = join(OUT, "script.js");
  writeFileSync(file, "const n = await page.locator('pre').count();\nreturn `pre:${n}`;\n");
  r = browse("run", "--file", file);
  check("--file runs the file", r.code === 0 && r.out === "pre:1", show(r));

  // The point of run: whatever no command wraps, e.g. a context route that
  // rewrites a real response.
  r = browse("run", "await context.route('**/api/user', async (route) => route.fulfill({json: {id: 42}}))");
  check("context.route registers", r.code === 0, show(r));
  const reloaded = [browse("reload"), browse("wait", "#done", "--timeout", "15000")];
  // Read from the DOM (#out holds what the page received), not a page global:
  // camoufox can evaluate in an isolated world that cannot see window.__r.
  r = browse("run", "JSON.parse(await page.locator('#out').textContent()).user.id");
  check("...and the page got the rewritten response", r.out === "42",
    `${show(r)}\nreload/wait: ${reloaded.map(show).join("\n")}\nnet: ${show(browse("net", "api/user", "--full"))}`);
  browse("run", "await context.unroute('**/api/user')");

  r = browse("run", "globalThis.__kept = 7");
  r = browse("run", "__kept * 2");
  check("globalThis keeps state between runs", r.code === 0 && r.out === "14", show(r));

  r = browse("run", "require('node:path').basename('/a/b.txt')");
  check("require works", r.code === 0 && r.out === "b.txt", show(r));
  r = browse("run", "typeof require('playwright').devices");
  check("...and finds browse's own Playwright", r.code === 0 && r.out === "object", show(r));

  r = browse("run", "throw new Error('kaboom')");
  check("a throw exits 1 with its message", r.code === 1 && /^browse: run: kaboom/.test(r.err), show(r));
  r = browse("run", "console.log('got this far'); await page.locator('#nope').click({timeout: 300})");
  check("a Playwright failure exits 1", r.code === 1 && /run: .*Timeout 300ms/.test(r.err), show(r));
  check("...with the console lines logged before it", /console before it failed:\s+got this far/.test(r.err), r.err);

  r = browse("run", "await new Promise((r) => setTimeout(r, 4000)); return 'late'", "--timeout", "500");
  check("a script past --timeout exits 1", r.code === 1 && /still running after 500ms/.test(r.err), show(r));
  r = browse("run", "await page.title()");
  check("...and the session still answers", r.code === 0 && r.out === "mw", show(r));

  r = browse("run", "setTimeout(() => console.log('late-line'), 50); return 1");
  check("a deferred console call does not hold the reply", r.code === 0 && r.out === "1", show(r));
  browse("wait", "300");

  // `frame` follows the `target` iframe scope.
  browse("goto", `${BASE}/ui`);
  r = browse("target", "#frame");
  check("target the iframe", r.code === 0, show(r));
  r = browse("run", "frame.url()");
  check("frame is the scoped iframe", r.code === 0 && /\/frame$/.test(r.out), show(r));
  r = browse("run", "page.url()");
  check("...while page stays the tab", r.code === 0 && /\/ui$/.test(r.out), show(r));
  browse("target", "top");
  r = browse("run", "frame.url()");
  check("with no scope, frame is the main frame", r.code === 0 && /\/ui$/.test(r.out), show(r));

  if (ENGINE === "chromium") {
    r = browse("run", "(await cdp('Runtime.evaluate', {expression: '6 * 7', returnByValue: true})).result.value");
    check("cdp() sends a raw CDP command", r.code === 0 && r.out === "42", show(r));
    r = browse("run", "const s = await cdp.session(); return typeof s.on");
    check("cdp.session() hands over the session", r.code === 0 && r.out === "function", show(r));
    r = browse("run", "await (await cdp.session()).detach()");
    check("a script may detach the session", r.code === 0, show(r));
    r = browse("run", "(await cdp('Runtime.evaluate', {expression: '1 + 1', returnByValue: true})).result.value");
    check("...and cdp() opens a fresh one after", r.code === 0 && r.out === "2", show(r));
    r = browse("emulate", "tz=UTC");
    check("...as does emulate", r.code === 0, show(r));
    r = browse("run", "await cdp('Nope.nothing')");
    check("an unknown CDP method exits 1", r.code === 1 && /run: .*Nope\.nothing/.test(r.err), show(r));
  } else {
    r = browse("run", "await cdp('Runtime.evaluate', {expression: '1'})");
    check("cdp() fails loudly off Chromium", r.code === 1 && /cdp\(\) needs CDP, which only Chromium has/.test(r.err), show(r));
  }

  r = browse("close");
  check("close, exit 0", r.code === 0 && /recording saved|closed/.test(r.out), show(r));

  const transcript = readFileSync(join(OUT, "transcript.md"), "utf8");
  check("the transcript labels run steps", /`run <code>`/.test(transcript) && /`run --file .*script\.js`/.test(transcript),
    transcript.split("\n").filter((l) => l.includes("run")).join("\n"));
  const SOURCE = ["toUpperCase", "__kept", "unroute(", "Runtime.evaluate", "throw new Error"];
  const leaked = SOURCE.filter((f) => transcript.includes(f));
  check("the transcript carries no run source", leaked.length === 0,
    transcript.split("\n").filter((l) => leaked.some((f) => l.includes(f))).join("\n"));
  const daemonLog = readFileSync(join(OUT, "browsed.log"), "utf8");
  check("console after the run returned lands in browsed.log", /run console: late-line/.test(daemonLog), "");
  check("the daemon never crashed", !/unhandled rejection|uncaught exception/i.test(daemonLog),
    daemonLog.split("\n").filter((l) => /unhandled|uncaught/i.test(l)).join("\n"));
} finally {
  cleanup();
}

console.log(`\n${checks - failures}/${checks} passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
