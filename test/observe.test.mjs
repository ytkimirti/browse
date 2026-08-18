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
    check("and says no profile was selected", /no profile was selected/.test(r.out), r.out);

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
      r.code === 0 && /still empty after a \d+ms settle/.test(r.out), r.out);
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

    r = browse("net", "lab", "--type", "script");
    check("an explicit --type is never second-guessed", r.code === 0 && /lab-chunk\.js/.test(r.out), r.out);

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
