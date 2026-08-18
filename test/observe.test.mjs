#!/usr/bin/env node
// Integration coverage for the round of fixes driven by 182 recorded sessions'
// feedback.md files: the observation commands (`console`, `wait --text`, the
// empty-read settle), `init` (addInitScript), the navigation verbs' flag
// handling, `net`'s static-asset default, the auth-wall note, per-step shot
// names, the EPIPE guard and the spawn-lock sweep.
//
//   node test/observe.test.mjs                       # chromium
//   BROWSE_ENGINE=camoufox node test/observe.test.mjs
//
// Drives the REAL binary against test/fixture-server.mjs and asserts stdout AND
// exit status on both the success and the failure path of everything added.

import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, "bin", "browse");
const ENGINE = process.env.BROWSE_ENGINE || "chromium";
const SESSION = `obstest-${process.pid}`;
const OUT = mkdtempSync(join(tmpdir(), "browse-observe-"));

let failures = 0, checks = 0;
function check(name, ok, detail = "") {
  checks++;
  if (ok) { console.log(`  ok   ${name}`); return true; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n       ${String(detail).split("\n").join("\n       ")}` : ""}`);
  return false;
}

function browse(...args) {
  let ms = 180000;
  if (typeof args[args.length - 1] === "number") ms = args.pop();
  const r = spawnSync(BIN, ["-s", SESSION, ...args], {
    encoding: "utf8",
    env: {
      ...process.env, BROWSE_ENGINE: ENGINE, BROWSE_OUT: OUT,
      BROWSE_HEADFUL: "0", BROWSE_IDLE_MS: "120000",
    },
    timeout: ms,
  });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

let fixture = null, cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  try { browse("close"); } catch { /* best effort */ }
  try { fixture?.kill(); } catch { /* already gone */ }
  try { rmSync(OUT, { recursive: true, force: true }); } catch { /* best effort */ }
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { cleanup(); process.exit(1); });
}

