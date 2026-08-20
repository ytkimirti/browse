#!/usr/bin/env node
// Regression coverage for the argument-handling round: a command handed a flag
// with no value, or missing the data it acts on, used to SUCCEED at doing
// nothing. Drives the REAL binary against test/fixture-server.mjs and asserts
// stdout/stderr AND exit status on both paths.
//
//   node test/args.test.mjs                       # chromium
//   BROWSE_ENGINE=camoufox node test/args.test.mjs
//
// The rule: an absent value is not an empty value. `browse net --grep` (the
// pattern eaten by an empty shell variable) answering "(no matching requests)"
// at exit 0 is indistinguishable from a real empty result — and an agent
// believes it. Same for `fill <sel>` clearing a field and saying ok.
//
// The "success" half matters as much as the failure half: an explicitly WRITTEN
// empty value (`browse fill '#in' ""`, which is how you clear a field on
// purpose) must keep working, or this round trades one wrong answer for another.

import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, "bin", "browse");
const ENGINE = process.env.BROWSE_ENGINE || "chromium";
const SESSION = `argtest-${process.pid}`;
const OUT = mkdtempSync(join(tmpdir(), "browse-args-"));
// `state --save` with a BARE name lands in ~/.browse/state, which is the
// developer's real one — so the save case here writes to an absolute path in the
// scratch dir instead. (BROWSE_HOME is not an option: bin/browse resolves the
// Playwright install from it, so overriding it would trigger a fresh download.)
const STATE_FILE = join(OUT, "argtest-state.json");

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
  process.on(sig, () => { cleanup(); process.exit(130); });
}

const fails = (label, args, re) => {
  const r = browse(...args);
  check(label, r.code === 1 && re.test(r.err), `exit ${r.code} · ${r.err || r.out}`);
};
const works = (label, args, re = /.?/) => {
  const r = browse(...args);
  check(label, r.code === 0 && re.test(r.out), `exit ${r.code} · ${r.err || r.out}`);
};
const read = (expr) => browse("eval", expr).out;

