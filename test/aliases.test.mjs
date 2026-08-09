#!/usr/bin/env node
// Integration coverage for the retired command/flag spellings. Every removal is
// asserted TWICE: the canonical form still works (exit 0) and the removed form
// fails loudly (exit 1 with a message that names the replacement) rather than
// being silently reinterpreted as a filename or a selector.
//
//   node test/aliases.test.mjs                       # chromium
//   BROWSE_ENGINE=camoufox node test/aliases.test.mjs
//
// Nothing here is engine-dependent, but the run still VERIFIES the engine it
// asked for: a silent camoufox→chromium fallback would mean the camoufox run
// tested nothing new.
//
// Artifacts land in a temp dir (BROWSE_OUT) removed at the end, and the session
// name is unique per run, so this never touches a real session.

import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, "bin", "browse");
const ENGINE = process.env.BROWSE_ENGINE || "chromium";
const SESSION = `aliastest-${process.pid}`;
const OUT = mkdtempSync(join(tmpdir(), "browse-alias-"));

let failures = 0, checks = 0;
function check(name, ok, detail = "") {
  checks++;
  if (ok) { console.log(`  ok   ${name}`); return true; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n       ${String(detail).split("\n").join("\n       ")}` : ""}`);
  return false;
}

/** Run the CLI. Returns { code, out, err } — never throws, so a failing command
 *  is an assertion about its exit status rather than a dead test run.
 *
 *  `ms` is generous for `close` only: finalizing the recording is ffmpeg work
 *  (dead-air cut + speed regions + chapters), and a kill there returns a null
 *  exit code WITH complete stdout, which reads as a bogus assertion failure. */
function browse(...args) {
  let ms = 180000;
  if (typeof args[args.length - 1] === "number") ms = args.pop();
  const r = spawnSync(BIN, ["-s", SESSION, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      BROWSE_ENGINE: ENGINE,
      BROWSE_OUT: OUT,
      BROWSE_HEADFUL: "0",
      BROWSE_IDLE_MS: "120000",
    },
    timeout: ms,
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
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { cleanup(); process.exit(130); });
}

/** A removal is only done when the old spelling FAILS. `re` must match the
 *  message so a lucky non-zero exit from some unrelated fault can't pass. */
const gone = (label, args, re) => {
  const r = browse(...args);
  check(label, r.code === 1 && re.test(r.err), `exit ${r.code} · ${r.err || r.out}`);
};
const works = (label, args, re = /.?/) => {
  const r = browse(...args);
  check(label, r.code === 0 && re.test(r.out), `exit ${r.code} · ${r.err || r.out}`);
};

