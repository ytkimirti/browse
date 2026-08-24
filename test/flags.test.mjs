#!/usr/bin/env node
// Integration coverage for the LAUNCH FLAGS (--headful, --chromium/--camoufox,
// --viewport, --cursor, --keylog, --popups, --net, --type-delay, --idle) and for
// `browse profiles` / `browse -p <name> clear`, which fold a profile's two
// engine dirs back into one logical name.
//
//   node test/flags.test.mjs                       # chromium
//   BROWSE_ENGINE=camoufox node test/flags.test.mjs
//
// Most of this is client-side, so it runs against a throwaway BROWSE_HOME with
// no browser at all. The few cases that need a live daemon (a flag reaching the
// browser, a flag REFUSED because the session is already up) open one session at
// the end and close it.
//
// Asserts stdout AND exit status for both the success and the failure paths.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, "bin", "browse");
const ENGINE = process.env.BROWSE_ENGINE || "chromium";
const SESSION = `flagtest-${process.pid}`;
// Its own data home: profiles created here must not touch the real ~/.browse.
const HOME = mkdtempSync(join(tmpdir(), "browse-flags-"));
const OUT = join(HOME, "out");

let failures = 0, checks = 0;
function check(name, ok, detail = "") {
  checks++;
  if (ok) { console.log(`  ok   ${name}`); return true; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n       ${String(detail).split("\n").join("\n       ")}` : ""}`);
  return false;
}

const ENV = {
  ...process.env,
  // Deliberately NOT set: BROWSE_ENGINE / BROWSE_HEADFUL / … — several cases here
  // assert what a flag does with no env var behind it.
  BROWSE_ENGINE: undefined,
  BROWSE_OUT: OUT,
  BROWSE_SESSION: SESSION,
  BROWSE_IDLE_MS: "120000",
};

/** Run a CLIENT-ONLY command against the throwaway data home. Straight to
 *  browse.mjs, not bin/browse: a temp BROWSE_HOME has no playwright in it, and
 *  the launcher would install a fresh 400MB copy into it on every run. Nothing
 *  here touches a browser, and browse.mjs only requires playwright lazily.
 *  Never throws, so a failing command is an assertion about its exit status
 *  rather than a dead test run. */