const PORT = await new Promise((resolve, reject) => {
  fixture = spawn(process.execPath, [join(ROOT, "test", "fixture-server.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
  fixture.stdout.setEncoding("utf8");
  fixture.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(d); if (m) resolve(Number(m[1])); });
  fixture.on("exit", (c) => reject(new Error(`fixture server exited (${c})`)));
  setTimeout(() => reject(new Error("fixture server never printed PORT")), 15000);
});
const URL_BASE = `http://127.0.0.1:${PORT}`;

console.log(`\nbrowse observe + init + nav flags (engine ${ENGINE}, port ${PORT})\n`);

try {
  /* ── navigation verbs: flags are honoured or refused, never swallowed ──── */
  console.log("navigation flags");
  {
    let r = browse("open", `${URL_BASE}/ui`);
    check("open lands on the fixture", r.code === 0 && /opened/.test(r.out), r.out + r.err);

    r = browse("goto", `${URL_BASE}/ui`, "--bogus");
    check("goto refuses an unknown flag (exit 1)", r.code === 1 && /unknown flag '--bogus'/.test(r.err), `code ${r.code} ${r.err}`);

    r = browse("goto", `${URL_BASE}/ui`, "extra");
    check("goto refuses a stray positional", r.code === 1 && /unexpected argument 'extra'/.test(r.err), `code ${r.code} ${r.err}`);

    r = browse("goto", `${URL_BASE}/ui`, "--timeout", "notanumber");
    check("goto refuses a non-numeric --timeout", r.code === 1 && /--timeout wants milliseconds/.test(r.err), `code ${r.code} ${r.err}`);

    r = browse("goto", `${URL_BASE}/ui`, "--timeout", "45000");
    check("goto accepts --timeout", r.code === 0 && /ok - /.test(r.out), `code ${r.code} ${r.out} ${r.err}`);

    r = browse("goto");
    check("goto with no url fails", r.code === 1 && /needs a url/.test(r.err), `code ${r.code} ${r.err}`);

    r = browse("reload", "--bogus");
    check("reload refuses an unknown flag", r.code === 1 && /unknown flag '--bogus'/.test(r.err), `code ${r.code} ${r.err}`);

    r = browse("reload", "--timeout", "30000");
    check("reload accepts --timeout", r.code === 0 && /ok - /.test(r.out), `code ${r.code} ${r.out} ${r.err}`);

    r = browse("goBack", "--nope");
    check("goBack refuses an unknown flag", r.code === 1 && /unknown flag '--nope'/.test(r.err), `code ${r.code} ${r.err}`);
  }

  /* ── the auth-wall note ─────────────────────────────────────────────────── */
  console.log("auth wall");
  {
    let r = browse("goto", `${URL_BASE}/auth/sign-in`);
    check("goto onto a sign-in url says so", r.code === 0 && /sign-in wall/.test(r.out), r.out + r.err);
    check("and says this context has no saved login", /no saved login/.test(r.out), r.out);
    check("…without claiming a login was checked", !/has no live login/.test(r.out), r.out);

    r = browse("goto", `${URL_BASE}/ui`);
    check("an ordinary page says nothing about auth", r.code === 0 && !/sign-in wall/.test(r.out), r.out);
  }

  /* ── per-step screenshot names carry the target ─────────────────────────── */
  console.log("step shot names");
  {
    const shots = readdirSync(join(OUT, "shots"));
    check("a goto shot is named after where it landed",
      shots.some((f) => /^step-\d+-goto-127\.0\.0\.1-\d+-ui\.png$/.test(f)),
      shots.join(" "));
    check("an open shot carries its url too",
      shots.some((f) => /^step-01-open-127\.0\.0\.1-\d+-ui\.png$/.test(f)),
      shots.join(" "));
  }

  /* ── wait --text / --not-text ───────────────────────────────────────────── */
  console.log("wait --text");
  {
    let r = browse("goto", `${URL_BASE}/lab`);
    check("lab page loads", r.code === 0, r.out + r.err);

    r = browse("wait", "#status", "--text", "complete", "--timeout", "8000");
    check("--text holds until the element says it (case-insensitive)",
      r.code === 0 && /contains "complete"/.test(r.out), `code ${r.code} ${r.out} ${r.err}`);

    r = browse("wait", "#status", "--text", "Nevergonnahappen", "--timeout", "1500");
    check("--text that never comes true exits non-zero", r.code === 1, `code ${r.code}`);
    check("…and reports what the element actually says", /it says "Complete"/.test(r.err), r.err);

    r = browse("wait", "#status", "--not-text", "Working", "--timeout", "3000");
    check("--not-text passes once the old text is gone", r.code === 0 && /no longer contains/.test(r.out), `code ${r.code} ${r.out} ${r.err}`);

    r = browse("wait", "--text", "Complete");
    check("--text without a selector fails", r.code === 1 && /needs a selector/.test(r.err), `code ${r.code} ${r.err}`);

    r = browse("wait", "#status", "--text", "a", "--not-text", "b");
    check("--text and --not-text together fail", r.code === 1 && /opposites/.test(r.err), `code ${r.code} ${r.err}`);

    r = browse("wait", "#status", "--gone", "--text", "x");
    check("--gone with --text fails", r.code === 1 && /cannot also read its text/.test(r.err), `code ${r.code} ${r.err}`);

    r = browse("wait", "#nosuchthing", "--text", "x", "--timeout", "1200");
    check("--text on an element that never appears says which it was",
      r.code === 1 && /never appeared/.test(r.err), `code ${r.code} ${r.err}`);
  }

  /* ── the assertion command must never assert nothing ────────────────────── */
  console.log("wait flag values");
  {
    let r = browse("wait", "#status", "--text");
    check("--text with no value fails instead of becoming a visibility wait",
      r.code === 1 && /--text needs a value/.test(r.err), `code ${r.code} ${r.out} ${r.err}`);

    r = browse("wait", "#status", "--not-text");
    check("--not-text with no value fails", r.code === 1 && /--not-text needs a value/.test(r.err), `code ${r.code} ${r.err}`);

    r = browse("wait", "#status", "--url");
    check("--url with no value fails", r.code === 1 && /--url needs a value/.test(r.err), `code ${r.code} ${r.err}`);

    r = browse("wait", "#status", "--timeout", "abc");
    check("--timeout with a non-number fails", r.code === 1 && /wants milliseconds/.test(r.err), `code ${r.code} ${r.err}`);
  }

  /* ── browse console ─────────────────────────────────────────────────────── */
  console.log("console");
  {
    let r = browse("console");
    check("console captures messages logged during page load",
      r.code === 0 && /lab log one/.test(r.out) && /lab warn two/.test(r.out), r.out + r.err);
    check("…with their level", /log\s+lab log one/.test(r.out) && /warning|warn/.test(r.out), r.out);

    r = browse("console", "--level", "warning");
    check("--level filters", r.code === 0 && /lab warn two/.test(r.out) && !/lab log one/.test(r.out), r.out);

    r = browse("console", "--grep", "log one");
    check("--grep filters", r.code === 0 && /lab log one/.test(r.out) && !/lab warn two/.test(r.out), r.out);

    r = browse("console", "--grep", "nothing-logged-this");
    check("no match says so and still exits 0", r.code === 0 && /no console messages matched/.test(r.out), `code ${r.code} ${r.out}`);

    r = browse("console", "--bogus");
    check("console refuses an unknown flag", r.code === 1 && /unknown argument '--bogus'/.test(r.err), `code ${r.code} ${r.err}`);

    // The level help PRINTS has to work on the engine you are on: firefox calls
    // it "warning", everyone types "warn", and an unknown level used to answer
    // "(no messages matched)" — indistinguishable from a quiet page.
    r = browse("console", "--level", "warn");
    check("--level warn matches the engine's own spelling",
      r.code === 0 && /lab warn two/.test(r.out), `code ${r.code} ${r.out}`);

    r = browse("console", "--level", "nonsense");
    check("an unknown level fails instead of looking like a quiet page",
      r.code === 1 && /is not a console level/.test(r.err), `code ${r.code} ${r.out} ${r.err}`);

    r = browse("errors");
    check("errors still shows only errors", r.code === 0 && /lab error three/.test(r.out) && !/lab log one/.test(r.out), r.out);
  }

  /* ── browse init ────────────────────────────────────────────────────────── */
  console.log("init");
  {
    let r = browse("goto", `${URL_BASE}/lab`);
    check("without an init script the page sees no global", r.code === 0, r.out + r.err);
    r = browse("text", "#seed");
    check("…so the seed slot reads 'none'", r.out === "none", r.out);

    r = browse("init", "window.__seeded = 'from-init'", "--label", "seed");
    check("init registers", r.code === 0 && /init \+#1 seed/.test(r.out), `code ${r.code} ${r.out} ${r.err}`);
    check("…and says it applies from the next navigation", /NEXT navigation/.test(r.out), r.out);

    r = browse("init");
    check("init lists what is registered", r.code === 0 && /#1\s+seed/.test(r.out), r.out);

    r = browse("goto", `${URL_BASE}/lab`);
    check("navigation after init succeeds", r.code === 0, r.out + r.err);
    r = browse("text", "#seed");
    check("the init script ran BEFORE the page's own script", r.out === "from-init", r.out);

    r = browse("reload");
    r = browse("text", "#seed");
    check("…and survives a reload", r.out === "from-init", r.out);

    r = browse("init", "this is not ) javascript");
    check("a snippet that does not parse is refused", r.code === 1 && /does not parse/.test(r.err), `code ${r.code} ${r.err}`);

    r = browse("init", "--remove", "99");
    check("removing a script that is not there fails", r.code === 1 && /no script #99/.test(r.err), `code ${r.code} ${r.err}`);

    r = browse("init", "--file", join(OUT, "definitely-missing.js"));
    check("--file with a bad path fails", r.code === 1 && /cannot read/.test(r.err), `code ${r.code} ${r.err}`);

    const initFile = join(OUT, "seed2.js");
    writeFileSync(initFile, "window.__seeded = 'from-file';\n");
    r = browse("init", "--file", initFile);
    check("--file registers", r.code === 0 && /init \+#2/.test(r.out), `code ${r.code} ${r.out} ${r.err}`);
    browse("goto", `${URL_BASE}/lab`);
    r = browse("text", "#seed");
    check("scripts run in the order they were added", r.out === "from-file", r.out);

    r = browse("init", "--clear");
    check("--clear reports how many went", r.code === 0 && /cleared 2 init scripts/.test(r.out), `code ${r.code} ${r.out}`);
    browse("goto", `${URL_BASE}/lab`);
    r = browse("text", "#seed");
    check("a cleared init script really stops running", r.out === "none", r.out);

    r = browse("init");
    check("the empty listing says so", r.code === 0 && /0 init scripts/.test(r.out), r.out);

    r = browse("init", "window.__x = 1", "--clear");
    check("--clear with a snippet is refused, not silently preferred",
      r.code === 1 && /--clear takes nothing else/.test(r.err), `code ${r.code} ${r.err}`);

    r = browse("init", "--label", "orphan");
    check("--label with nothing to name is refused", r.code === 1 && /needs one/.test(r.err), `code ${r.code} ${r.err}`);

    r = browse("init", "--remove");
    check("--remove with no # fails instead of printing the list",
      r.code === 1 && /--remove needs a value/.test(r.err), `code ${r.code} ${r.out} ${r.err}`);

    r = browse("init", "--file");
    check("--file with no path fails", r.code === 1 && /--file needs a value/.test(r.err), `code ${r.code} ${r.out} ${r.err}`);
  }

  /* ── a huge console line is cut, and says so ────────────────────────────── */
  console.log("console line cap");
  {
    browse("eval", 'console.log("X".repeat(50000)); "ok"');
    const r = browse("console", "--grep", "XXXXXXXX");
    check("one enormous line cannot dump 50KB into the caller",
      r.code === 0 && r.out.length < 8000, `${r.out.length} chars`);
    check("…and it says how much it cut", /chars, read it whole with 'browse eval'/.test(r.out), r.out.slice(0, 200));
  }

  /* ── navigation reports where it LANDED ─────────────────────────────────── */
  console.log("navigation reporting");
  {
    browse("goto", `${URL_BASE}/ui`);
    let r = browse("click", "#blank");
    check("a click that navigates reports the new url, not the old one",
      r.code === 0 && /ui\?popup=1/.test(r.out), `code ${r.code} out=${r.out} err=${r.err}`);

    // Deterministic history: /lab is entered from /ui, so back and forward both
    // have somewhere to go before the "nowhere to go" case is asked for.
    // CAMOUFOX: this firefox build ignores history navigation entirely - even an
    // in-page `history.back()` leaves the url where it was, with history.length
    // 5 - so back/forward CANNOT work there and the command now says so instead
    // of reporting a move that never happened.
    browse("goto", `${URL_BASE}/lab`);
    if (ENGINE === "camoufox") {
      r = browse("goBack");
      check("camoufox: goBack fails loudly rather than claiming it moved",
        r.code === 1 && /did not move/.test(r.err) && /goto/.test(r.err), `code ${r.code} ${r.out} ${r.err}`);
      browse("goto", `${URL_BASE}/ui`);
    } else {
      r = browse("goBack");
      check("goBack with somewhere to go works", r.code === 0 && /ok - /.test(r.out), `code ${r.code} ${r.out} ${r.err}`);

      r = browse("goForward");
      check("goForward with somewhere to go works", r.code === 0 && /ok - /.test(r.out), `code ${r.code} ${r.out} ${r.err}`);
    }

    r = browse("goForward");
    check("goForward with nowhere to go FAILS instead of reporting ok",
      r.code === 1 && /nothing to go forward to/.test(r.err), `code ${r.code} ${r.out} ${r.err}`);
  }

  /* ── an empty read settles instead of lying ─────────────────────────────── */
  console.log("empty-read settle");
  {
    let r = browse("goto", `${URL_BASE}/late`);
    check("late page loads", r.code === 0, r.out + r.err);
    r = browse("text");
    check("text waits out a body that is still filling in",
      r.code === 0 && /late content arrived/.test(r.out), r.out);

    r = browse("text", "#alwaysempty");
    check("a genuinely empty element says what browse waited for",
      r.code === 0 && /still empty after waiting [\d.]+s for load \+ content/.test(r.out), r.out);

    // The case the settle exists for: 'load' never fires inside the budget. A
    // shared deadline let waitForLoadState eat all of it and re-read zero times.
    browse("goto", `${URL_BASE}/stalled`, "--timeout", "3000");
    r = browse("text", "#box");
    check("a page whose load event never fires is still re-read",
      r.code === 0 && /arrived while loading/.test(r.out), r.out);
  }

  /* ── console: the cap drops the OLDEST, and flags are validated ──────────── */
  console.log("console cap + flag validation");
  {
    let r = browse("console", "--since");
    check("--since with no value fails", r.code === 1 && /--since needs a value/.test(r.err), `code ${r.code} ${r.err}`);

    r = browse("console", "--since", "abc");
    check("--since with a non-number fails", r.code === 1 && /wants a number/.test(r.err), `code ${r.code} ${r.err}`);

    r = browse("console", "--level");
    check("--level with no value fails", r.code === 1 && /--level needs a value/.test(r.err), `code ${r.code} ${r.err}`);

    r = browse("eval", 'for (let i = 0; i < 5200; i++) console.log("flood " + i); "ok"');
    check("flooding the console works", r.code === 0, r.out + r.err);
    browse("eval", 'console.log("AFTER-THE-CAP-MARKER"); "ok"');
    r = browse("console", "--grep", "AFTER-THE-CAP-MARKER");
    check("a message logged AFTER the cap is still readable",
      r.code === 0 && /AFTER-THE-CAP-MARKER/.test(r.out), r.out.slice(0, 400));
    check("…and the drop count is reported", /dropped past the \d+ cap/.test(r.out), r.out.slice(-200));

    r = browse("console", "--grep", "nothing-matches-this-at-all");
    check("an empty result admits what the cap already dropped",
      r.code === 0 && /already dropped past the \d+ cap/.test(r.out), r.out);

    r = browse("console", "--last", "0");
    check("--last 0 means all, like it does on net", r.code === 0 && /5\d{3} shown/.test(r.out), r.out.slice(-200));
    check("…and a clipped log keeps the NEWEST lines, saying what it cut",
      /console truncated: \d+ earlier lines cut, newest kept/.test(r.out) && /AFTER-THE-CAP-MARKER/.test(r.out), r.out.slice(0, 300));

    // NESTED on purpose: firefox renders `JSHandle@object` and chromium a
    // one-level preview (`{a: Object, list: Array(12)}`), so a shallow object
    // would pass on chromium while the data an agent logged the object FOR is
    // exactly what both engines drop.
    browse("eval", 'console.log("shape", {a: {b: {c: 7}}}, [1,2,3,4,5,6,7,8,9,10,11,12]); "ok"');
    r = browse("console", "--grep", "shape");
    check("nested object arguments come back as real JSON on both engines",
      r.code === 0 && /"c":7/.test(r.out) && /11,12/.test(r.out), r.out);
    check("…with no engine handle left in the text", !/JSHandle@/.test(r.out) && !/Array\(12\)/.test(r.out), r.out);

    // The alarm surface (errors + the inline append) must show the same text.
    r = browse("eval", 'console.error("boom", {code: 42}); "ok"');
    check("a console error's object argument is resolved inline too",
      /"code":42/.test(r.out) && !/JSHandle@/.test(r.out), r.out);
    r = browse("errors");
    check("…and in browse errors", r.code === 0 && /"code":42/.test(r.out) && !/JSHandle@/.test(r.out), r.out.slice(-300));
  }

  /* ── net hides bundle noise from a bare pattern ─────────────────────────── */
  console.log("net static assets");
  {
    browse("goto", `${URL_BASE}/lab`);
    browse("wait", "1000");
    let r = browse("net", "lab");
    check("a bare pattern shows the api call", r.code === 0 && /api\/lab/.test(r.out), r.out);
    check("…hides the chunk/css/image and says how many", /static assets? hidden \(--all-types\)/.test(r.out), r.out);
    check("…and the noise really is gone", !/lab-chunk\.js/.test(r.out) && !/lab-styles\.css/.test(r.out), r.out);

    r = browse("net", "lab", "--all-types");
    check("--all-types brings them back", r.code === 0 && /lab-chunk\.js/.test(r.out) && /lab-styles\.css/.test(r.out), r.out);
    check("…and stops claiming anything was hidden", !/static assets? hidden/.test(r.out), r.out);

    // A failing bundle is exactly what an explicit --failed/--status asks for.
    r = browse("net", "lab", "--failed");
    check("--failed switches the asset heuristic off", r.code === 0 && !/static assets? hidden/.test(r.out), r.out);

    r = browse("net", "--since", "abc");
    check("net --since with a non-number fails like console does",
      r.code === 1 && /wants a number/.test(r.err), `code ${r.code} ${r.out} ${r.err}`);

    r = browse("net", "--last");
    check("net --last with no value fails", r.code === 1 && /needs a value/.test(r.err), `code ${r.code} ${r.err}`);

    r = browse("net", "lab", "--type", "script");
    check("an explicit --type is never second-guessed", r.code === 0 && /lab-chunk\.js/.test(r.out), r.out);

    r = browse("net", "lab", "--stats");
    check("--stats says what the static filter left out",
      r.code === 0 && /static assets? matched and are NOT counted/.test(r.out), r.out);

    const rj = spawnSync(BIN, ["-s", SESSION, "net", "lab", "--json"], {
      encoding: "utf8",
      env: { ...process.env, BROWSE_ENGINE: ENGINE, BROWSE_OUT: OUT, BROWSE_HEADFUL: "0" },
      timeout: 60000,
    });
    check("--json keeps stdout machine-clean", rj.status === 0 && (rj.stdout || "").trim().split("\n").every((l) => l.startsWith("{")), (rj.stdout || "").slice(0, 200));
    check("…and warns about the hidden assets on stderr", /static assets? matched and are NOT counted/.test(rj.stderr || ""), rj.stderr);

    r = browse("net", "lab-chunk.js");
    check("a pattern that ONLY matches static assets still shows them",
      r.code === 0 && /lab-chunk\.js/.test(r.out), r.out);
    check("…and says why they were not filtered", /nothing else matched/.test(r.out), r.out);
  }

  /* ── a closed pipe is not a crash ───────────────────────────────────────── */
  console.log("EPIPE");
  {
    const r = spawnSync("/bin/sh", ["-c", `${JSON.stringify(BIN)} -s ${SESSION} net --all --full | head -2`], {
      encoding: "utf8",
      env: { ...process.env, BROWSE_ENGINE: ENGINE, BROWSE_OUT: OUT, BROWSE_HEADFUL: "0" },
      timeout: 60000,
    });
    check("piping a long log into head prints no stack trace",
      !/EPIPE|Unhandled 'error' event/.test(r.stderr || ""), r.stderr);
  }

  /* ── close ──────────────────────────────────────────────────────────────── */
  console.log("close");
  {
    const r = browse("close", 240000);
    check("close finalizes the recording", r.code === 0 && /closed/.test(r.out), r.out + r.err);
  }

  /* ── profiles: cookie pre-flight, no browser involved ───────────────────── */
  console.log("profiles cookie pre-flight");
  {
    const HOME = mkdtempSync(join(tmpdir(), "browse-obshome-"));
    const dir = join(HOME, "profiles", "seeded", "Default");
    mkdirSync(dir, { recursive: true });
    // A chromium cookie db, written the way chromium writes one: expiry in
    // microseconds since 1601. One live host, one long expired.
    const usec = (ms) => Math.round((ms + 11644473600000) * 1000);
    const sql = "create table cookies (host_key text, expires_utc integer);" +
      `insert into cookies values ('live.example.com', ${usec(Date.now() + 30 * 86400000)});` +
      `insert into cookies values ('dead.example.com', ${usec(Date.now() - 5 * 86400000)});`;
    const made = spawnSync("sqlite3", [join(dir, "Cookies"), sql], { encoding: "utf8", timeout: 20000 });
    const local = (...args) => {
      const r = spawnSync(process.execPath, [join(ROOT, "browse.mjs"), ...args], {
        encoding: "utf8",
        env: { ...process.env, BROWSE_HOME: HOME, BROWSE_OUT: join(HOME, "out"), BROWSE_SESSION: SESSION },
        timeout: 60000,
      });
      return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
    };
    if (made.status !== 0) {
      check("sqlite3 available to build the cookie fixture", false, made.stderr || "no sqlite3 on PATH");
    } else {
      let r = local("profiles");
      check("the table counts live logins", r.code === 0 && /seeded\s+chromium.*1 host logged in/.test(r.out), r.out);

      r = local("profiles", "seeded");
      check("the detail view lists the live host", r.code === 0 && /live\.example\.com\s+expires in 30d/.test(r.out), r.out);
      check("…and marks the expired one", /✗ dead\.example\.com\s+EXPIRED/.test(r.out), r.out);

      // A profile dir that exists but holds nothing must still print a row.
      mkdirSync(join(HOME, "profiles", "emptyprof"), { recursive: true });
      r = local("profiles", "emptyprof");
      check("an empty profile still names itself", r.code === 0 && /emptyprof\s+\(empty/.test(r.out), r.out);

      // A live session's newest cookies are still in memory, so an empty read
      // must say "cannot tell", not "logged out". Liveness comes from the RUN
      // FILE the daemon stamps, not from an engine lock file: Playwright's
      // chromium writes no SingletonLock at all, and firefox's .parentlock
      // outlives a clean shutdown, so the lock was wrong in both directions.
      const openDir = join(HOME, "profiles", "openprof", "Default");
      mkdirSync(openDir, { recursive: true });
      spawnSync("sqlite3", [join(openDir, "Cookies"), "create table cookies (host_key text, expires_utc integer);"], { encoding: "utf8", timeout: 20000 });
      mkdirSync(join(HOME, "run"), { recursive: true });
      writeFileSync(join(HOME, "run", "pretend.json"),
        JSON.stringify({ port: 1, pid: process.pid, out: "/tmp", profile: "openprof", engine: "chromium" }));
      r = local("profiles", "openprof");
      check("a profile a live session is driving says it cannot tell",
        r.code === 0 && /live session is driving this profile/.test(r.out), r.out);

      writeFileSync(join(HOME, "run", "pretend.json"),
        JSON.stringify({ port: 1, pid: 2147480000, out: "/tmp", profile: "openprof", engine: "chromium" }));
      r = local("profiles", "openprof");
      check("…and a DEAD session's run file does not fake that", r.code === 0 && /no cookies at all/.test(r.out), r.out);

      r = local("-p", "openprof", "--chromium", "clear");
      check("clear works once nothing live holds the profile", r.code === 0 && /cleared profile/.test(r.out), `code ${r.code} ${r.out} ${r.err}`);

      r = local("profiles", "nosuchprofile");
      check("an unknown name says so and exits 0", r.code === 0 && /no profile matching/.test(r.out), `code ${r.code} ${r.out}`);

      r = local("profiles", "seeded", "extra");
      check("profiles refuses extra arguments", r.code === 1 && /at most a profile name/.test(r.err), `code ${r.code} ${r.err}`);
    }

    /* ── a spawn lock from a dead pid is swept, not waited out ───────────── */
    const runDir = join(HOME, "run");
    mkdirSync(runDir, { recursive: true });
    const deadLock = join(runDir, "ghost.json.lock");
    writeFileSync(deadLock, "2147480000"); // a pid that cannot be running
    const liveLock = join(runDir, "mine.json.lock");
    writeFileSync(liveLock, String(process.pid));
    const r = spawnSync(process.execPath, [join(ROOT, "browse.mjs"), "sessions"], {
      encoding: "utf8",
      env: { ...process.env, BROWSE_HOME: HOME, BROWSE_OUT: join(HOME, "out") },
      timeout: 60000,
    });
    check("sessions sweeps a lock whose holder is gone", r.status === 0 && !existsSync(deadLock), r.stderr);
    check("…and leaves a live one alone", existsSync(liveLock), "live lock was deleted");
    rmSync(HOME, { recursive: true, force: true });
  }
} finally {
  cleanup();
}

console.log(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures ? 1 : 0);