console.log(`browse aliases — engine ${ENGINE}, session ${SESSION}`);
let r, BASE;
try {
  /* --------------------------------------------------------- test origin */
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

  // --- retired COMMANDS are rejected by the client, so they must not launch a
  //     browser (which would start a recording nobody asked for).
  console.log("retired commands, no live session");
  gone("`stop` is gone, points at close", ["stop"], /'stop' was removed.*browse close/);
  gone("`quit` is gone, points at close", ["quit"], /'quit' was removed.*browse close/);
  gone("`tap` is gone, points at click", ["tap", "#x"], /'tap' was removed.*browse click/);
  gone("`video` is gone, points at dir/close", ["video"], /'video' was removed.*browse dir/);
  gone("`waitForSelector` is gone, points at wait", ["waitForSelector", "#x"], /'waitForSelector' was removed.*browse wait/);
  check("none of that spawned a browser", browse("whoami").out.includes("not running"), browse("whoami").out);
  // The retired-command table is keyed by command name, so it must not answer
  // for Object.prototype members: `browse toString` used to print native-code
  // source as if it were a replacement command.
  for (const proto of ["toString", "constructor", "hasOwnProperty"]) {
    gone(`\`${proto}\` gets the generic unknown-command hint`, [proto], /unknown command '.*' — run: browse help/);
  }

  // --- `waitForTimeout` is deliberately KEPT (undocumented): it is the single
  //     most-reached-for spelling, so rejecting it would only buy a retry.
  console.log("\nlive session");
  works("open", ["open", BASE], /./);
  works("`waitForTimeout` still works (undocumented compat)", ["waitForTimeout", "300"]);
  works("`wait <ms>` is the documented form", ["wait", "300"], /waited 300ms/);

  // --- screenshot: a removed flag must NOT become the filename.
  console.log("\nscreenshot flags");
  works("--full works", ["screenshot", "full.png", "--full"], /saved/);
  works("--sel works", ["screenshot", "sel.png", "--sel", "body"], /saved/);
  gone("--fullpage is gone", ["screenshot", "x.png", "--fullpage"], /unknown flag '--fullpage'/);
  gone("--selector is gone", ["screenshot", "x.png", "--selector", "body"], /unknown flag '--selector'/);
  gone("a single-dash typo is a flag, not a filename", ["screenshot", "-full"], /unknown flag '-full'/);
  const shots = readdirSync(OUT);
  check("no screenshot was saved under a flag-shaped name",
    !shots.some((f) => /fullpage|selector|^_?-?full$/.test(f)), shots.join(" "));

  // --- wait: a removed flag must NOT become the selector (a 10s mystery timeout).
  console.log("\nwait flags");
  works("--gone works", ["wait", "#never-exists", "--gone", "--timeout", "2000"], /^gone:/);
  works("--timeout works", ["wait", "body", "--timeout", "2000"], /^visible:/);
  gone("--hidden is gone", ["wait", "body", "--hidden"], /unknown flag '--hidden'/);
  gone("-t is gone", ["wait", "body", "-t", "2000"], /unknown flag '-t'/);

  // --- net --domain retired; -d and --host both stay (SKILL.md teaches -d).
  console.log("\nnet flags");
  works("--host works", ["net", "--host", "127.0.0.1"], /./);
  works("-d works", ["net", "-d", "127.0.0.1"], /./);
  gone("--domain is gone", ["net", "--domain", "127.0.0.1"], /unknown flag '--domain'/);

  // --- speed: the retired closers must not silently OPEN a fast-forward.
  console.log("\nspeed");
  works("`speed 4` opens a region", ["speed", "4"], /speed: 4x/);
  works("`speed off` closes it", ["speed", "off"], /back to real time/);
  for (const a of ["end", "stop", "0", "1"]) {
    gone(`\`speed ${a}\` is gone`, ["speed", a], /expected a factor >= 2, or 'off'/);
  }

  // --- emulate: one spelling per key.
  console.log("\nemulate keys");
  works("dark= works", ["emulate", "dark=1"], /dark=1/);
  works("viewport= works", ["emulate", "viewport=390x844"], /viewport=390x844/);
  works("off works", ["emulate", "off"], /back to default/);
  for (const kv of ["colorscheme=1", "scheme=1", "geolocation=41,29", "size=390x844",
                    "timezone=Europe/Istanbul", "lang=tr-TR", "network=3g"]) {
    gone(`emulate ${kv} is gone`, ["emulate", kv], /unknown key/);
  }
  gone("emulate reset is gone", ["emulate", "reset"], /unknown key 'reset'/);

  // --- close is the only closer, and it still finalizes.
  console.log("\nclose");
  const t0 = Date.now();
  r = browse("close", 600000);
  check(`close ends the session, exit 0 (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
    r.code === 0 && /\.mp4|no video|recording/i.test(r.out), `${r.code} ${r.out}${r.err}`);

  // The engine actually in use, not the one we asked for.
  const log = join(OUT, "browsed.log");
  const engineLine = existsSync(log) ? /engine (\w+)/.exec(readFileSync(log, "utf8")) : null;
  check(`the daemon really launched ${ENGINE}`, engineLine && engineLine[1] === ENGINE,
    `daemon reports engine '${engineLine ? engineLine[1] : "?"}' — a silent fallback means this run tested nothing new`);
  check("the daemon never crashed",
    existsSync(log) && !/unhandled rejection|uncaught exception/.test(readFileSync(log, "utf8")),
    existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => /unhandled|uncaught/.test(l)).join("\n") : "no browsed.log");

  // --- help must not advertise anything that was just removed.
  console.log("\nhelp");
  const help = browse("help").out;
  for (const s of ["browse video", "browse tap", "--fullpage", "--selector", "--hidden", "--domain"]) {
    check(`help no longer mentions ${s}`, !help.includes(s), s);
  }
  check("help still documents the keepers",
    ["browse close", "--full", "--sel", "--gone", "--host", "speed"].every((s) => help.includes(s)), help.slice(0, 400));
} finally {
  cleanup();
}

console.log(`\n${checks - failures}/${checks} passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