function browse(...args) {
  const r = spawnSync(process.execPath, [join(ROOT, "browse.mjs"), ...args], {
    encoding: "utf8",
    env: { ...ENV, BROWSE_HOME: HOME },
    timeout: 180000,
  });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

/** Run a command that really starts a browser. Uses the launcher and the REAL
 *  data home, so it picks up the installed playwright + camoufox link — with a
 *  temp BROWSE_HOME, camoufox has no pinned playwright-core to load and silently
 *  falls back to chromium, which would make every --camoufox assertion vacuous.
 *  Isolation comes from the unique session name + temp BROWSE_OUT instead. */
function browseLive(...args) {
  const r = spawnSync(BIN, args, { encoding: "utf8", env: ENV, timeout: 180000 });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

/** Populate a profile dir the way a real session would, so `profiles` sees it as
 *  holding a login rather than as an empty shell. */
function seedProfile(dirName, file) {
  const dir = join(HOME, "profiles", dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), "x");
  return dir;
}

console.log(`\nbrowse flags + profiles (engine ${ENGINE}, home ${HOME})\n`);

/* ── launch flag parsing (no browser) ───────────────────────────────────── */

console.log("launch flag parsing");
{
  let r = browse("--viewport", "390", "open");
  check("--viewport rejects a malformed value", r.code === 1 && /wants WxH/.test(r.err), `${r.code} ${r.err}`);

  r = browse("--viewport");
  check("--viewport with no value fails", r.code === 1 && /got nothing/.test(r.err), `${r.code} ${r.err}`);

  r = browse("--idle", "abc", "open");
  check("--idle rejects a non-number", r.code === 1 && /milliseconds/.test(r.err), `${r.code} ${r.err}`);

  r = browse("--type-delay", "-5", "open");
  check("--type-delay rejects a negative", r.code === 1 && /milliseconds/.test(r.err), `${r.code} ${r.err}`);

  r = browse("open", "--headful");
  check("a launch flag AFTER the command is refused, not swallowed",
    r.code === 1 && /before the command/i.test(r.err), `${r.code} ${r.err}`);

  r = browse("click", "text=x", "--no-net");
  check("…on any command, naming the flag and the fix",
    r.code === 1 && r.err.includes("--no-net") && r.err.includes("browse --no-net click"), `${r.code} ${r.err}`);

  r = browse("open", "http://x", "-p", "acme");
  check("-p AFTER the command is refused, not swallowed",
    r.code === 1 && /before the command/i.test(r.err) && r.err.includes("browse -p acme open"), `${r.code} ${r.err}`);

  r = browse("url", "-s", "other");
  check("…and so is a late -s, on any command",
    r.code === 1 && r.err.includes("browse -s other url"), `${r.code} ${r.err}`);

  r = browse("click", "text=x", "--profile");
  check("…a late selector with no value still names the fix",
    r.code === 1 && r.err.includes("browse --profile <name> click"), `${r.code} ${r.err}`);

  // A typo must not reach the daemon: everything past the flag parse is sent on
  // as a command, so `--headfull` would launch a whole browser to be told it is
  // not one.
  r = browse("--nope", "open");
  check("an unknown flag is rejected client-side, no browser",
    r.code === 1 && /unknown flag --nope/.test(r.err), `${r.code} ${r.err}`);
  check("…and no daemon was started for it",
    browse("whoami").out.includes("not running"), browse("whoami").out);
}

/* ── profiles listing ───────────────────────────────────────────────────── */

console.log("\nbrowse profiles");
{
  let r = browse("profiles");
  check("empty home says so", r.code === 0 && r.out === "(no profiles yet)", `${r.code} ${r.out}`);

  seedProfile("acme", "Local State");             // chromium half
  seedProfile("acme-camoufox", "cookies.sqlite"); // camoufox half of the SAME profile
  seedProfile("solo-camoufox", "cookies.sqlite"); // camoufox only
  mkdirSync(join(HOME, "profiles", "ghost"), { recursive: true }); // dir, no data

  r = browse("profiles");
  const lines = r.out.split("\n");
  check("exit 0", r.code === 0, r.err);
  check("the -camoufox dir is NOT listed as its own profile",
    !/^\s*acme-camoufox/m.test(r.out) && !/^\s*solo-camoufox/m.test(r.out), r.out);
  check("one name, one row per engine holding a login",
    lines.some((l) => /^acme\s+camoufox\s/.test(l)) && lines.some((l) => /^\s+chromium\s/.test(l)), r.out);
  check("a camoufox-only profile shows under its logical name",
    lines.some((l) => /^solo\s+camoufox\s/.test(l)), r.out);
  check("rows carry a size and a last-used age",
    lines.some((l) => /^acme\s+camoufox\s+\d+[KMG]\s+\S/.test(l)), r.out);
  check("a dir with nothing in it reads as empty, not as a login",
    /^ghost\s+\(empty\)/m.test(r.out), r.out);
  check("the cross-engine gotcha is stated in the output",
    /per engine/.test(r.out) && /--chromium/.test(r.out), r.out);
}

/* ── reserved profile names ─────────────────────────────────────────────── */

console.log("\nreserved -camoufox suffix");
{
  const r = browse("-p", "acme-camoufox", "profiles");
  check("-p <name>-camoufox is refused (it is another profile's dir)",
    r.code === 1 && /reserved/.test(r.err) && /-p acme --camoufox/.test(r.err), `${r.code} ${r.err}`);
}

/* ── clear ──────────────────────────────────────────────────────────────── */

console.log("\nbrowse -p <name> clear");
{
  let r = browse("clear");
  check("clear with no profile fails", r.code === 1 && /needs a profile/.test(r.err), `${r.code} ${r.err}`);

  r = browse("-p", "nosuch", "clear");
  check("clearing a profile that does not exist is a no-op, exit 0",
    r.code === 0 && /no.*profile 'nosuch'/.test(r.out), `${r.code} ${r.out}`);

  // A LIVE SESSION must stop the delete — wiping the dir under a running browser
  // corrupts it. Liveness is the run file the daemon stamps with its profile,
  // engine and pid: chromium leaves no SingletonLock behind at all, and firefox's
  // .parentlock outlives a clean shutdown, so the engines' own lock files said
  // "open" for a dead profile and "free" for a live one.
  mkdirSync(join(HOME, "run"), { recursive: true });
  writeFileSync(join(HOME, "run", "acmesess.json"),
    JSON.stringify({ port: 1, pid: process.pid, out: OUT, profile: "acme", engine: "chromium" }));
  r = browse("-p", "acme", "clear");
  check("refuses while a live session is driving it", r.code === 1 && /live session is driving/.test(r.err), `${r.code} ${r.err}`);
  check("…and deletes nothing", existsSync(join(HOME, "profiles", "acme-camoufox")), "camoufox half gone");
  // Dead pid in the run file = not live, so the guard must let go again.
  writeFileSync(join(HOME, "run", "acmesess.json"),
    JSON.stringify({ port: 1, pid: 2147480000, out: OUT, profile: "acme", engine: "chromium" }));
  spawnSync("rm", [join(HOME, "profiles", "acme", "SingletonLock")]);

  r = browse("-p", "acme", "--camoufox", "clear");
  check("--camoufox clears only that half", r.code === 0 && /camoufox/.test(r.out), `${r.code} ${r.out}`);
  check("…camoufox dir gone", !existsSync(join(HOME, "profiles", "acme-camoufox")), "still there");
  check("…chromium dir untouched", existsSync(join(HOME, "profiles", "acme", "Local State")), "chromium half lost");

  seedProfile("acme-camoufox", "cookies.sqlite");
  r = browse("-p", "acme", "clear");
  check("with no engine flag, BOTH halves go", r.code === 0, `${r.code} ${r.err}`);
  check("…chromium dir gone", !existsSync(join(HOME, "profiles", "acme")), "still there");
  check("…camoufox dir gone", !existsSync(join(HOME, "profiles", "acme-camoufox")), "still there");
}

/* ── help ───────────────────────────────────────────────────────────────── */

console.log("\nversion");
{
  // The package version is a constant nobody bumps, so on its own it cannot tell
  // two builds apart, and telling them apart is the whole point: a --remote box
  // runs the browse its image was built with, which may predate every flag this
  // client accepts. The build id is a content hash, so it moves whenever the
  // code does.
  const r = browse("version");
  check("version prints a build id, exit 0", r.code === 0 && /^browse \S+ \(build [0-9a-f]{8}\)$/.test(r.out),
    `${r.code} ${r.out}`);
  check("…and it is stable across runs", browse("version").out === r.out, `${r.out} vs ${browse("version").out}`);
}

console.log("\nhelp");
{
  let r = browse("help");
  check("main help documents the launch flags",
    r.code === 0 && r.out.includes("--headful") && r.out.includes("--viewport"), `${r.code}`);
  r = browse("help", "--env");
  check("help --env lists the env-only knobs",
    r.code === 0 && r.out.includes("BROWSE_IDLE_MODE") && r.out.includes("BROWSE_NET_SECRETS") &&
    r.out.includes("BROWSE_CURSOR_SCALE"), `${r.code}`);
  check("…and maps every flag back to its env var",
    r.out.includes("BROWSE_HEADFUL") && r.out.includes("--headful"), r.out.slice(0, 200));
}

/* ── flags actually reaching the browser ────────────────────────────────── */

console.log("\nlaunch flags reach the daemon");
try {
  // --chromium/--camoufox is the one flag whose effect is legible without a
  // page: the daemon logs which engine it launched.
  const want = ENGINE;
  let r = browseLive(`--${want}`, "--no-net", "--viewport", "800x600", "open", "about:blank");
  check(`open --${want} succeeds`, r.code === 0, `${r.code} ${r.err}`);

  // The engine actually launched, not the one asked for: browse falls back to
  // chromium when camoufox can't start, and only the daemon log says so. Without
  // this, `--camoufox` "passing" could mean the flag never arrived at all.
  const log = existsSync(join(OUT, "browsed.log")) ? readFileSync(join(OUT, "browsed.log"), "utf8") : "";
  const engineLine = /engine (\w+)/.exec(log);
  check(`--${want} is what the daemon actually launched`,
    engineLine && engineLine[1] === want,
    `daemon reports engine '${engineLine ? engineLine[1] : "?"}' — either the flag did not reach it, or\n` +
    `camoufox is not usable on this machine (\`browse setup\` says which; the fetch step is\n` +
    `\`~/.local/share/uv/tools/camoufox/bin/python -m camoufox fetch\`). Either way this run\n` +
    `tested nothing camoufox-specific.`);
  check("--no-net wrote no network log", !existsSync(join(OUT, "network.jsonl")), "network.jsonl exists");

  r = browseLive("eval", "window.innerWidth + 'x' + window.innerHeight");
  check("--viewport sized the real page", r.code === 0 && r.out.includes("800x600"), `${r.code} ${r.out}${r.err}`);

  // Both overlays default ON on BOTH engines now - under camoufox they used to
  // default off, which recorded demos with no pointer and no keystrokes in them.
  r = browseLive("eval", "JSON.stringify([!!window.__browseCursor, !!window.__browseKeys])");
  check(`the cursor AND keystroke overlays are on by default on ${ENGINE}`,
    r.code === 0 && /\[true,true\]/.test(r.out.replace(/\s/g, "")), `${r.code} ${r.out}${r.err}`);
  r = browseLive("--no-cursor", "url");
  check("…and --no-cursor is still refused mid-session rather than ignored",
    r.code === 1 && /already live/.test(r.err), `${r.code} ${r.err}`);

  // The session is up now, so a launch flag can no longer be honoured.
  r = browseLive("--headful", "url");
  check("a launch flag against a LIVE session is refused, not ignored",
    r.code === 1 && /already live/.test(r.err), `${r.code} ${r.err}`);
  check("…and says how to fix it", /close/.test(r.err) && /-s <name>/.test(r.err), r.err);

  r = browseLive("url");
  check("the same command without the flag still works", r.code === 0, `${r.code} ${r.err}`);
} finally {
  browseLive("close");
}

// --no-video on the engine this run is actually testing. Whether a context takes
// recordVideo and whether page.video() answers are BOTH engine-dependent (a
// camoufox on an unpatched playwright-core takes the option and records
// nothing), so "no video was asked for and none appeared" has to be proven per
// engine rather than assumed from chromium.
console.log("\n--no-video");
try {
  const NV = `${SESSION}-novideo`;
  // Its own artifacts dir: the session above recorded into OUT, so asserting
  // "no video dir here" against that one would prove nothing.
  const NVOUT = mkdtempSync(join(tmpdir(), "browse-novid-"));
  const nv = (...args) => spawnSync(BIN, ["-s", NV, ...args], {
    encoding: "utf8", timeout: 180000,
    env: { ...ENV, BROWSE_ENGINE: ENGINE, BROWSE_OUT: NVOUT, BROWSE_HEADFUL: "0" },
  });
  let r = nv("--no-video", "open", "about:blank");
  check("a --no-video session opens", r.status === 0, `${r.status} ${r.stderr}`);
  r = nv("speed", "4");
  check("…and speed refuses rather than annotating nothing",
    r.status === 1 && /no-video/.test(r.stderr || ""), `${r.status} ${r.stderr}`);
  r = nv("close");
  check("…and close says the video was off, not that ffmpeg failed",
    r.status === 0 && /video was off/.test(r.stdout || "") && !/ffmpeg/.test(r.stdout || ""),
    `${r.status} ${r.stdout}${r.stderr}`);
  check("…and no video dir was ever made", !existsSync(join(NVOUT, "video")), NVOUT);
  check("…and no mp4 either", !existsSync(join(NVOUT, "recording.mp4")), NVOUT);
  spawnSync("rm", ["-rf", NVOUT]);
} finally {
  spawnSync("rm", ["-rf", HOME]);
}

console.log(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures ? 1 : 0);