console.log(`browse args — engine ${ENGINE}, session ${SESSION}`);
let BASE;
try {
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
  console.log(`origin ${BASE}\n`);

  /* ------------------------------------------------- did-you-mean (client) */
  // Every one of these was typed at a real session and cost a `browse help`
  // round trip. None of them may spawn a browser to be refused.
  console.log("an unknown command names the nearest real one");
  fails("a one-letter typo", ["clcik", "#x"], /unknown command 'clcik' — did you mean 'click'\?/);
  fails("a missing letter", ["snapsho"], /did you mean 'snapshot'\?/);
  fails("a doubled letter", ["screenshoot"], /did you mean 'screenshot'\?/);
  // Neither of these is within any safe edit distance — they are caught by
  // containment, which is the half that edit distance alone would miss.
  fails("a substring of a real command", ["shot"], /did you mean '(screen|snap)shot'\?/);
  fails("a playwright method name", ["scrollIntoView", "#x"], /did you mean 'scroll'\?/);
  // …and a word that resembles nothing gets NO suggestion. A wrong guess is
  // worse than none: it sends the next command somewhere real and wrong.
  const far = browse("xyzzy");
  check("a word like nothing gets no guess", far.code === 1 && !/did you mean/.test(far.err), far.err);

  // A suggestion has to be one that WORKS. `waitFor` matched both `wait` and
  // `waitForTimeout` by containment; first-seen handed back waitForTimeout,
  // whose argument is a NUMBER — so following the advice ran
  // `waitForTimeout(NaN)`, which resolves instantly and answers ok.
  fails("a tie goes to the shorter command", ["waitFor", "#x"], /did you mean 'wait'\?/);
  // `box`/`setup`/`install` are matched on $1 in bin/browse, so a leading -s used
  // to land them here — and the suggester answered "did you mean 'box'?" with the
  // word just typed. They now dispatch off the flag walk instead (below), but the
  // suggester must never echo its own input either way.
  for (const self of ["errors", "console"]) {
    const r = browse(self.slice(0, 2) + "zzz");
    check(`'${self.slice(0, 2)}zzz' is never told to run itself`, !new RegExp(`did you mean '${self.slice(0, 2)}zzz'`).test(r.err), r.err);
  }

  /* ---------------------------------------------- dispatch past the flags */
  // bin/browse walks past the leading flags to find the command, then dispatched
  // box/install/setup off $1 anyway — so `browse -s zz box ls` fell through to
  // browse.mjs as "unknown command 'box'".
  console.log("\nbox/setup are found past a leading flag");
  const boxDirect = spawnSync(BIN, ["box", "help"], { encoding: "utf8" });
  const boxAfterFlag = spawnSync(BIN, ["-s", "zz", "box", "help"], { encoding: "utf8" });
  check("box help works", boxDirect.status === 0 && /disposable Upstash Boxes/.test(boxDirect.stdout || ""), boxDirect.stdout);
  check("...and still works behind -s", boxAfterFlag.status === 0 && /disposable Upstash Boxes/.test(boxAfterFlag.stdout || ""),
    `exit ${boxAfterFlag.status} · ${boxAfterFlag.stdout}${boxAfterFlag.stderr}`);
  // …and a session that is literally CALLED box is still a session, not the
  // box CLI: the walk skips `-s box`, so the command is `whoami`.
  const sessionNamedBox = spawnSync(BIN, ["-s", "box", "whoami"], { encoding: "utf8" });
  check("a session named 'box' is still a session",
    sessionNamedBox.status === 0 && /^box\b/.test((sessionNamedBox.stdout || "").trim()), sessionNamedBox.stdout);

  /* ------------------------------------------------ flag placement (client) */
  // The mirror of the existing "launch flag written last" message. Every other
  // browse flag LEADS, so writing a per-command flag first is the reflex — and
  // it died as a bare "unknown flag", which points at the name, not the place.
  console.log("\na per-command flag written first names its command");
  fails("--dialog before the command", ["--dialog", "dismiss", "click", "#btn"],
    /--dialog is a command's own flag.*goes AFTER the command/s);
  fails("--full before the command", ["--full", "screenshot"], /goes AFTER the command/);
  // The message must NOT claim which command owns the flag. The word found on
  // the line is just the first command-shaped one, and `click` takes no
  // --timeout — so "a flag of click" was advice that failed on the next turn.
  const wrongOwner = browse("--timeout", "30000", "click", "#x");
  check("...and it does not claim the wrong owner",
    wrongOwner.code === 1 && !/flag of `click`/.test(wrongOwner.err), wrongOwner.err);
  // A flag that is on no list is a typo, and must still read as one.
  fails("a genuinely unknown flag stays unknown", ["--nosuchflag", "open", BASE], /unknown flag --nosuchflag/);

  /* ----------------------------------------------------------- net (client) */
  // `net` queries a log on disk, so all of this is answered with no browser.
  // --since/--last were already checked; the rest took a bare next() and a
  // missing value became `undefined`, which filters nothing and matches nothing.
  console.log("\nnet rejects a flag with no value");
  for (const f of ["--grep", "--host", "--method", "--type", "--dir", "--status"]) {
    fails(`net ${f} with nothing after it`, ["net", f], new RegExp(`net: \\${f} needs a value`));
  }
  // A malformed --status fell through to `code === Number("abc")` — false for
  // every entry — and printed "(no matching requests)" at exit 0.
  fails("net --status abc", ["net", "--status", "abc"], /--status 'abc' is not a status filter/);
  // Empty is missing, not "match everything". `--grep "$PAT"` with PAT unset
  // arrives as "", the filter is dropped, and every request in the log prints at
  // exit 0 — which reads as "these all matched the pattern".
  for (const f of ["--grep", "--host", "--method", "--type", "--dir"]) {
    fails(`net ${f} given an empty string`, ["net", f, ""], new RegExp(`net: \\${f} needs a value`));
  }
  fails("net --status names the bad term of a list", ["net", "--status", "404,zzz"], /--status 'zzz' is not a status/);

  console.log("\nlive session");
  works("open", ["open", `${BASE}/ui`], /opened/);

  // …and every --status shape the help documents still parses.
  console.log("\nthe documented --status shapes still parse");
  for (const s of ["404", "5xx", ">=400", "200-299", "200,404"]) {
    works(`net --status ${s}`, ["net", "--status", s]);
  }

  /* ------------------------------------------------------------ screenshot */
  // --sel with the selector forgotten shot the WHOLE viewport and exited 0: the
  // agent asked for one element and got a page, with nothing saying so.
  console.log("\nscreenshot --sel needs a selector");
  fails("--sel with nothing after it", ["screenshot", "--sel"], /--sel needs a selector/);
  // Worse: "--full" landed in the selector slot and burned the locator timeout
  // before failing on a selector nobody wrote.
  fails("--sel swallowing the next flag", ["screenshot", "--sel", "--full"], /--sel needs a selector/);
  // …and an EMPTY selector is missing too: `--sel "$SEL"` with SEL unset fell
  // past the element branch and shot the whole viewport at exit 0.
  fails("--sel given an empty string", ["screenshot", "empty-sel", "--sel", ""], /--sel needs a selector/);
  works("--sel with a real selector", ["screenshot", "sel-ok", "--sel", "body"], /sel-ok\.png \(body\)/);
  check("the element shot exists", existsSync(join(OUT, "sel-ok.png")));
  works("--full still works", ["screenshot", "full-ok", "--full"], /full-ok\.png/);

  /* ---------------------------------------------------- the data-arg commands */
  // These were exempt from the extra-ARG check (their trailing args are data and
  // may start with a dash), which also exempted them from having the data at
  // all. Each then succeeded at doing nothing.
  console.log("\na command with its data argument missing fails");
  browse("fill", "#in", "seeded");
  check("a field with something in it", read("document.getElementById('in').value") === "seeded");
  fails("fill with no value", ["fill", "#in"], /fill: needs a selector AND the text to type/);
  // The point of failing: the field must be UNTOUCHED. The old behaviour cleared
  // it and reported ok, so the next command read an empty field and blamed the app.
  check("...and the field is untouched", read("document.getElementById('in').value") === "seeded",
    read("document.getElementById('in').value"));
  fails("type with no text", ["type", "#in"], /type: needs a selector AND the text to type/);
  fails("selectOption with no value", ["selectOption", "#sel"], /selectOption: needs a selector AND the option value/);
  fails("setInputFiles with no path", ["setInputFiles", "#file"], /setInputFiles: needs a selector AND a file path/);
  fails("press with no key at all", ["press"], /press: needs a key/);

  // An empty value that was WRITTEN is a real instruction — clearing a field —
  // and must still work, or this trades one wrong answer for another.
  console.log("\n…but an explicitly empty value still clears");
  works("fill with an explicit \"\"", ["fill", "#in", ""], /ok/);
  // `eval` QUOTES an empty result rather than printing nothing (an empty reply is
  // indistinguishable from a command that produced no output), so `""` is what a
  // cleared field reads back as.
  check("...and the field really is empty", read("document.getElementById('in').value") === '""',
    read("document.getElementById('in').value"));

  // press keeps both of its shapes.
  console.log("\npress keeps both arities");
  works("press <key> goes to the page", ["press", "Escape"], /ok/);
  works("press <selector> <key> goes to the element", ["press", "#in", "Enter"], /ok/);
  // No Playwright key name has a space in it, so prose is a `type` that was
  // spelled `press` — a real session got a bare "Unknown key" for this.
  fails("press given prose points at type", ["press", "hello from keyboard"],
    /is not a key.*browse type/s);
  fails("press given prose with a selector keeps the selector", ["press", "#in", "some words"],
    /browse type '#in'/);
  // …and the guard reads the LAST segment of a combo, so control-plus-the-space
  // CHARACTER is still a key, not prose.
  works("a combo ending in the space character", ["press", "Control+ "], /ok/);
  works("the bare space key", ["press", " "], /ok/);
  works("an ordinary combo", ["press", "Control+Shift+P"], /ok/);

  /* ----------------------------------------------------------------- state */
  // findIndex took the FIRST of the two, so --save won and the --load was
  // silently dropped: a session that then ran as the wrong identity, with
  // nothing in the output saying the load never happened.
  console.log("\nstate does one thing at a time");
  fails("--save and --load together", ["state", "--save", "a", "--load", "b"],
    /--save and --load are separate runs/);
  // …and `state --save --clean` wrote a file literally named "--clean" and
  // reported it as saved state.
  fails("--save given a flag as its filename", ["state", "--save", "--clean"],
    /--save needs a filename - got the flag '--clean'/);
  works("--save with a real path", ["state", "--save", STATE_FILE], /saved cookies/);
  check("...and the state file is on disk", existsSync(STATE_FILE));

  /* --------------------------------------------------- multi-match reads */
  // `click` has always said "selector matched 5". The READ commands did not:
  // `browse text '.error'` on a page with three errors printed one and looked
  // like the whole answer.
  console.log("\na read that matched more than one says so");
  const multi = browse("text", "button");
  check("text names the match count", multi.code === 0 && /selector matched 5 - this is the first/.test(multi.out), multi.out);
  const one = browse("text", "#btn");
  check("...and says nothing when the selector is unique", one.code === 0 && !/selector matched/.test(one.out), one.out);
  const shotMulti = browse("screenshot", "multi", "--sel", "button");
  check("screenshot --sel names it too", shotMulti.code === 0 && /selector matched 5/.test(shotMulti.out), shotMulti.out);
  const shotOne = browse("screenshot", "one", "--sel", "#btn");
  check("...and stays quiet for a unique one", shotOne.code === 0 && !/selector matched/.test(shotOne.out), shotOne.out);

  /* ----------------------------------------------------------- emulate */
  // The worst kind of partial success: `emulate` applied each key as it walked
  // the line, so a bad key LATER on exited 1 with the earlier ones already live.
  // The caller reads a failure and believes nothing happened — while the page,
  // and everything recorded from here, is a phone in dark mode.
  console.log("\nemulate changes nothing unless the whole line is valid");
  const width = () => Number(read("innerWidth"));
  const dark = () => read("matchMedia('(prefers-color-scheme: dark)').matches");
  browse("emulate", "off");
  check("the page starts at the recording width", width() === 1280, String(width()));
  fails("a bad value after a good key", ["emulate", "viewport=390x844", "cpu=abc"],
    /emulate cpu: expected a slowdown factor >= 1/);
  check("...and the viewport never moved", width() === 1280, String(width()));
  fails("an unknown key after a good one", ["emulate", "dark=1", "bogus=2"], /unknown key 'bogus'/);
  check("...and the colour scheme never moved", dark() === "false", dark());
  // A bad IANA id used to surface as a raw CDP "Protocol error
  // (Emulation.setTimezoneOverride): Invalid timezone id".
  fails("a timezone that does not exist", ["emulate", "tz=Not/AZone"], /is not an IANA timezone/);
  // locale and dark were exempt from the validation pass, so a bad one still
  // threw at APPLY time — with the earlier keys already live, which is the whole
  // failure this split exists to remove.
  fails("a malformed locale after a good key", ["emulate", "viewport=390x844", "locale=en US"],
    /is not a BCP-47 language tag/);
  check("...and the viewport still never moved", width() === 1280, String(width()));
  fails("a dark value that is neither", ["emulate", "dark=maybe"], /emulate dark: expected 1\|0/);
  // …and the whole documented line still applies, in one go.
  works("a fully valid line applies", ["emulate", "viewport=390x844", "dark=1", "net=3g", "tz=Europe/Istanbul", "cpu=2"], /viewport=390x844/);
  check("...the viewport moved", width() === 390, String(width()));
  check("...the colour scheme moved", dark() === "true", dark());
  check("...the timezone moved", read("Intl.DateTimeFormat().resolvedOptions().timeZone") === "Europe/Istanbul",
    read("Intl.DateTimeFormat().resolvedOptions().timeZone"));
  works("off puts it all back", ["emulate", "off"], /back to default/);
  check("...width back", width() === 1280, String(width()));
  check("...scheme back", dark() === "false", dark());

  /* -------------------------------------------------------------- wait */
  // Node's timers are 32-bit. Past the max, setTimeout fires IMMEDIATELY (after
  // printing a TimeoutOverflowWarning), so `wait 99999999999` returned in under a
  // second and reported "waited 99999999999ms" at exit 0 — a wait that asserted
  // nothing, in the one command whose whole job is to assert.
  console.log("\nwait refuses a duration no timer can run");
  const huge = browse("wait", "99999999999");
  check("a bare duration past the timer max fails", huge.code === 1 && /longer than a timer can run/.test(huge.err),
    `exit ${huge.code} · ${huge.err || huge.out}`);
  // The warning is printed by the CLIENT's own request timer, before the daemon
  // is ever asked — so capping the daemon alone would still leak it into output.
  check("...with no node warning in the output", !/TimeoutOverflowWarning/.test(huge.err + huge.out), huge.err);
  const hugeFlag = browse("wait", "#btn", "--timeout", "99999999999");
  check("--timeout past the timer max fails", hugeFlag.code === 1 && /longer than a timer can run/.test(hugeFlag.err),
    `exit ${hugeFlag.code} · ${hugeFlag.err || hugeFlag.out}`);
  check("...with no node warning either", !/TimeoutOverflowWarning/.test(hugeFlag.err + hugeFlag.out), hugeFlag.err);
  works("an ordinary pause still works", ["wait", "300"], /waited 300ms/);
  works("an ordinary --timeout still works", ["wait", "#btn", "--timeout", "2000"], /visible: #btn/);
  // The same 32-bit hole was open in every navigation verb, where Node clamps the
  // timer and the navigation fails at once claiming the full duration elapsed.
  for (const nav of ["goto", "reload", "goBack"]) {
    const args = nav === "goto" ? [nav, `${BASE}/ui`, "--timeout", "99999999999"] : [nav, "--timeout", "99999999999"];
    fails(`${nav} --timeout past the timer max`, args, /longer than a timer can run/);
  }
  works("an ordinary goto --timeout still works", ["goto", `${BASE}/ui`, "--timeout", "20000"], /http/);

  /* -------------------------------------------------------------- snapshot */
  // The old fallback called page.accessibility.snapshot(), which no longer
  // exists on the pinned Playwright — so every REAL snapshot failure surfaced as
  // "Cannot read properties of undefined (reading 'snapshot')", i.e. as a browse
  // crash rather than as what actually went wrong.
  console.log("\nsnapshot");
  const snap = browse("snapshot");
  check("snapshot works", snap.code === 0 && /button "click me"/.test(snap.out), `exit ${snap.code} · ${snap.err || snap.out.slice(0, 200)}`);
  check("...and nothing reaches page.accessibility", !/reading 'snapshot'/.test(snap.err + snap.out), snap.err);

  /* ----------------------------------------------------------------- close */
  console.log("\nclose");
  const closed = browse("close", 300000);
  check("close, exit 0", closed.code === 0, `exit ${closed.code} · ${closed.err || closed.out}`);
  const log = readFileSync(join(OUT, "browsed.log"), "utf8");
  check("the daemon never crashed", !/Unhandled|UnhandledPromiseRejection/.test(log),
    log.split("\n").filter((l) => /Unhandled/.test(l)).join("\n"));
} finally {
  cleanup();
}

console.log(`\n${checks - failures}/${checks} passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
