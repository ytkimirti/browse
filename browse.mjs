#!/usr/bin/env node
/**
 * browse — drive a REAL Chromium browser step by step from the command line and
 * record the whole session AUTOMATICALLY (video + transcript + screenshots).
 *
 * Local port of the Upstash agent's in-box `browse` tool (agent repo,
 * snapshot/browse.mjs), adapted for a single machine:
 *   • artifacts land in a per-session dir under ~/.browse/sessions/<stamp>/
 *   • on `close`, ffmpeg (if installed) trims the dead white lead-in/out, CUTS
 *     static "agent thinking" dead air (no on-screen change for >= 2s) out of the
 *     clip entirely, and — for regions the agent brackets with `browse speed <n>`
 *     … `browse speed off` — fast-forwards that stretch at n× (badged "n×" in the
 *     top-right) instead of cutting, so a visibly-progressing wait still shows.
 *     It writes a shareable recording.mp4 (this replaces the box's Mux upload
 *     step). The temp raw .webm is deleted once the mp4 is written; it survives
 *     only as fallback when ffmpeg is missing/fails
 *   • the daemon auto-closes after 30 min idle so a forgotten session doesn't
 *     leave Chromium running forever
 *   • named sessions run in PARALLEL without conflicting (one daemon + Chromium
 *     each): `browse -s <name> <cmd>` / BROWSE_SESSION=<name>. A daemon binds a
 *     free port and publishes it in ~/.browse/run/<name>.json; clients look
 *     their session's daemon up by name there
 *
 * One file, two modes:
 *   • client (default) — `browse goto http://…`, `browse snapshot`,
 *       `browse click "text=Sign up"` … : connects to the daemon (spawning it if
 *       needed), forwards the command, prints the result, exits.
 *   • daemon (`browse __serve`) — holds ONE persistent Chromium context created
 *       with `recordVideo` (so the whole session becomes a .webm) + one page,
 *       exposes a tiny localhost HTTP control port, and appends every action to a
 *       markdown transcript + a per-step screenshot.
 *
 * The subcommands MIRROR Playwright's page API — goto/click/dblclick/fill/type/
 * press/check/uncheck/hover/selectOption/focus/reload/goBack/goForward — plus
 * observation helpers (snapshot/text/title/url/content/errors/screenshot/eval)
 * and one `wait` verb. Selectors are Playwright selector strings
 * (text=, role=…[name="…"], css, xpath=…), so there is nothing new to learn.
 *
 * Layout (github.com/ytkimirti/browse):
 *   <repo>/browse.mjs                this file (+ SKILL.md next to it)
 *   <repo>/bin/browse                launcher (symlink it onto your PATH) —
 *                                    installs deps on first run and points
 *                                    BROWSE_PW_BASE at the data home
 *   ~/.browse/                       runtime data home (BROWSE_HOME). NOTHING
 *                                    browse owns lives in the clone:
 *   ~/.browse/node_modules/          the playwright npm package (browser
 *                                    binaries go to playwright's own shared
 *                                    cache, ~/Library/Caches/ms-playwright)
 *   ~/.browse/camoufox-pw/           playwright-core pinned to camoufox's build,
 *                                    patched by the launcher so camoufox can
 *                                    record video (see bin/browse)
 *   ~/.browse/sessions/<stamp>/      transcript.md, recording.mp4, feedback.md,
 *                                    browsed.log, shots/step-*.png (video/*.webm
 *                                    only while live)
 *   ~/.browse/{profiles,state,run}/  persistent logins, saved auth, live daemons
 *
 * Config (all optional). The knobs you reach for by hand are LAUNCH FLAGS —
 * --headful, --chromium/--camoufox, --viewport, --cursor, --keylog, --popups,
 * --net, --type-delay, --idle — placed before the command, e.g.
 * `browse --headful --chromium -p google open …`. They configure the browser at
 * start-up, so they only apply to the command that opens the session (browse
 * refuses one aimed at a live session rather than silently dropping it), and
 * each is just a friendlier spelling of the env var the DAEMON reads at module
 * load (LAUNCH_FLAGS / LAUNCH_OPTS forward them into its spawn env). Everything
 * below is set-once-in-a-shell-profile territory and stays env-only;
 * `browse help --env` prints the lot.
 *   BROWSE_HOME        data home: profiles, sessions, run files, the playwright
 *                      install (default ~/.browse — nothing lives in the clone)
 *   BROWSE_OUT         override the session artifacts dir
 *   BROWSE_SESSION     session name (same as `browse -s <name> …`). Unset ⇒ derived
 *                      from the calling agent (its session-id env var, else the pid
 *                      of the nearest agent process up the tree), so two agents that
 *                      both omit -s still get their own browser. "default" for a human.
 *   BROWSE_PORT        pin the localhost control port (default: any free port)
 *   BROWSE_APP_URL     default URL for `browse open` (default: http://127.0.0.1:3000)
 *   BROWSE_WIDTH/_HEIGHT     one viewport dimension at a time (--viewport sets both)
 *   BROWSE_IDLE_MODE   what to do with auto-detected static dead air: cut (default,
 *                      drop it) | speed (fast-forward at BROWSE_IDLE_SPEED) | keep
 *   BROWSE_IDLE_SPEED  fast-forward factor: for BROWSE_IDLE_MODE=speed, and the
 *                      default N for `browse speed` (default 10)
 *   BROWSE_FPS         output frame rate of the finalized mp4 (default 30)
 *   BROWSE_NET_BODIES=0      don't capture request/response bodies
 *   BROWSE_NET_BODY_MAX      max bytes kept per body (default 32768)
 *   BROWSE_NET_SECRETS=1     keep auth headers/cookies verbatim (default: values hashed)
 *   BROWSE_KEEP_WEBM=1 keep the raw .webm after the mp4 is written, so the
 *                      session can be re-cut later with one ffmpeg call
 *   BROWSE_FFMPEG      the ffmpeg used to finalize the mp4
 *   BROWSE_PW_BASE     path whose parent dir holds node_modules/playwright
 *                      (default: resolve next to this file)
 *   BROWSE_CAMOUFOX_PYTHON  python that can `import camoufox` (default python3)
 *
 * On the engine (`--camoufox`, the default, vs `--chromium`): camoufox is a
 * Firefox build with C++-level fingerprint patches. It clears Cloudflare's JS
 * managed challenge HEADLESSLY, which Chromium cannot (its new-headless gets an
 * unsolved cf_clearance, and headed Chrome can't be hidden on macOS —
 * --window-position is clamped onto a real display). It falls back to chromium
 * by itself if camoufox isn't installed. Chromium-only, so these NEED
 * --chromium: `browse emulate` (CDP) and saving a .pdf. The engine also decides
 * which dir a `-p` profile uses, since the two profile formats are incompatible
 * (see profileDir).
 */

import http from "node:http";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { mkdirSync, appendFileSync, statSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const SELF = fileURLToPath(import.meta.url);
const HOST = "127.0.0.1";
// Each named session runs its OWN daemon + Chromium, so parallel agents don't
// step on each other. A daemon binds a free port (or BROWSE_PORT if pinned) and
// publishes it in a run file the clients look up by session name.
const FIXED_PORT = Number(process.env.BROWSE_PORT || 0); // 0 = any free port
const BROWSE_HOME = process.env.BROWSE_HOME || join(homedir(), ".browse");
/** Version from the repo's package.json — read lazily so `--version` is the only
 *  path that pays for it and a missing/edited file degrades to "unknown". */
function pkgVersion() {
  try { return JSON.parse(readFileSync(join(SELF, "..", "package.json"), "utf8")).version || "unknown"; }
  catch { return "unknown"; }
}
const RUN_DIR = join(BROWSE_HOME, "run"); // one <session>.json per live daemon
const sanitizeName = (s) => String(s).replace(/[^\w.-]+/g, "-");
// Default session name. Two agents that both omit `-s` would otherwise share one
// browser + one recording and stomp on each other (and either one's `close` ends
// the other's video). So when nothing is pinned we derive a name that is UNIQUE
// per agent session but STABLE across that session's commands (so every command
// reattaches to the same daemon):
//   1. an agent-provided session id from the env, if the agent exposes one, else
//   2. the pid of the nearest agent process up our own process tree, else
//   3. "default" (a human in a plain terminal).
// Explicit `-s <name>` / BROWSE_SESSION always wins.
const AGENT_SESSION_ENV = [
  "CLAUDE_CODE_SESSION_ID", // claude code
  "CLAUDE_SESSION_ID",
  "CODEX_SESSION_ID", // codex cli
  "CURSOR_SESSION_ID", // cursor cli / cursor-agent
  "CURSOR_TRACE_ID",
  "GEMINI_CLI_SESSION_ID", // gemini cli
  "OPENCODE_SESSION_ID", // opencode
  "AMP_SESSION_ID", // amp
  "AIDER_SESSION_ID",
  "GOOSE_SESSION_ID",
  "DROID_SESSION_ID", // factory droid
  "COPILOT_SESSION_ID", // gh copilot cli
];
// Binaries that mean "an AI coding agent is driving this shell". Matched against
// each ancestor's full argv, so node/bun-hosted agents (argv[1] = …/bin/claude)
// are caught too.
const AGENT_PROC_RE =
  /(^|[\/\s])(claude|claude-code|codex|cursor-agent|cursor|gemini|opencode|amp|aider|goose|crush|droid|copilot|qwen|kilocode|openhands|devin)(\.(js|mjs|cjs|exe))?(\s|$)/i;

/** Nearest AI-agent ancestor as "<name>-<pid>", or null. One `ps` call. */
function agentAncestor() {
  let rows;
  try {
    rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,args="], {
      encoding: "utf8", timeout: 4000, maxBuffer: 8 << 20,
    });
  } catch { return null; }
  const proc = new Map();
  for (const line of rows.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) proc.set(+m[1], { ppid: +m[2], args: m[3] });
  }
  // Walk up from our own pid; bounded so a weird tree can't loop forever.
  for (let pid = process.pid, i = 0; pid > 1 && i < 40; i++) {
    const p = proc.get(pid);
    if (!p) return null;
    const hit = AGENT_PROC_RE.exec(p.args);
    // Skip our own `browse …` argv (a launcher can look agent-ish) by only
    // matching ancestors, i.e. anything above the first hop.
    if (hit && i > 0) return `${hit[2].toLowerCase()}-${pid}`;
    pid = p.ppid;
  }
  return null;
}

function defaultSession() {
  for (const k of AGENT_SESSION_ENV) {
    const v = process.env[k];
    if (v) return `${k.split("_")[0].toLowerCase()}-${sanitizeName(v).slice(0, 8)}`;
  }
  return agentAncestor() || "default";
}
let SESSION = sanitizeName(process.env.BROWSE_SESSION || defaultSession());
// Persistent profile (`-p <name>` / BROWSE_PROFILE): its own user-data dir so
// logins+localStorage survive close→open. null = throwaway context (the default).
let PROFILE = process.env.BROWSE_PROFILE ? sanitizeName(process.env.BROWSE_PROFILE) : null;
function runFile(name) { return join(RUN_DIR, `${name}.json`); }

// ── Profile storage ────────────────────────────────────────────────────────
// ONE profile name, up to TWO dirs on disk: a Firefox profile and a Chromium
// user-data dir are incompatible formats, so camoufox stores `<name>` under
// `<name>-camoufox`. That is an implementation detail — `-p <name>` and
// `browse profiles` both speak the logical name, and the listing shows which
// engines that name actually has a login under.
const CAMOU_SUFFIX = "-camoufox";
const PROFILES_DIR = join(BROWSE_HOME, "profiles");
function profileDir(name, engine) {
  return join(PROFILES_DIR, engine === "camoufox" ? name + CAMOU_SUFFIX : name);
}
/** The lock a LIVE browser leaves in its own profile dir. Chromium's is a
 *  (usually dangling) symlink, so both are probed via readdir rather than stat. */
const ENGINE_LOCK = { chromium: "SingletonLock", camoufox: ".parentlock" };
function profileOpen(dir, engine) {
  try { return readdirSync(dir).includes(ENGINE_LOCK[engine]); } catch { return false; }
}
const humanSize = (kb) => kb >= 1048576 ? `${(kb / 1048576).toFixed(1)}G`
  : kb >= 1024 ? `${Math.round(kb / 1024)}M` : `${kb}K`;
function humanAge(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 1209600) return `${Math.round(s / 86400)}d ago`;
  if (s < 5184000) return `${Math.round(s / 604800)}w ago`;
  return `${Math.round(s / 2592000)}mo ago`;
}
/** Size + last-write of one profile dir, or null when nothing was ever written
 *  into it (a dir `launchPersistentContext` created and a `clear` emptied, or an
 *  engine half that only ever held a Finder .DS_Store). `du` because a Firefox
 *  profile is tens of thousands of files and walking it in-process to print one
 *  number is not worth the stall; the dir's OWN mtime is useless as "last used"
 *  since both engines write into subdirs, so take the newest child instead. */
function profileStat(dir) {
  let kids = [];
  try { kids = readdirSync(dir).filter((f) => f !== ".DS_Store"); } catch { return null; }
  if (!kids.length) return null;
  let newest = 0;
  for (const f of kids) {
    try { newest = Math.max(newest, statSync(join(dir, f)).mtimeMs); } catch { /* vanished mid-scan */ }
  }
  let size = "?";
  try {
    const kb = Number((spawnSync("du", ["-sk", dir], { encoding: "utf8", timeout: 10000 }).stdout || "").trim().split(/\s+/)[0]);
    if (Number.isFinite(kb)) size = humanSize(kb);
  } catch { /* no du — the row still carries the useful part */ }
  return { size, used: newest ? humanAge(newest) : "?" };
}
/** Every profile on disk, folded back to logical names:
 *  [{ name, engines: [{ engine, size, used }] }], engines empty = nothing stored. */
function scanProfiles() {
  let dirs = [];
  try {
    dirs = readdirSync(PROFILES_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; } // no profiles dir yet
  const byName = new Map();
  for (const d of dirs) {
    const camou = d.endsWith(CAMOU_SUFFIX);
    const name = camou ? d.slice(0, -CAMOU_SUFFIX.length) : d;
    if (!name) continue; // a dir literally called "-camoufox"
    if (!byName.has(name)) byName.set(name, { name, engines: [] });
    const stat = profileStat(join(PROFILES_DIR, d));
    if (stat) byName.get(name).engines.push({ engine: camou ? "camoufox" : "chromium", ...stat });
  }
  for (const p of byName.values()) p.engines.sort((a, b) => a.engine.localeCompare(b.engine));
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
// Tilde-shortened path — the form every artifact is reported in, and the form
// the user gets handed: short, terminal-linkified, pasteable into a shell.
function tildePath(p) {
  const home = homedir();
  return p && p.startsWith(home + "/") ? "~" + p.slice(home.length) : (p || "");
}
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
// The client computes a fresh stamped dir but only uses it when it actually
// spawns the daemon (passed down via BROWSE_OUT); an already-running daemon
// keeps recording into its own session dir. Named sessions get the name in the
// dir so parallel recordings are tellable apart.
function defaultOut() {
  return join(BROWSE_HOME, "sessions", stamp() + (SESSION === "default" ? "" : `-${SESSION}`));
}
let OUT, VIDEO_DIR, SHOTS_DIR, TRANSCRIPT, DAEMON_LOG;
function setOut(dir) {
  OUT = dir;
  VIDEO_DIR = `${OUT}/video`;
  SHOTS_DIR = `${OUT}/shots`; // auto per-step screenshots, out of the way
  TRANSCRIPT = `${OUT}/transcript.md`;
  DAEMON_LOG = `${OUT}/browsed.log`;
}
setOut(process.env.BROWSE_OUT || defaultOut());
const APP_DEFAULT = process.env.BROWSE_APP_URL || "http://127.0.0.1:3000";
// Recording viewport. Defaults to 1280x800 (16:10) — taller than 16:9 so dev
// dashboards with a fixed-height body don't clip off the bottom of the frame.
// Override with BROWSE_VIEWPORT="WxH", or BROWSE_WIDTH / BROWSE_HEIGHT.
const VIEWPORT = (() => {
  const combined = /^\s*(\d+)\s*[x×,]\s*(\d+)\s*$/.exec(process.env.BROWSE_VIEWPORT || "");
  const base = combined ? { width: +combined[1], height: +combined[2] } : { width: 1280, height: 800 };
  const w = Number(process.env.BROWSE_WIDTH);
  const h = Number(process.env.BROWSE_HEIGHT);
  return {
    width: Number.isFinite(w) && w > 0 ? w : base.width,
    height: Number.isFinite(h) && h > 0 ? h : base.height,
  };
})();
const HEADFUL = process.env.BROWSE_HEADFUL === "1";
// Which browser the daemon drives. `camoufox` is a Firefox build with
// fingerprint patches applied in C++ — it clears Cloudflare's JS managed
// challenge *headlessly*, which Chromium cannot do at all (its new-headless
// gets an unsolved cf_clearance, and headed Chrome can't be hidden on macOS:
// --window-position is clamped onto the nearest real display). Default, because
// most of what we drive is someone else's bot-walled site.
// `BROWSE_ENGINE=chromium` switches back — needed for `emulate` and PDF export,
// which are CDP-only (see engineSupportsCdp).
const ENGINE = (process.env.BROWSE_ENGINE || "camoufox").toLowerCase();
const USING_CAMOUFOX = ENGINE === "camoufox";
const IDLE_MS = process.env.BROWSE_IDLE_MS === undefined
  ? 30 * 60 * 1000
  : Math.max(0, Number(process.env.BROWSE_IDLE_MS) || 0);

// Dead-air handling (recording finalizer). Most of a session's wall clock is the
// agent deciding its next command while the page sits pixel-identical. By default
// those static "thinking" runs are CUT out of the final mp4 (IDLE.mode="cut") so
// the video is mostly action; set BROWSE_IDLE_MODE=speed to fast-forward them at
// IDLE.speed instead (badged), or =keep to leave them at real time. A region the
// agent explicitly brackets with `browse speed <n>` is always fast-forwarded at
// n× (badged), even when it has on-screen motion. A sample counts as "active"
// when vs the previous sample any cell moved by >= diffMax, or >= diffCells cells
// moved by >= 8 — the glide cursor, keystroke overlay and any real page change
// clear that easily, while encoder noise and a blinking caret (sub-cell at 32x32)
// stay below it.
const IDLE = {
  // What to do with AUTO-detected static runs >= minRunSecs:
  //   "cut" (default) drop them · "speed" fast-forward at IDLE.speed · "keep" real time
  mode: (() => {
    const m = String(process.env.BROWSE_IDLE_MODE || "cut").toLowerCase();
    return m === "speed" || m === "keep" ? m : "cut";
  })(),
  // Fast-forward factor: used for mode "speed", and the default N for `browse speed`.
  speed: (() => {
    const v = Number(process.env.BROWSE_IDLE_SPEED ?? 10);
    return Number.isFinite(v) && v >= 2 ? v : 10;
  })(),
  minRunSecs: 2.0, // only cut/fast-forward static runs at least this long
  padSecs: 0.4, // real-time cushion kept around detected activity
  diffMax: 12,
  diffCells: 2,
};

// Constant output frame rate for the finalized mp4. Playwright captures at ~25;
// we retime to 30 for smoother playback (override with BROWSE_FPS).
const OUTPUT_FPS = (() => {
  const v = Number(process.env.BROWSE_FPS ?? 30);
  return Number.isFinite(v) && v >= 1 ? Math.round(v) : 30;
})();
// The raw .webm is the mp4's temp source and is deleted once the mp4 lands. Keep
// it (BROWSE_KEEP_WEBM=1 / `browse close --keep-raw`) when you may want to re-cut
// the session differently later - that is one ffmpeg call off the surviving webm.
const KEEP_WEBM = process.env.BROWSE_KEEP_WEBM === "1";
// Real popups break the recording: recordVideo is per CONTEXT, but Playwright
// writes one .webm per PAGE and only the first page's file is finalized - so a
// popup records to a file nobody reads while the main clip freezes. By default we
// rewrite the common "open in a new tab" cases into same-tab navigation
// (popupSameTabInitScript); BROWSE_POPUPS=1 keeps the real popup behaviour.
// Under camoufox, default to REAL popups — i.e. skip the same-tab rewrite —
// because that rewrite is another init script injected into every page, and
// under camoufox the point is to look like an untouched browser. Set
// BROWSE_POPUPS=0 to force the same-tab rewrite back on.
const POPUPS = USING_CAMOUFOX ? process.env.BROWSE_POPUPS !== "0"
                              : process.env.BROWSE_POPUPS === "1";

/** `browse emulate net=<preset>` - Chrome DevTools' own throttling numbers
 *  (latency in ms, throughput in BYTES/sec). `net=off` clears the override. */
const NET_CONDITIONS = {
  "4g": { latency: 20, download: (4 * 1024 * 1024) / 8, upload: (3 * 1024 * 1024) / 8 },
  "3g": { latency: 100, download: (1.6 * 1024 * 1024) / 8, upload: (750 * 1024) / 8 },
  "slow3g": { latency: 400, download: (400 * 1024) / 8, upload: (400 * 1024) / 8 },
  "2g": { latency: 800, download: (250 * 1024) / 8, upload: (50 * 1024) / 8 },
  offline: { offline: true, latency: 0, download: 0, upload: 0 },
};

// Network capture. EVERY request the session makes (all pages/frames/workers of
// the context) is appended to `network.jsonl` in the session dir as it completes
// — so `browse net` can query it while the browser is live AND long after the
// session closed (the file outlives the daemon). Bodies are captured for
// text-ish content types up to bodyMax bytes; auth headers/cookies are redacted
// unless BROWSE_NET_SECRETS=1.
const NET = {
  on: process.env.BROWSE_NET !== "0",
  bodies: process.env.BROWSE_NET_BODIES !== "0",
  bodyMax: (() => {
    const v = Number(process.env.BROWSE_NET_BODY_MAX ?? 32768);
    return Number.isFinite(v) && v >= 0 ? v : 32768;
  })(),
  secrets: process.env.BROWSE_NET_SECRETS === "1",
};
const NET_TEXTY = /json|text|xml|javascript|x-www-form-urlencoded|graphql|csv|html|plain/i;
const NET_SECRET_HEADER = /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|x-auth-token|x-amz-security-token|x-csrf-token)$/i;
function netFileIn(dir) { return `${dir}/network.jsonl`; }
/** Playwright dims parts of its error messages with ANSI codes (the call log
 *  arrives as literal ESC[2m…ESC[22m). Those bytes are noise in a JSON response
 *  read by an agent, so every message the daemon returns goes through this. */
// Built from a string so no literal ESC byte ever sits in this source file.
const ANSI_RE = new RegExp("\\u001b\\[[0-9;]*m", "g");
function stripAnsi(s) { return String(s ?? "").replace(ANSI_RE, ""); }
/** Stand-in for a secret VALUE: a short digest + length. Never the secret, but
 *  stable — so the agent can tell two tokens apart, spot when one rotates, and
 *  match "the token the login returned" to "the token this call sent". */
function netHash(v) {
  const s = String(v);
  return `<sha256:${createHash("sha256").update(s).digest("hex").slice(0, 12)} len:${s.length}>`;
}
/** Redact a secret header while KEEPING its shape: the auth scheme, the cookie
 *  names, the Set-Cookie attributes — only the values become digests. */
function netHideValue(name, value) {
  const v = String(value);
  if (/^(cookie)$/i.test(name)) {
    return v.split(";").map((pair) => {
      const eq = pair.indexOf("=");
      return eq < 0 ? pair.trim() : `${pair.slice(0, eq).trim()}=${netHash(pair.slice(eq + 1).trim())}`;
    }).join("; ");
  }
  if (/^set-cookie$/i.test(name)) {
    return v.split("\n").map((one) => {
      const [pair, ...attrs] = one.split(";");
      const eq = pair.indexOf("=");
      const head = eq < 0 ? pair : `${pair.slice(0, eq)}=${netHash(pair.slice(eq + 1).trim())}`;
      return [head, ...attrs].join(";");
    }).join("\n");
  }
  const scheme = /^([A-Za-z][\w-]*)\s+(.+)$/.exec(v); // "Bearer <token>", "Basic <blob>"
  if (scheme) return `${scheme[1]} ${netHash(scheme[2])}`;
  return netHash(v);
}
function netRedact(headers) {
  if (NET.secrets) return headers;
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = NET_SECRET_HEADER.test(k) ? netHideValue(k, v) : v;
  }
  return out;
}
function netClip(s) {
  if (typeof s !== "string") return s;
  return s.length > NET.bodyMax ? `${s.slice(0, NET.bodyMax)}…[truncated, ${s.length} bytes total]` : s;
}

/** Cap what a read command prints. Silently slicing is the failure mode this
 *  exists to stop: the agent can't tell a short page from a cut one, so it acts
 *  on half an answer. Every cut SAYS it was cut and names a narrower query. */
const READ_MAX = 8000;
function clipForRead(text, cmd, howToNarrow, max = READ_MAX) {
  const s = String(text);
  if (s.length <= max) return s;
  // slice() counts UTF-16 units, so a cut that lands between an astral char's
  // two surrogates (emoji, CJK ext) would emit a lone one and print as U+FFFD.
  // Drop the orphan rather than corrupt the last character.
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return `${s.slice(0, end)}\n…[${cmd} truncated: ${end} of ${s.length} chars. ${howToNarrow}]`;
}

/** Page methods that change state → we auto-screenshot after them. */
const MUTATING = new Set([
  "goto", "click", "dblclick", "fill", "type", "press", "drag",
  "check", "uncheck", "hover", "selectOption", "setInputFiles",
  "focus", "reload", "goBack", "goForward",
]);
/** Everything we forward straight to page[method](...args). `waitForTimeout` is
 *  retired into `wait <ms>` but stays accepted: it is by far the most-reached-for
 *  spelling (Playwright muscle memory), so rejecting it would only buy a failed
 *  call and a retry. It is gone from the help. */
const PAGE_METHODS = new Set([...MUTATING, "waitForTimeout"]);
/** Commands that do NOT deserve a chapter marker in the final mp4 - reading the
 *  page changes nothing on screen, so a chapter there points at nothing. */
const CHAPTERLESS = new Set([
  "snapshot", "text", "title", "url", "content", "errors", "eval",
  "screenshot", "dir", "speed", "state", "net", "middleware", "close",
]);

const MW_USAGE = "middleware: needs a pattern AND a handler, e.g.\n" +
  "  browse middleware '**/api/user' 'route => route.fulfill({json: {ok: true}})'\n" +
  "Other forms: `browse middleware` (list) · `browse middleware <pattern> --remove` · `browse middleware --clear`";

/** Parse `middleware` args into the one shape both sides agree on.
 *
 *  The CLIENT needs this to decide whether a command is worth spawning a whole
 *  browser for; the DAEMON needs it to act. One parser so they cannot drift — a
 *  malformed command the client waves through and the daemon rejects is how the
 *  same typo ends up exiting 0 or 1 depending on whether a browser happened to
 *  be running. Returns { error } or { action, pattern?, src? }. */
function parseMiddleware(args) {
  let remove = false, clear = false;
  const words = [], unknown = [];
  for (const a of args) {
    if (a === "--remove") remove = true;
    else if (a === "--clear") clear = true;
    else if (String(a).startsWith("--")) unknown.push(a);
    else words.push(a);
  }
  if (unknown.length) return { error: `middleware: unknown flag '${unknown[0]}'\n${MW_USAGE}` };
  if (clear && (remove || words.length)) return { error: `middleware: --clear takes nothing else\n${MW_USAGE}` };
  if (clear) return { action: "clear" };
  if (remove) {
    if (words.length !== 1) return { error: `middleware: --remove needs exactly one pattern\n${MW_USAGE}` };
    return { action: "remove", pattern: words[0] };
  }
  if (!words.length) return { action: "list" };
  // One bare word is ambiguous on purpose: it is either a pattern whose handler
  // was forgotten or a handler whose pattern was. Refusing it is what lets
  // logLabel below promise never to echo source.
  if (words.length < 2) return { error: MW_USAGE };
  // Joined the same way `eval` joins its expression, so an unquoted handler still
  // works; a properly quoted one arrives as a single arg anyway.
  return { action: "register", pattern: words[0], src: words.slice(1).join(" ").trim() };
}

/** How a command is written down — transcript lines and mp4 chapter titles.
 *  `middleware` carries a JS handler that routinely holds a mocked token, a
 *  fixture with real customer data, or an internal URL, and the transcript is
 *  the artifact people share. So the pattern is recorded and the SOURCE never
 *  is — not here, not in the daemon log, not in the command's own result.
 *  Anything this can't prove is a pattern is written as <?>, because the one
 *  path where the caller got the arguments wrong is exactly the path that would
 *  otherwise dump a handler into the artifact. */
function logLabel(cmd, args) {
  if (cmd !== "middleware") return `${cmd}${args.length ? " " + args.join(" ") : ""}`;
  const m = parseMiddleware(args);
  if (m.action === "register") return `middleware ${m.pattern} <handler>`;
  if (m.action === "remove") return `middleware ${m.pattern} --remove`;
  if (m.action === "clear") return "middleware --clear";
  if (m.action === "list") return "middleware";
  return "middleware <?>";
}

/**
 * Draw an ANIMATED on-page cursor so the recorded video actually SHOWS the
 * pointer gliding to each element before we act on it (Playwright's real pointer
 * is not part of the page's rendered surface, so it never appears in the video —
 * a DOM cursor we move ourselves does). Set BROWSE_CURSOR=0 to disable.
 */
// Off by default under camoufox: this overlay is injected into every page, and
// on a bot-walled site that is the difference between passing and not. Measured
// on akakce's Cloudflare challenge — with the overlay on it never cleared (the
// page's CSP blocks the inline script and the challenge stalls); with it off it
// cleared in under 4s. Demo recordings want the cursor, stealth runs do not, so
// let the engine choose and keep BROWSE_CURSOR=1 as the explicit override.
const CURSOR = USING_CAMOUFOX ? process.env.BROWSE_CURSOR === "1"
                              : process.env.BROWSE_CURSOR !== "0";
/** Commands whose first arg is a selector we glide the cursor to before acting. */
const ELEMENT_TARGETED = new Set([
  "click", "dblclick", "fill", "type", "press", "drag",
  "check", "uncheck", "hover", "selectOption", "setInputFiles", "focus",
]);
/** Element-targeted commands that should also flash a click ripple. */
const CLICK_LIKE = new Set(["click", "dblclick", "check", "uncheck"]);

/**
 * Injected into every page (via addInitScript, so it survives navigations) BEFORE
 * the page's own scripts. Draws a fake SVG pointer + click ripples and exposes
 * `window.__browseCursor.moveTo(x,y,dur)` / `.click()` which the daemon calls to
 * animate the cursor. Must be fully self-contained (Playwright serializes it).
 */
function cursorInitScript() {
  if (window.self !== window.top) return; // top frame only
  const install = () => {
    if (window.__browseCursor) return;

    // Two pointer graphics — a macOS arrow and a macOS pointing-hand — each a
    // black-filled, white-bordered, soft-shadowed recreation (the real cursors
    // are copyrighted bitmaps). `hx`/`hy` is the hotspot: the point in the SVG
    // box that must sit exactly under (cx,cy) — the arrow's tip, the hand's
    // fingertip — so swapping shapes never makes the pointer visibly jump.
    const SHAPES = {
      default: {
        hx: 4, hy: 2.5,
        svg:
          '<svg width="26" height="30" viewBox="0 0 26 30" style="display:block">' +
          '<path d="M4 2.5L7.1 22L11.3 17.9L15.7 25.5L18.3 24.2L13.4 16.5L21.2 16.5Z" ' +
          'fill="#000" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>',
      },
      pointer: {
        hx: 9, hy: 2,
        svg:
          '<svg width="25" height="29" viewBox="0 0 25 29" style="display:block">' +
          '<path d="M9 2L11.3 4L11.3 12.4L13.5 9.8L14.1 12.2L16.3 9.8L16.9 12.1' +
          'L19.1 10.2L20.4 12.8L21.3 15.4L21.3 21.6L20.1 25.4L9.5 25.4L8.1 21.6' +
          'L7.9 18.2L3.7 16.6L5.4 13.4L6.7 12.4L6.7 4Z" ' +
          'fill="#000" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>',
      },
    };
    // Elements treated as clickable even when they don't set cursor:pointer, so
    // the hand appears the way it would in a real browser (buttons, links, etc.).
    const CLICKABLE =
      'a[href],button,[role=button],input[type=submit],input[type=button],' +
      'input[type=reset],summary,label[for],select,[onclick],[tabindex]:not([tabindex="-1"])';

    const root = document.createElement("div");
    root.setAttribute("aria-hidden", "true");
    root.style.cssText =
      "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
    const ptr = document.createElement("div");
    ptr.id = "__bc_ptr";
    ptr.style.cssText =
      "position:absolute;left:0;top:0;will-change:transform;" +
      "filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));";
    root.appendChild(ptr);
    (document.body || document.documentElement).appendChild(root);

    let cx = Math.round(window.innerWidth / 2);
    let cy = Math.round(window.innerHeight / 2);
    let shape = "";
    // Position the pointer so the current shape's hotspot lands on (cx,cy).
    const xform = () => {
      const s = SHAPES[shape] || SHAPES.default;
      return "translate(" + (cx - s.hx) + "px," + (cy - s.hy) + "px)";
    };
    const paint = () => { ptr.style.transform = xform(); };
    // Swap the visible graphic (arrow <-> hand) and re-anchor to the hotspot.
    // transform-origin sits at the hotspot too, so the click pulse scales in
    // place instead of drifting the tip.
    const setShape = (kind) => {
      const k = SHAPES[kind] ? kind : "default";
      if (k !== shape) {
        shape = k;
        ptr.innerHTML = SHAPES[k].svg;
        ptr.style.transformOrigin = SHAPES[k].hx + "px " + SHAPES[k].hy + "px";
      }
      paint();
    };
    // Decide arrow vs hand the way a browser does: hit-test the element under the
    // cursor and honour its computed cursor, with a clickable-ancestor fallback
    // for apps that don't set cursor:pointer. The overlay is pointer-events:none,
    // so elementFromPoint returns the real underlying page element.
    const wantsPointer = () => {
      try {
        const el = document.elementFromPoint(cx, cy);
        if (!el) return false;
        let c = "";
        try { c = getComputedStyle(el).cursor; } catch { /* ignore */ }
        if (c === "pointer") return true;
        return !!(el.closest && el.closest(CLICKABLE));
      } catch { return false; }
    };
    const syncShape = () => setShape(wantsPointer() ? "pointer" : "default");
    syncShape();

    const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    window.__browseCursor = {
      moveTo(x, y, dur) {
        return new Promise((resolve) => {
          const sx = cx, sy = cy, dx = x - sx, dy = y - sy;
          const d = dur || 320;
          if (dx === 0 && dy === 0) { syncShape(); resolve(); return; }
          let t0;
          const frame = (ts) => {
            if (t0 === undefined) t0 = ts;
            const t = Math.min(1, (ts - t0) / d);
            const e = ease(t);
            cx = sx + dx * e; cy = sy + dy * e;
            // Re-hit-test every frame so the pointer flips to the hand the moment
            // it passes over something clickable, exactly like a real mouse.
            syncShape();
            if (t < 1) requestAnimationFrame(frame); else resolve();
          };
          requestAnimationFrame(frame);
        });
      },
      click() {
        const at = xform();
        ptr.animate(
          [{ transform: at + " scale(1)" }, { transform: at + " scale(.7)" }, { transform: at + " scale(1)" }],
          { duration: 220, easing: "ease-out" },
        );
        const r = document.createElement("div");
        r.style.cssText =
          "position:absolute;left:" + cx + "px;top:" + cy + "px;width:10px;height:10px;" +
          "margin:-5px 0 0 -5px;border-radius:50%;background:rgba(56,189,248,.5);" +
          "border:2px solid rgba(56,189,248,.9);pointer-events:none;";
        root.appendChild(r);
        r.animate(
          [{ transform: "scale(1)", opacity: 0.9 }, { transform: "scale(5)", opacity: 0 }],
          { duration: 480, easing: "ease-out" },
        ).onfinish = () => r.remove();
      },
    };
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
}

/**
 * A keystroke overlay at the bottom-center of the page — like screen-recording
 * software (KeyCastr / ScreenFlow): typed text appears char-by-char and single
 * keys show as a chip, then it fades out after a short pause. Set BROWSE_KEYLOG=0
 * to disable. Exposes `window.__browseKeys.type(text)` / `.key(label)`.
 */
// Same reasoning as CURSOR: injected into every page, so off under camoufox.
const KEYLOG = USING_CAMOUFOX ? process.env.BROWSE_KEYLOG === "1"
                              : process.env.BROWSE_KEYLOG !== "0";
/**
 * Per-keystroke delay (ms) so `fill`/`type` enter text like a person typing —
 * fast, but not an instant paste. BROWSE_TYPE_DELAY overrides (0 = instant). The
 * keystroke overlay reveals at the same rate so the bezel stays in sync.
 */
const TYPE_DELAY = Math.max(0, Number(process.env.BROWSE_TYPE_DELAY || 45));
/** Pretty labels for special keys shown in the keylog chip. */
const KEY_LABEL = {
  Enter: "⏎ Enter", Tab: "⇥ Tab", Escape: "⎋ Esc", Backspace: "⌫ Backspace",
  Delete: "⌦ Delete", ArrowUp: "↑ Up", ArrowDown: "↓ Down",
  ArrowLeft: "← Left", ArrowRight: "→ Right", " ": "␣ Space", Space: "␣ Space",
};

function keylogInitScript() {
  if (window.self !== window.top) return; // top frame only
  const install = () => {
    if (window.__browseKeys) return;
    const bar = document.createElement("div");
    bar.setAttribute("aria-hidden", "true");
    bar.style.cssText =
      "position:fixed;left:50%;bottom:40px;transform:translateX(-50%);z-index:2147483646;" +
      "pointer-events:none;display:flex;gap:8px;align-items:center;" +
      "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;";
    (document.body || document.documentElement).appendChild(bar);

    let pill = null, hideT = null, clearT = null;
    const clearTimers = () => {
      if (hideT) { clearTimeout(hideT); hideT = null; }
      if (clearT) { clearTimeout(clearT); clearT = null; }
    };
    const ensurePill = () => {
      clearTimers();
      if (pill) return pill;
      pill = document.createElement("div");
      pill.style.cssText =
        "padding:10px 16px;border-radius:12px;background:rgba(17,19,24,.86);color:#f3f4f6;" +
        "font-size:20px;line-height:1;font-weight:600;letter-spacing:.5px;white-space:pre;" +
        "max-width:80vw;overflow:hidden;text-overflow:ellipsis;" +
        "box-shadow:0 6px 24px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.12);" +
        "opacity:0;transform:translateY(8px);transition:opacity .12s ease,transform .12s ease;";
      bar.appendChild(pill);
      requestAnimationFrame(() => {
        if (!pill) return;
        pill.style.opacity = "1";
        pill.style.transform = "translateY(0)";
      });
      return pill;
    };
    const scheduleHide = (ms) => {
      clearTimers();
      hideT = setTimeout(() => {
        if (!pill) return;
        pill.style.opacity = "0";
        pill.style.transform = "translateY(8px)";
        clearT = setTimeout(() => { if (pill) { pill.remove(); pill = null; } }, 220);
      }, ms);
    };

    window.__browseKeys = {
      // Reveal a string char-by-char (like live typing), then fade.
      type(text, cps) {
        if (!text) return;
        const p = ensurePill();
        const per = 1000 / (cps || 26);
        let i = 0, shown = "";
        p.textContent = "▏";
        const tick = () => {
          if (p !== pill) return; // superseded by a newer entry
          shown += text[i++];
          p.textContent = shown + "▏";
          if (i < text.length) setTimeout(tick, per);
          else { p.textContent = shown; scheduleHide(1100); }
        };
        setTimeout(tick, per);
      },
      // Show a single key/combo as a chip, then fade.
      key(label) {
        if (!label) return;
        const p = ensurePill();
        p.textContent = label;
        p.animate(
          [{ transform: "translateY(0) scale(1)" },
           { transform: "translateY(0) scale(1.08)" },
           { transform: "translateY(0) scale(1)" }],
          { duration: 160, easing: "ease-out" },
        );
        scheduleHide(900);
      },
    };
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
}

/**
 * Injected into every frame (unless BROWSE_POPUPS=1): turn the two "open in a new
 * tab" idioms that a demo actually hits - a `target=_blank` link and a bare
 * `window.open(url)` - into navigation in THIS tab. A second page would record to
 * a second .webm that finalizeRecording never sees, freezing the clip the viewer
 * gets. A genuine `window.open(url, name, features)` (a real OAuth window sized
 * by the app) is left alone; that case is handled by cutting its time out of the
 * video instead. Must be self-contained (Playwright serializes it).
 */
function popupSameTabInitScript() {
  const open = window.open;
  window.open = function (url, name, features) {
    const u = url == null ? "" : String(url);
    // A blank/absent url is the `const w = window.open(); w.document.write(…)`
    // idiom - a scratch document, NOT a navigation. Rewriting it would send the
    // MAIN tab to about:blank and white out the recording, so it must pop.
    const blank = !u || u === "about:blank" || u.startsWith("javascript:");
    // No features string ⇒ "just show me that page", not a deliberate popup.
    if (!blank && !features) { window.location.href = u; return window; }
    return open.apply(window, arguments);
  };
  // Capture phase, so we get there before the browser's default action. We take
  // over the navigation rather than rewriting `a.target`, because a mutated
  // attribute stays in the DOM and shows up in `browse content`/`snapshot`.
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const t = e.target;
    const a = t && t.closest && t.closest("a[target]");
    if (!a || a.target !== "_blank") return;
    // `download` means "save this", not "show me this page". Navigating to it
    // instead would open the file in the tab and lose the download entirely.
    if (a.hasAttribute("download")) return;
    const href = a.href;
    if (!href || /^javascript:/i.test(href)) return;
    e.preventDefault();
    window.location.href = href;
  }, true);
}

const HELP = `browse — drive a real Chromium browser step by step (records the whole session automatically).

Run one command, read the result, then run the next — this is agentic browsing,
not a script. The browser + recording start on your first command.

Navigate / act (selectors are Playwright strings: text=, role=button[name="…"], css, xpath=…):
  browse open [url]                 open the app (default ${APP_DEFAULT}) — starts the browser + recording
  browse goto <url>                 navigate
  browse click <selector>           click an element
  browse dblclick <selector>        double-click an element
  browse fill <selector> <value>    clear an input and type the value into it (key by key, like a person)
  browse type <selector> <text>     type into an element without clearing it (key by key)
  browse press [selector] <key>     e.g. browse press "input[name=todo]" Enter · browse press Escape
                                    (no selector = the key goes to the page: Escape, Tab, "Meta+k")
  browse check|uncheck <selector>   toggle a checkbox
  browse hover <selector>
  browse selectOption <selector> <value>
  browse setInputFiles <selector> <path…>   attach file(s) to a file input
  browse drag <from> <to>           press on <from>, carry it to <to>, release (shown on video)
  browse scroll <n|-n|top|bottom|<selector>> [--x <n>]
                                    smooth-scroll (an instant jump reads as a cut on video);
                                    a selector scrolls that element into view
  browse reload | goBack | goForward
  browse wait <selector|ms> [--gone] [--url <pattern>] [--timeout <ms>]
                                    hold until an element appears (or --gone: disappears), a
                                    navigation matches --url, or just pause N ms. This is also your
                                    ASSERTION: it exits non-zero if the thing never happens.
  browse speed [factor|off]         fast-forward the recording from here (e.g. 'speed 10') until
                                    'speed off' — for a long but visibly-progressing wait (spinner,
                                    deploy log). Dead "thinking" time is cut automatically; this is
                                    for waits you still want SHOWN, just faster (badged "Nx" — the
                                    badge needs an ffmpeg built with drawtext/libfreetype, which
                                    homebrew's core bottle is NOT; without it the stretch is still
                                    sped up but unlabelled, so it reads as a jump cut. 'browse speed'
                                    says so once per session when that is the case). Bare 'browse speed'
                                    opens a region at the default factor (${IDLE.speed}x); 'speed off' with
                                    nothing open is an error. A 'toast' inside the region is
                                    fast-forwarded with it, so show captions OUTSIDE it.

Observe (do these often — this is your "check" step):
  browse snapshot                   accessibility tree of the page (what a user/AT sees)
  browse text [selector]            visible text (whole page if no selector)
  browse title | url                page title / current URL
  browse content                    raw HTML (truncated)
  browse errors                     console + page errors seen so far
  browse screenshot [name] [--full] [--sel <selector>]
                                    save a screenshot into the session dir. --full captures the whole
                                    scrollable page (without moving it, so the recording is untouched),
                                    --sel shoots one element, and a name ending in .pdf prints a PDF.

Tabs, frames, emulation, saved logins:
  browse target                     list tabs (index, title, url, * = active)
  browse target <n>                 switch to a tab · popups are switched to AUTOMATICALLY
  browse target new [url]           open a tab · browse target close   close the active one
  browse target "iframe#checkout"   scope later element commands into that iframe
  browse target top                 leave the iframe scope
  browse emulate <k=v …>            viewport=390x844 dark=1 geo=41.0,29.0 tz=Europe/Istanbul
                                    locale=tr-TR cpu=4 net=3g|slow3g|4g|2g|offline · 'off' resets all
                                    (net=3g makes loading states actually visible in a demo).
                                    viewport= is for CHECKING a layout, not for recording one: the
                                    video frame is fixed when the browser starts, so a smaller page
                                    records anchored top-left in a field of grey. To RECORD phone-
                                    shaped, start the session with --viewport 390x844 instead.
  browse state --save <file>        write this session's cookies + localStorage to a file (a bare
                                    name lands in ${join(BROWSE_HOME, "state")}/)
  browse state --load <file> [--clean]
                                    replay them into the LIVE session (keeps recording) + reload,
                                    so a later session skips the login flow. MERGES onto what is
                                    already there (right for restoring one login); --clean wipes
                                    cookies + that origin's localStorage first, which is what you
                                    want when switching between two accounts
  Dialogs (alert/confirm/prompt) are auto-accepted and reported inline; put
  --dialog dismiss (or --dialog "accept:my answer") on the command that triggers one.
  Downloads are saved to downloads/ in the session dir and their path is reported inline.

Network (every request of the session is logged to network.jsonl by default — works
while the browser is live AND after close; queries never spawn a browser):
  browse net [pattern] [flags]      pattern = url substring, or /regex/i
    --host <d1,d2>  (alias -d)      filter by domain: 'upstash.com' also matches its subdomains,
                                    'localhost' matches any port, '.foo.com' = subdomains only,
                                    '!segment.io' excludes (mix: --host "upstash.com,!cdn.upstash.com")
    --method get,post               filter by method            --type xhr,fetch,document,script,image,…
    --status 5xx | 404 | ">=400"    filter by status            --failed      network errors + status >= 400
    --since <#>                     only requests after entry # (each row shows its #, e.g. --since 42
                                    right after a click shows only what that click triggered)
    --last <n>                      keep the last n matches (default 30) · --all for everything
    --grep <pat>                    match anywhere in the entry (headers, request/response bodies, url)
    --full                          headers + bodies            --body        just the bodies
    --json                          raw JSON lines — pipe to jq for anything the flags don't cover
    --stats                         counts by status / type / host
    --dir <session dir>             query an OLD session's log  --file        print the log's path
  e.g. browse net -d api.upstash.com --failed --full · browse net --json | jq 'select(.ms>500)'
  Auth headers + cookie VALUES are hashed (sha256 prefix + length), so you can tell tokens
  apart and see when one rotates without the secret landing in the log (BROWSE_NET_SECRETS=1
  keeps them verbatim; BROWSE_NET=0 turns logging off entirely).

Intercept requests (mock an API, block an asset, rewrite a response):
  browse middleware <pattern> '<playwright route handler>'
                                    pattern is a Playwright glob matched against the FULL url, so
                                    lead with ** (e.g. '**/api/user'). The handler is real JS run in
                                    the daemon with the real Route, and answers it with
                                    fulfill / abort / continue / fallback:
    mock      browse middleware '**/api/user' 'route => route.fulfill({json: {id: 1}})'
    block     browse middleware '**/*.png'    'route => route.abort()'
    rewrite   browse middleware '**/api/config' 'async route => {
                const res = await route.fetch(); const json = await res.json();
                await route.fulfill({response: res, json: {...json, debug: true}}); }'
    inspect   browse middleware '**/api/**' 'route => { console.log(route.request().url()); return route.fallback(); }'
  browse middleware                 list the patterns + how many requests each MATCHED
  browse middleware <pattern> --remove · browse middleware --clear
  A rule only affects requests made after it exists — register before 'open', or 'reload' after.
  Registering the same pattern REPLACES that rule (no accidental duplicates); newer rules run
  first. Rules cover the whole context (every tab and frame) and live only for this session.
  A handler that answers nothing is passed through untouched and says so once, rather than
  hanging the request. One that throws aborts its request and reports on your next command.
  console.* from a handler is written VERBATIM to browsed.log in the session dir — it is not
  redacted, so don't log request headers. Handler source is never printed or written to the
  transcript. 'browse net' marks what a rule answered: ⟨mock|block|continue <pattern>⟩.

Misc:
  browse eval <js expression>       evaluate JS in the page, print the result
  browse toast <text…>              show a NOTE caption on the page (demo videos) — ONLY for context the
                                    viewer can't see on screen, not to narrate actions. Auto-dismisses
                                    (~reading time); [--for <sec>] [--sticky] [--color yellow|blue|green|red|neutral]
                                    [--pos top|bottom]; --clear removes a sticky one
  browse dir                        print THIS session's artifacts dir
  browse close [--gif] [--keep-raw] end the session, finalize the recording, print the mp4 path.
                                    --gif also writes a looping recording.gif; --keep-raw keeps the
                                    raw .webm (BROWSE_KEEP_WEBM=1 too) so you can re-cut it yourself

Parallel sessions (e.g. one browser per agent — fully isolated):
  browse -s <name> <cmd> …          run <cmd> against the named session's own browser + recording.
                                    PREFER passing your own name: pick one per task (-s checkout-bug)
                                    on the first command and keep it on EVERY command incl. close.
                                    BROWSE_SESSION=<name> works too. With no -s the session name is
                                    derived from the calling agent (auto-unique per agent, stable
                                    across its commands) — "default" for a plain human terminal. That
                                    is a collision safety net, not the intended path: subagents of the
                                    SAME agent session, and two browsers under one agent, still need
                                    their own -s <name>.
  browse sessions                   list live sessions (name, port, artifacts dir)
  browse whoami                     print the session name these commands resolve to
  browse setup                      install/repair deps (playwright, chromium, camoufox link)
  browse version                    print the version

Launch flags (how the browser STARTS — put them before the command that opens the
session; on an already-live session browse refuses rather than ignoring them):
  --headful / --headless            show the browser window while driving it (still records)
  --camoufox / --chromium           pick the engine (default camoufox — see below)
  --viewport <WxH>                  recording frame size (default 1280x800). This is the one to
                                    use to RECORD phone-shaped; 'browse emulate viewport=' only
                                    resizes the page inside an already-fixed frame
  --cursor / --no-cursor            animated on-page cursor overlay
  --keylog / --no-keylog            keystroke overlay — both default ON for chromium and OFF for
                                    camoufox, where every injected script is a fingerprint
  --popups / --no-popups            let target=_blank open REAL popups, vs rewriting them into
                                    same-tab navigation so the recording stays one file
  --net / --no-net                  network logging (default on — see 'browse net')
  --type-delay <ms>                 per-keystroke delay for fill/type (default 45, 0 = paste)
  --idle <ms>                       auto-close after this long idle (default 1800000, 0 = never)
  e.g. browse --headful --chromium -p google open https://accounts.google.com
  Every flag is also an env var (BROWSE_HEADFUL=1, BROWSE_ENGINE=chromium, …), and the
  rarer knobs are env-only — 'browse help --env' lists them all.

Persistent profile (keep cookies + localStorage across close→open, e.g. stay logged in):
  browse -p <name> <cmd> …          drive on a persistent profile (own user-data dir). Prefix
                                    EVERY command with the same -p <name>. BROWSE_PROFILE=<name>
                                    works too. One live BROWSER at a time per profile (tabs are
                                    unlimited — see 'browse target'); a second session on the
                                    same profile can't share the locked dir.
                                    No -p = throwaway clean context (the default).
  browse profiles                   list the persistent profiles, with the engine(s) each has a
                                    login under, its size, and when it was last written
  browse -p <name> clear            delete a profile (both engines' dirs; --chromium / --camoufox
                                    clears just that half). Close it first if it's open.
  A profile is stored PER ENGINE — a Firefox profile and a Chromium user-data dir are
  incompatible formats, so 'browse --camoufox -p x' and 'browse --chromium -p x' are two
  separate logins under one name. Log in on the engine you will drive with.

Artifacts (transcript.md, step screenshots, video) land in a per-session dir
under ${join(BROWSE_HOME, "sessions")}/. On close, ffmpeg (if installed) trims the
blank white lead-in and CUTS static "thinking" dead air (>= 2s with no on-screen
change) out of the clip (BROWSE_IDLE_MODE=speed keeps+fast-forwards it instead,
=keep leaves it). A region you bracket with 'browse speed <n>' … 'browse speed
off' is instead fast-forwarded at n× — badged "n×" top-right — so a
visibly-progressing wait still shows. Time spent on a popup is cut too (only the
main tab is recorded). It writes a shareable recording.mp4 with a chapter per
acting command (reads don't get one, and neighbours closer than a quarter second
merge into 'first (+N more)') plus a poster.jpg; the temp raw .webm is then deleted (kept only if
ffmpeg is missing/fails, or with --keep-raw / BROWSE_KEEP_WEBM=1).`;

/** `browse help --env`. The knobs above have flags because they are the ones you
 *  reach for by hand; these are set once in a shell profile or a wrapper, so a
 *  flag would only be surface nobody types. */
const ENV_HELP = `browse — environment variables

Every launch flag is also an env var (a flag on the command WINS over the env):
  BROWSE_HEADFUL=1         --headful            BROWSE_ENGINE=camoufox|chromium  --camoufox/--chromium
  BROWSE_VIEWPORT=WxH      --viewport           BROWSE_CURSOR=0|1                --no-cursor/--cursor
  BROWSE_KEYLOG=0|1        --no-keylog/--keylog BROWSE_POPUPS=0|1                --no-popups/--popups
  BROWSE_NET=0|1           --no-net/--net       BROWSE_TYPE_DELAY=<ms>           --type-delay
  BROWSE_IDLE_MS=<ms>      --idle
  BROWSE_SESSION=<name>    -s <name>            BROWSE_PROFILE=<name>            -p <name>

Env-only (set once in a shell profile — no flag):
  BROWSE_HOME              data home for profiles/sessions/deps (default ~/.browse)
  BROWSE_OUT               override this session's artifacts dir
  BROWSE_PORT              pin the localhost control port (default: any free port)
  BROWSE_APP_URL           default URL for 'browse open' (default http://127.0.0.1:3000)
  BROWSE_WIDTH / _HEIGHT   viewport one dimension at a time (BROWSE_VIEWPORT sets both)
  BROWSE_IDLE_MODE         auto-detected dead air: cut (default) | speed | keep
  BROWSE_IDLE_SPEED        fast-forward factor for =speed, and default N for 'browse speed' (10)
  BROWSE_FPS               output frame rate of the finalized mp4 (30)
  BROWSE_KEEP_WEBM=1       keep the raw .webm after the mp4 lands (= 'close --keep-raw')
  BROWSE_NET_BODIES=0      don't capture request/response bodies
  BROWSE_NET_BODY_MAX      max bytes kept per body (32768)
  BROWSE_NET_SECRETS=1     keep auth headers/cookie values verbatim (default: hashed)
  BROWSE_FFMPEG            path to the ffmpeg used for the mp4 finalize
  BROWSE_PW_BASE           path whose parent dir holds node_modules/playwright
  BROWSE_CAMOUFOX_PYTHON   python that can 'import camoufox' (default python3)`;

/* ========================================================= network queries */

// `browse net` is answered CLIENT-SIDE straight off network.jsonl — never via the
// daemon. So it works identically while the browser is live and after `close`
// (and it never spawns a browser just to read a log).

function netRead(dir) {
  let raw = "";
  try { raw = readFileSync(netFileIn(dir), "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn last line while live — skip */ }
  }
  // Entries are appended in COMPLETION order; `i` is start order. Sort by start
  // so the list reads like a devtools network panel.
  return out.sort((a, b) => (a.i || 0) - (b.i || 0));
}

/** Newest session dir that actually has a network log (prefers this session). */
function netLatestDir() {
  const base = join(BROWSE_HOME, "sessions");
  let dirs = [];
  try {
    dirs = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(base, e.name));
  } catch { return null; }
  dirs = dirs.filter((d) => { try { return statSync(netFileIn(d)).size >= 0; } catch { return false; } });
  // Dir names are timestamp-stamped, so lexical order is chronological.
  dirs.sort();
  if (SESSION !== "default") {
    const mine = dirs.filter((d) => d.endsWith(`-${SESSION}`));
    if (mine.length) return mine[mine.length - 1];
  }
  return dirs.length ? dirs[dirs.length - 1] : null;
}

function netStatusMatch(spec, code) {
  if (code == null) return false;
  return String(spec).split(",").some((raw) => {
    const s = raw.trim().toLowerCase();
    let m;
    if ((m = /^([1-5])xx$/.exec(s))) return Math.floor(code / 100) === Number(m[1]);
    if ((m = /^(>=|<=|>|<)\s*(\d+)$/.exec(s))) {
      const n = Number(m[2]);
      return m[1] === ">=" ? code >= n : m[1] === "<=" ? code <= n : m[1] === ">" ? code > n : code < n;
    }
    if ((m = /^(\d+)\s*-\s*(\d+)$/.exec(s))) return code >= Number(m[1]) && code <= Number(m[2]);
    return code === Number(s);
  });
}

/** `/re/flags` → RegExp, anything else → case-insensitive substring test. */
function netMatcher(pattern) {
  const m = /^\/(.*)\/([gimsuy]*)$/.exec(pattern);
  if (m) { try { const re = new RegExp(m[1], m[2].replace("g", "")); return (s) => re.test(s || ""); } catch { /* literal */ } }
  const needle = String(pattern).toLowerCase();
  return (s) => String(s || "").toLowerCase().includes(needle);
}

function netHost(url) { try { return new URL(url).host; } catch { return ""; } }
/**
 * `--host` (`-d`): comma-separated hosts. A bare domain also matches its
 * subdomains (`upstash.com` → `api.upstash.com`), the port is optional
 * (`localhost` matches `localhost:3000`, `localhost:3000` matches only that),
 * and a leading `.` or `*.` means subdomains ONLY. Prefix with `!` to exclude.
 */
function netHostFilter(spec) {
  const rules = String(spec).split(",").map((raw) => {
    let s = raw.trim().toLowerCase();
    const negate = s.startsWith("!");
    if (negate) s = s.slice(1);
    const subOnly = s.startsWith(".") || s.startsWith("*.");
    const base = s.replace(/^\*?\./, "");
    return { negate, subOnly, base };
  }).filter((r) => r.base);
  const hit = (host, r) => {
    const h = host.toLowerCase();
    const bare = h.replace(/:\d+$/, ""); // host without port
    const withPort = r.base.includes(":");
    const cmp = withPort ? h : bare;
    if (!r.subOnly && cmp === r.base) return true;
    return cmp.endsWith(`.${r.base}`);
  };
  const allows = rules.filter((r) => !r.negate);
  const denies = rules.filter((r) => r.negate);
  return (url) => {
    const host = netHost(url);
    if (denies.some((r) => hit(host, r))) return false;
    return allows.length === 0 || allows.some((r) => hit(host, r));
  };
}

function netSize(n) {
  if (n == null) return "-";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}kB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

// Analytics/ad beacons carry monstrous query strings — one of them can be 700
// chars of noise in a list the agent has to read. The compact view clips the
// url (keeping the path and the head of the query); --full/--json keep it whole.
const NET_URL_MAX = 140;
function netClipUrl(u) {
  const s = String(u || "");
  return s.length > NET_URL_MAX ? `${s.slice(0, NET_URL_MAX - 1)}…(+${s.length - NET_URL_MAX + 1})` : s;
}

/** How a `browse middleware` rule answered a request, in the one word that tells
 *  the reader what to distrust about the row. */
const NET_MOCK_VERB = { fulfill: "mock", abort: "block", continue: "continue" };

function netLine(e, { fullUrl } = {}) {
  const status = e.error ? "ERR" : e.status == null ? "-" : String(e.status);
  const pad = (s, n) => String(s).padEnd(n);
  return [
    pad(`#${e.i}`, 5),
    pad(`${(e.t ?? 0).toFixed(1)}s`, 7),
    pad(e.method || "?", 6),
    pad(status, 4),
    pad(e.type || "", 9),
    pad(netSize(e.size), 8),
    pad(e.ms == null ? "-" : `${e.ms}ms`, 7),
    fullUrl ? e.url : netClipUrl(e.url),
    e.error ? `  ← ${e.error}` : "",
    // A request one of YOUR middleware rules answered. Without this an abort()
    // reads as an organic network failure and a mocked 200 as a real one.
    e.mock ? `  ⟨${NET_MOCK_VERB[e.mockVia] || "middleware"} ${e.mock}⟩` : "",
  ].join(" ").trimEnd();
}

function netDetail(e, { bodiesOnly } = {}) {
  const L = [];
  if (!bodiesOnly) {
    L.push(netLine(e, { fullUrl: true }));
    if (e.at) L.push(`  at: ${e.at}${e.mime ? `  mime: ${e.mime}` : ""}`);
    for (const [label, h] of [["req", e.reqHeaders], ["res", e.resHeaders]]) {
      const keys = Object.keys(h || {});
      if (keys.length) L.push(`  ${label} headers:\n` + keys.map((k) => `    ${k}: ${h[k]}`).join("\n"));
    }
  } else {
    L.push(`#${e.i} ${e.method} ${e.error ? "ERR" : e.status ?? "-"} ${e.url}`);
  }
  if (e.reqBody) L.push(`  request body:\n${String(e.reqBody).split("\n").map((l) => "    " + l).join("\n")}`);
  if (e.resBody) L.push(`  response body:\n${String(e.resBody).split("\n").map((l) => "    " + l).join("\n")}`);
  return L.join("\n");
}

function netStats(list) {
  const by = (fn) => {
    const m = new Map();
    for (const e of list) { const k = fn(e); m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const bytes = list.reduce((n, e) => n + (e.size || 0), 0);
  const fmt = (pairs, n = 12) => pairs.slice(0, n).map(([k, v]) => `  ${String(v).padStart(5)}  ${k}`).join("\n");
  return [
    `${list.length} requests · ${netSize(bytes)} transferred`,
    "status:", fmt(by((e) => (e.error ? "ERR" : e.status == null ? "-" : `${Math.floor(e.status / 100)}xx`))),
    "type:", fmt(by((e) => e.type || "?")),
    "host:", fmt(by((e) => netHost(e.url) || "?"), 10),
  ].join("\n");
}

/**
 * `browse net [pattern] [flags]` — query this session's request log.
 * Pure read: no daemon call, no browser spawn. Returns a process exit code.
 */
function netCommand(argv) {
  let pattern = null, method = null, type = null, status = null, grep = null, dir = null, host = null;
  let last = 30, since = null, failed = false, full = false, bodies = false, json = false, stats = false, showFile = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "-m" || a === "--method") method = String(next() || "").toLowerCase();
    else if (a === "-t" || a === "--type") type = String(next() || "").toLowerCase();
    else if (a === "--status") status = next(); // not `-s`: that's the global session flag
    else if (a === "-d" || a === "--host") host = next();
    else if (a === "--grep") grep = next();
    else if (a === "--since") since = Number(next());
    else if (a === "-n" || a === "--last") last = Number(next());
    else if (a === "--all") last = 0;
    else if (a === "--failed" || a === "--errors") failed = true;
    else if (a === "-v" || a === "--full") full = true;
    else if (a === "--body" || a === "--bodies") bodies = true;
    else if (a === "--json") json = true;
    else if (a === "--stats") stats = true;
    else if (a === "--file" || a === "--path") showFile = true;
    else if (a === "--dir") dir = next();
    else if (a.startsWith("-")) { process.stderr.write(`browse net: unknown flag '${a}' — run \`browse help\`\n`); return 1; }
    else if (pattern == null) pattern = a;
    else pattern += " " + a; // unquoted multi-word pattern
  }

  const sessionDir = dir || netLatestDir();
  if (!sessionDir) { process.stdout.write("(no session with a network log yet — run `browse open <url>` first)\n"); return 0; }
  if (showFile) { process.stdout.write(netFileIn(sessionDir) + "\n"); return 0; }

  const all = netRead(sessionDir);
  const urlMatch = pattern ? netMatcher(pattern) : null;
  const grepMatch = grep ? netMatcher(grep) : null;
  const hostMatch = host ? netHostFilter(host) : null;
  let list = all.filter((e) => {
    if (urlMatch && !urlMatch(e.url)) return false;
    if (hostMatch && !hostMatch(e.url)) return false;
    if (method && !method.split(",").includes(String(e.method || "").toLowerCase())) return false;
    if (type && !type.split(",").includes(String(e.type || "").toLowerCase())) return false;
    if (status && !netStatusMatch(status, e.status)) return false;
    if (failed && !(e.error || (e.status != null && e.status >= 400))) return false;
    if (since != null && !(e.i > since)) return false;
    if (grepMatch && !grepMatch(JSON.stringify(e))) return false;
    return true;
  });
  const matched = list.length;
  // --stats summarizes EVERYTHING that matched the filters; --last only trims
  // the listing (a summary of "the last 30" would just misreport the session).
  if (stats) { process.stdout.write(netStats(list) + "\n"); return 0; }
  if (last > 0 && list.length > last) list = list.slice(-last);

  if (!list.length) {
    process.stdout.write(`(no matching requests — ${all.length} logged in ${sessionDir})\n`);
    return 0;
  }
  const body = json
    ? list.map((e) => JSON.stringify(e)).join("\n")
    : full || bodies
      ? list.map((e) => netDetail(e, { bodiesOnly: bodies && !full })).join("\n\n")
      : list.map(netLine).join("\n");
  process.stdout.write(body + "\n");
  if (!json) {
    const more = matched > list.length ? ` (of ${matched} matching, ${all.length} logged; --last 0 for all)` : ` of ${all.length} logged`;
    process.stdout.write(`— ${list.length} shown${more} · ${netFileIn(sessionDir)}\n`);
  }
  return 0;
}

/* ============================================================ client mode */

/** GET /health — resolves the answering daemon's session name, or null. */
function healthSession(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: "/health", timeout: 1500 }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(buf).session ?? null); } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

/** Find THIS session's live daemon via its run file; null if none/stale. */
async function findDaemon() {
  let info = null;
  try { info = JSON.parse(readFileSync(runFile(SESSION), "utf8")); } catch { return null; }
  if (!info || !info.port) return null;
  return (await healthSession(info.port)) === SESSION ? info : null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Spawn this session's detached daemon (if not up) and wait for its run file. */
async function ensureDaemon() {
  let d = await findDaemon();
  if (d) return d;
  // One spawner per session: take an atomic lock; losing it means another
  // client is already spawning this session's browser — just wait for it.
  mkdirSync(RUN_DIR, { recursive: true });
  const lock = runFile(SESSION) + ".lock";
  let spawner = false;
  try { writeFileSync(lock, String(process.pid), { flag: "wx" }); spawner = true; }
  catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > 90_000) { // crashed spawner
        rmSync(lock, { force: true });
        writeFileSync(lock, String(process.pid), { flag: "wx" });
        spawner = true;
      }
    } catch { /* lost the race again — wait it out below */ }
  }
  try {
    if (spawner) {
      mkdirSync(OUT, { recursive: true });
      const child = spawn(process.execPath, [SELF, "__serve"], {
        detached: true,
        stdio: "ignore",
        env: {
        ...process.env,
        BROWSE_OUT: OUT,
        BROWSE_SESSION: SESSION,
        ...(PROFILE ? { BROWSE_PROFILE: PROFILE } : {}),
        // Launch flags win over an inherited env var: the flag is on THIS
        // command, the env var is ambient (a shell export, an agent's wrapper).
        ...LAUNCH_ENV,
      },
      });
      child.unref();
    }
    // Launching Chromium takes a few seconds; poll generously.
    for (let i = 0; i < 60; i++) {
      if ((d = await findDaemon())) return d;
      await sleep(1000);
    }
  } finally {
    if (spawner) rmSync(lock, { force: true });
  }
  throw new Error(`browser daemon for session '${SESSION}' did not come up — see ${DAEMON_LOG}`);
}

/** POST a command to the daemon, return the parsed { ok, result?/error? }. */
function post(port, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: HOST, port, path: "/", method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
        timeout: 120000 },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try { resolve(JSON.parse(buf)); }
          catch { resolve({ ok: false, error: `bad daemon response: ${buf.slice(0, 200)}` }); }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("command timed out")); });
    req.write(data);
    req.end();
  });
}

const CLOSERS = new Set(["close"]);

/** Commands that USED to exist, mapped to what to run instead. Only worth an
 *  entry when the old spelling is something an agent plausibly still reaches
 *  for; everything else gets the generic "unknown command".
 *
 *  Null-prototype: a plain literal would make `RETIRED[cmd]` truthy for
 *  `toString`/`constructor`/`__proto__`, so `browse toString` would answer with
 *  native-code source instead of "unknown command — run: browse help". */
const RETIRED = Object.assign(Object.create(null), {
  stop: "`browse close`", quit: "`browse close`",
  waitForSelector: "`browse wait <selector>`",
  video: "`browse dir` for the artifacts dir, or `browse close` for the finished mp4",
  tap: "`browse click` (there is no touch model)",
  evaluate: "`browse eval <expression>`",
});

/** Every command the daemon answers, so an UNKNOWN one is refused here instead
 *  of launching a browser and starting a recording just to be told no. Kept
 *  next to RETIRED because both exist for the same reason; `browse help` is the
 *  user-facing list and this is the machine one. */
const DAEMON_COMMANDS = new Set([
  ...MUTATING, ...PAGE_METHODS, "open", "snapshot", "text", "title", "url",
  "content", "errors", "screenshot", "wait", "scroll", "eval", "toast", "speed",
  "target", "emulate", "state", "middleware", "dir", "close",
]);
/** Flags a command used to accept, refused in the CLIENT so a stale spelling
 *  costs an error instead of a browser launch. The daemon validates these too
 *  (it is the one that knows the full flag set); this only front-runs the
 *  spellings we KNOW are dead.
 *
 *  Keyed BY COMMAND, not globally: `-t` is a dead `wait` flag but a perfectly
 *  good screenshot name or `selectOption` value, and a global scan rejected
 *  those too. */
const RETIRED_FLAGS = Object.assign(Object.create(null), {
  screenshot: { "--fullpage": "`browse screenshot [name] --full`", "--selector": "`browse screenshot [name] --sel <selector>`" },
  wait: { "--hidden": "`browse wait <selector> --gone`", "-t": "`browse wait <selector> --timeout <ms>`" },
  net: { "--domain": "`browse net --host <d1,d2>` (or -d)" },
});

/** Launch flags — how the browser is STARTED, so they only bite on the command
 *  that starts the session. The daemon reads its config from env at module load
 *  (it is a separate process), so each flag is just a friendlier spelling of one
 *  env var, forwarded into the spawn env by ensureDaemon. The env vars still
 *  work; every knob that is rarer than these stays env-only.
 *
 *  Null-prototype: `LAUNCH_FLAGS[a]` must be falsy for `--constructor` and
 *  friends, same reasoning as RETIRED. */
const LAUNCH_FLAGS = Object.assign(Object.create(null), {
  "--headful": ["BROWSE_HEADFUL", "1"], "--headless": ["BROWSE_HEADFUL", "0"],
  "--camoufox": ["BROWSE_ENGINE", "camoufox"], "--chromium": ["BROWSE_ENGINE", "chromium"],
  "--cursor": ["BROWSE_CURSOR", "1"], "--no-cursor": ["BROWSE_CURSOR", "0"],
  "--keylog": ["BROWSE_KEYLOG", "1"], "--no-keylog": ["BROWSE_KEYLOG", "0"],
  "--popups": ["BROWSE_POPUPS", "1"], "--no-popups": ["BROWSE_POPUPS", "0"],
  "--net": ["BROWSE_NET", "1"], "--no-net": ["BROWSE_NET", "0"],
});
/** Launch flags that take a value. `check` rejects a malformed one loudly —
 *  silently falling back to the default is how you record 40 minutes at the
 *  wrong viewport and only find out watching the mp4. */
const LAUNCH_OPTS = Object.assign(Object.create(null), {
  "--viewport": { env: "BROWSE_VIEWPORT", check: (v) => /^\d+\s*[x×,]\s*\d+$/.test(v), want: "WxH, e.g. 390x844" },
  "--type-delay": { env: "BROWSE_TYPE_DELAY", check: (v) => /^\d+$/.test(v), want: "milliseconds, e.g. 0 (paste) or 45" },
  "--idle": { env: "BROWSE_IDLE_MS", check: (v) => /^\d+$/.test(v), want: "milliseconds, e.g. 600000 (0 = never auto-close)" },
});
/** Env overrides collected from launch flags, handed to the daemon at spawn. */
const LAUNCH_ENV = {};
/** Commands answered entirely by the client — no browser, so no launch flags
 *  apply. (`clear` is the exception: it reads the engine flags to pick which
 *  half of a profile to wipe.) */
const LOCAL_CMDS = new Set(["help", "version", "whoami", "sessions", "profiles", "clear", "net", "setup"]);
/** Session/profile selectors. Like the launch flags, they only mean anything
 *  before the command; after it they are just another argument. */
const SELECT_FLAGS = new Set(["-s", "--session", "-p", "--profile"]);

async function client(argv) {
  // Leading flags (any order): `-s <name>` selects a named parallel session,
  // `-p <name>` selects a persistent profile. Both must accompany EVERY command
  // aimed at that session (BROWSE_SESSION / BROWSE_PROFILE work too). Launch
  // flags (LAUNCH_FLAGS / LAUNCH_OPTS) go here too, on the command that opens.
  const launchSeen = [];
  for (;;) {
    const a = argv[0];
    if (a === "-s" || a === "--session") {
      SESSION = sanitizeName(argv[1] || "default");
      argv = argv.slice(2);
      if (!process.env.BROWSE_OUT) setOut(defaultOut());
    } else if (a === "-p" || a === "--profile") {
      PROFILE = argv[1] ? sanitizeName(argv[1]) : null;
      argv = argv.slice(2);
    } else if (LAUNCH_FLAGS[a]) {
      const [env, val] = LAUNCH_FLAGS[a];
      LAUNCH_ENV[env] = val;
      launchSeen.push(a);
      argv = argv.slice(1);
    } else if (LAUNCH_OPTS[a]) {
      const { env, check, want } = LAUNCH_OPTS[a];
      const val = String(argv[1] ?? "");
      if (!check(val)) {
        process.stderr.write(`browse: ${a} wants ${want}${val ? ` — got '${val}'` : " — got nothing"}\n`);
        return 1;
      }
      LAUNCH_ENV[env] = val.replace(/\s/g, "");
      launchSeen.push(a);
      argv = argv.slice(2);
    } else break;
  }
  const cmd = argv[0];
  // A launch flag AFTER the command was swallowed as an argument to it (a URL, a
  // selector, a value), which is silent and looks like the flag did nothing.
  const late = argv.slice(1).find((a) => LAUNCH_FLAGS[a] || LAUNCH_OPTS[a]);
  if (late) {
    process.stderr.write(`browse: ${late} configures how the browser starts, so it goes BEFORE the command — e.g. \`browse ${late} ${cmd} …\`\n`);
    return 1;
  }
  // Same for -s / -p: swallowed as an argument, the command quietly drives the
  // DEFAULT session, or a profile-less browser, which reads as the profile being
  // ignored rather than never selected at all.
  const lateSel = argv.slice(1).find((a) => SELECT_FLAGS.has(a));
  if (lateSel) {
    const val = argv[argv.indexOf(lateSel, 1) + 1];
    const pair = `${lateSel}${val && !val.startsWith("-") ? ` ${val}` : " <name>"}`;
    process.stderr.write(`browse: ${lateSel} picks which session/profile the command runs against, so it goes BEFORE the command, e.g. \`browse ${pair} ${cmd} …\`\n`);
    return 1;
  }
  // `<name>-camoufox` is where profile `<name>` keeps its camoufox half, so a
  // profile that spells it out would silently share a dir with another one.
  if (PROFILE && PROFILE.endsWith(CAMOU_SUFFIX)) {
    const base = PROFILE.slice(0, -CAMOU_SUFFIX.length);
    process.stderr.write(`browse: '${CAMOU_SUFFIX}' is reserved — that dir is profile '${base}' on camoufox. Use \`-p ${base} --camoufox\`.\n`);
    return 1;
  }
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    const envOnly = argv.slice(1).some((a) => a === "--env" || a === "env");
    process.stdout.write((envOnly ? ENV_HELP : HELP) + "\n");
    return 0;
  }
  // Before ANY command handler runs: a retired flag is knowably wrong whether
  // the command is answered here (net) or by the daemon, and answering it here
  // is what keeps it from launching a browser to be refused.
  const dead = RETIRED_FLAGS[cmd];
  const deadFlag = dead && argv.slice(1).find((a) => dead[a]);
  if (deadFlag) {
    process.stderr.write(`browse: '${deadFlag}' was removed — use ${dead[deadFlag]}\n`);
    return 1;
  }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    process.stdout.write(`browse ${pkgVersion()}\n`);
    return 0;
  }
  // No command starts with a dash, so this is a misspelled flag. Answer it here:
  // everything past this point sends the word to the daemon as a command, and a
  // typo'd flag would LAUNCH A BROWSER just to be told it isn't a command.
  if (cmd.startsWith("-")) {
    process.stderr.write(`browse: unknown flag ${cmd} — run \`browse help\` (or \`browse help --env\` for the env-only knobs)\n`);
    return 1;
  }
  // List every live daemon across all session names (and sweep stale run files).
  // Which session do these commands actually drive? Useful when the name is
  // auto-derived from the calling agent rather than passed with -s.
  if (cmd === "whoami") {
    const live = await findDaemon();
    process.stdout.write(`${SESSION}${live ? `  (live, port ${live.port})  ${live.out}` : "  (not running)"}\n`);
    return 0;
  }
  if (cmd === "sessions") {
    let names = [];
    try { names = readdirSync(RUN_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)); } catch { /* no run dir yet */ }
    const lines = [];
    for (const name of names) {
      try {
        const info = JSON.parse(readFileSync(runFile(name), "utf8"));
        if ((await healthSession(info.port)) === name) lines.push(`${name}  (port ${info.port})  ${info.out}`);
        else rmSync(runFile(name), { force: true });
      } catch { /* unreadable — skip */ }
    }
    process.stdout.write(lines.length ? lines.join("\n") + "\n" : "(no live sessions)\n");
    return 0;
  }
  // List the persistent profiles browse owns. ONE row per logical name, then one
  // line per engine that name actually holds a login under — the `-camoufox`
  // dir is the same profile, not a second one, and showing it as such is the
  // only way `-p stealth` on the wrong engine stops looking like a lost login.
  // Local + read-only, like `sessions`.
  if (cmd === "profiles") {
    const found = scanProfiles();
    if (!found.length) { process.stdout.write("(no profiles yet)\n"); return 0; }
    const nameW = Math.max(...found.map((p) => p.name.length));
    const out = [];
    for (const p of found) {
      if (!p.engines.length) { // dir(s) exist but nothing was ever written into them
        out.push(`${p.name.padEnd(nameW)}  (empty)`);
        continue;
      }
      p.engines.forEach((e, i) => {
        out.push(`${(i ? "" : p.name).padEnd(nameW)}  ${e.engine.padEnd(8)}  ${e.size.padStart(5)}  ${e.used}`);
      });
    }
    out.push("", "(a login lives per engine — pick with --chromium / --camoufox)");
    process.stdout.write(out.join("\n") + "\n");
    return 0;
  }
  // Delete the profile selected by `-p <name>`: `browse -p <name> clear`. Local —
  // just wipes its user-data dir(s). BOTH engines' dirs go by default, since one
  // name is one profile as far as the CLI is concerned; `--chromium` / `--camoufox`
  // narrows it to that half. Refuses while a half is open (a live browser keeps a
  // lock file in its dir; deleting it out from under one would corrupt the session).
  if (cmd === "clear") {
    if (!PROFILE) {
      process.stderr.write("browse: `clear` needs a profile — run `browse -p <name> clear`\n");
      return 1;
    }
    const only = LAUNCH_ENV.BROWSE_ENGINE; // set by --chromium / --camoufox
    const halves = ["chromium", "camoufox"]
      .filter((e) => !only || e === only)
      .map((engine) => ({ engine, dir: profileDir(PROFILE, engine) }))
      .filter(({ dir }) => { try { return statSync(dir).isDirectory(); } catch { return false; } });
    if (!halves.length) {
      process.stdout.write(`(no ${only ? `${only} ` : ""}profile '${PROFILE}' to clear)\n`);
      return 0;
    }
    const open = halves.filter(({ dir, engine }) => profileOpen(dir, engine));
    if (open.length) {
      process.stderr.write(`browse: profile '${PROFILE}' looks open (${open.map((h) => h.engine).join(", ")}) — run \`browse -p ${PROFILE} close\` first, then retry.\n`);
      return 1;
    }
    for (const { dir } of halves) rmSync(dir, { recursive: true, force: true });
    process.stdout.write(`cleared profile '${PROFILE}' (${halves.map((h) => h.engine).join(", ")})\n`);
    return 0;
  }
  // Network log queries are answered off the session's network.jsonl, so they
  // work both mid-session and long after close — and never spawn a browser.
  if (cmd === "net" || cmd === "network" || cmd === "requests") {
    const live = await findDaemon();
    return netCommand(argv.slice(1).concat(live?.out && !argv.includes("--dir") ? ["--dir", live.out] : []));
  }
  // Registering middleware BEFORE `open` is the normal flow, so that form has to
  // spawn the browser. Listing/removing/clearing must not: with no live session
  // there are no rules, and launching a whole browser to say so would also start
  // a recording nobody asked for. A MALFORMED command is rejected here either
  // way, so its exit status doesn't depend on whether a browser happened to be up.
  if (cmd === "middleware") {
    const m = parseMiddleware(argv.slice(1));
    if (m.error) {
      process.stderr.write(`browse: ${m.error}\n`);
      return 1;
    }
    if (m.action !== "register" && !(await findDaemon())) {
      process.stdout.write(`(no active browser session${SESSION === "default" ? "" : ` '${SESSION}'`}, so no middleware)\n`);
      return 0;
    }
  }
  // A retired spelling is knowably wrong here — answering in the client keeps it
  // from LAUNCHING a browser (and a recording) only to reject the command.
  if (RETIRED[cmd]) {
    process.stderr.write(`browse: '${cmd}' was removed — use ${RETIRED[cmd]}\n`);
    return 1;
  }
  // Everything the client answers itself has returned by now, so anything not on
  // the daemon's list is a typo. Refusing it here is the difference between an
  // error and a browser + recording spun up for nothing.
  if (!DAEMON_COMMANDS.has(cmd)) {
    process.stderr.write(`browse: unknown command '${cmd}' — run: browse help\n`);
    return 1;
  }
  // Never spawn a browser just to close one: if there's no live session, closing
  // is a no-op.
  if (CLOSERS.has(cmd) && !(await findDaemon())) {
    process.stdout.write(`(no active browser session${SESSION === "default" ? "" : ` '${SESSION}'`})\n`);
    return 0;
  }
  // Launch flags configure the browser at START-UP, so a live session cannot
  // adopt one. Refusing beats ignoring: `browse --headful click …` against an
  // already-open session would otherwise report success with the window still
  // hidden, and nothing on screen would say why.
  if (launchSeen.length && (await findDaemon())) {
    const s = SESSION === "default" ? "" : ` -s ${SESSION}`;
    process.stderr.write(
      `browse: ${launchSeen.join(" ")} only applies when the browser starts, and session '${SESSION}' is already live.\n` +
      `        Run \`browse${s} close\` and re-open with the flag, or start a separate session with -s <name>.\n`);
    return 1;
  }
  const d = await ensureDaemon();
  const res = await post(d.port, { cmd, args: argv.slice(1) });
  if (res.ok) {
    if (res.result != null && res.result !== "") process.stdout.write(String(res.result) + "\n");
    return 0;
  }
  process.stderr.write(`browse: ${res.error || "error"}\n`);
  return 1;
}

/* ==================================================== recording finalizer */

// Dead-air trimming (ported from the agent's mux-upload). A frame sampled down
// to 32x32 gray is "blank" when it is essentially pure white (about:blank):
// mean brightness >= blankMean AND no pixel darker than blankMin. A real page —
// even a light-themed one — always has some dark pixel (text/borders), so it is
// never mistaken for blank. Only trim when there is a meaningful chunk to cut.
const TRIM = {
  sampleFps: 5, // frames/sec sampled for blank/motion detection
  size: 32, // sampled frames are size x size gray
  blankMean: 250,
  blankMin: 240,
  minLeadCut: 1.5, // only trim if >= this many seconds of dead air at head…
  minTailCut: 1.5, // …or tail
  minKeep: 1.0, // never produce a clip shorter than this
};

/** True if `bin` runs `-version` cleanly (i.e. it exists and is a runnable ffmpeg). */
function runsVersion(bin) {
  try {
    const r = spawnSync(bin, ["-version"], { stdio: "ignore" });
    return !r.error && r.status === 0;
  } catch { return false; }
}

/**
 * Resolve ffmpeg to an ABSOLUTE, runnable path — ONCE, memoised. The recording
 * finalizer runs inside the DETACHED daemon (spawned in ensureDaemon), whose
 * inherited PATH can differ from an interactive login shell's. A bare-name
 * spawnSync("ffmpeg", …) there ENOENTs even when ffmpeg is installed and on a
 * normal shell's PATH — which used to silently no-op BOTH the mp4 encode and the
 * dead-air trim, leaving only the raw .webm. Resolving to an absolute path here
 * and using it for EVERY ffmpeg call fixes that regardless of the daemon's PATH.
 * Order: $BROWSE_FFMPEG · the current PATH · common absolute locations ·
 * Playwright's bundled ffmpeg. Returns null (→ graceful .webm fallback) only
 * when no working ffmpeg exists anywhere.
 */
let _ffmpegBin; // undefined = unresolved · string = path · null = none found
function ffmpegBin() {
  if (_ffmpegBin !== undefined) return _ffmpegBin;
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const sep = process.platform === "win32" ? ";" : ":";
  const pick = (cands) => { for (const c of cands) if (c && runsVersion(c)) return c; return null; };
  let bin =
    pick([process.env.BROWSE_FFMPEG]) ||                                                   // 1. explicit override
    pick((process.env.PATH || "").split(sep).filter(Boolean).map((d) => join(d, exe))) ||  // 2. the current PATH
    pick(["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg", "/bin/ffmpeg"]); // 3. common locations
  if (!bin) { // 4. Playwright ships its own ffmpeg — use it as a last resort if present.
    try {
      const req = createRequire(process.env.BROWSE_PW_BASE || SELF);
      const reg = req("playwright-core/lib/server/registry");
      bin = pick([reg?.registry?.findExecutable?.("ffmpeg")?.executablePath?.()]);
    } catch { /* none bundled — fall through to the .webm fallback */ }
  }
  _ffmpegBin = bin;
  return bin;
}

/**
 * Does this ffmpeg have `drawtext`? Homebrew's core `ffmpeg` bottle is now a SLIM
 * build without libfreetype (drawtext moved to `ffmpeg-full`), so the speed badge
 * can't be assumed — a filter graph naming drawtext on such a build fails
 * outright, which would take the whole mp4 encode down with it. Probe once and
 * simply skip the badge when it's missing; the fast-forward itself still works.
 */
let _hasDrawtext;
function hasDrawtext() {
  if (_hasDrawtext !== undefined) return _hasDrawtext;
  const ff = ffmpegBin();
  if (!ff) return (_hasDrawtext = false);
  try {
    const r = spawnSync(ff, ["-hide_banner", "-filters"], { encoding: "utf8", timeout: 8000 });
    _hasDrawtext = /^\s*\S+\s+drawtext\s/m.test(r.stdout || "");
  } catch { _hasDrawtext = false; }
  return _hasDrawtext;
}

/**
 * Find the [start, end] window (seconds) of frames that actually have content,
 * skipping any pure-white about:blank frames at the head/tail. Also reports the
 * sampled total duration (Playwright's .webm often has no duration metadata, so
 * we derive it from the frame count instead of ffprobe) and a per-sample
 * activity flag (did anything move vs the previous sample) for the dead-air /
 * speed planner. Returns null if ffmpeg fails or the clip is entirely blank.
 */
function analyzeVideo(srcFile) {
  const ff = ffmpegBin();
  if (!ff) return null;
  const N = TRIM.size * TRIM.size; // gray bytes per sampled frame
  let r;
  try {
    r = spawnSync(
      ff,
      ["-v", "error", "-i", srcFile, "-vf", `fps=${TRIM.sampleFps},scale=${TRIM.size}:${TRIM.size},format=gray`, "-f", "rawvideo", "-"],
      { maxBuffer: 256 * 1024 * 1024 },
    );
  } catch { return null; }
  if (!r || r.error || r.status !== 0 || !r.stdout || !r.stdout.length) return null;
  const buf = r.stdout;
  const frames = Math.floor(buf.length / N);
  if (frames < 2) return null;
  let first = -1;
  let last = -1;
  const active = new Array(frames).fill(false);
  for (let f = 0; f < frames; f++) {
    const base = f * N;
    let sum = 0;
    let min = 255;
    let maxDiff = 0;
    let cells = 0;
    for (let i = 0; i < N; i++) {
      const v = buf[base + i];
      sum += v;
      if (v < min) min = v;
      if (f > 0) {
        const d = Math.abs(v - buf[base - N + i]);
        if (d > maxDiff) maxDiff = d;
        if (d >= 8) cells++;
      }
    }
    const blank = sum / N >= TRIM.blankMean && min >= TRIM.blankMin;
    if (!blank) {
      if (first < 0) first = f;
      last = f;
    }
    // A change is motion in both the sample it appears in and the one before.
    if (f > 0 && (maxDiff >= IDLE.diffMax || cells >= IDLE.diffCells)) {
      active[f] = true;
      active[f - 1] = true;
    }
  }
  if (first < 0) return null; // entirely blank — leave the clip alone
  return {
    start: first / TRIM.sampleFps,
    end: (last + 1) / TRIM.sampleFps,
    total: frames / TRIM.sampleFps,
    firstFrame: first,
    lastFrame: last,
    active,
  };
}

/**
 * Turn the agent's `browse speed` marks into forced fast-forward intervals (in
 * raw-video seconds). Marks are already chronological; a mark with factor > 1
 * opens an interval, the NEXT mark (any) closes it at its timestamp, and a
 * trailing open interval runs to +Infinity. Changing factor without an explicit
 * `off` just re-opens at the new factor (last-open-wins).
 */
function forcedIntervals(marks) {
  const out = [];
  let open = null; // { start, factor }
  for (const m of marks) {
    if (open) { out.push({ start: open.start, end: m.t, factor: open.factor }); open = null; }
    if (m.factor > 1) open = { start: m.t, factor: m.factor };
  }
  if (open) out.push({ start: open.start, end: Infinity, factor: open.factor });
  return out.filter((iv) => iv.end > iv.start);
}

/**
 * Plan the content window [firstFrame,lastFrame] into a list of segments, each
 * one of three kinds:
 *   keep  — play at real time (1×). Frames within padSecs of detected motion.
 *   cut   — dropped entirely (auto-detected static dead air, when mode="cut").
 *   speed — played at `factor`× with a badge. Agent-marked `forced` regions
 *           (always), plus auto static runs when mode="speed".
 * Returns [{ start, end, kind, factor }] in seconds, or null when every segment
 * is `keep` (nothing to cut or speed → the caller uses the cheap trim path).
 *
 * `cuts` are FORCED cuts (time the session spent on a popup, whose frames went to
 * a different .webm and so show as a frozen main tab here). They outrank
 * everything, including a protected toast and an agent-marked speed region.
 */
function planSegments(win, forced, mode, autoFactor, keeps = [], cuts = []) {
  const fps = TRIM.sampleFps;
  const pad = Math.round(IDLE.padSecs * fps);
  const minRun = Math.round(IDLE.minRunSecs * fps);
  const lo = win.firstFrame;
  const hi = win.lastFrame;

  // Per-frame classification: forced-speed wins, else motion-padded → keep, else
  // → static (resolved by `mode` after we know how long each static run is).
  const cls = [];
  const inAny = (ivs, f) => ivs.some((iv) => {
    const s = Math.round(iv.start * fps);
    const e = iv.end === Infinity ? hi + 1 : Math.round(iv.end * fps);
    return f >= s && f < e;
  });
  for (let f = lo; f <= hi; f++) {
    // Forced cuts first - nothing survives them, not even a toast.
    if (inAny(cuts, f)) { cls.push({ kind: "cut", factor: 1 }); continue; }
    let ff = 0; // factor of the forced interval containing f, else 0
    for (const iv of forced) {
      const s = Math.round(iv.start * fps);
      const e = iv.end === Infinity ? hi + 1 : Math.round(iv.end * fps);
      if (f >= s && f < e) { ff = iv.factor; break; }
    }
    let pk = false; // any active frame within pad of f
    for (let j = Math.max(lo, f - pad); j <= Math.min(hi, f + pad) && !pk; j++) pk = win.active[j];
    let prot = false; // inside a protected interval (a toast is on screen)
    for (const k of keeps) {
      const s = Math.round(k.start * fps);
      const e = k.end === Infinity ? hi + 1 : Math.round(k.end * fps);
      if (f >= s && f < e) { prot = true; break; }
    }
    if (ff > 1) cls.push({ kind: "speed", factor: ff });
    else if (pk || prot) cls.push({ kind: "keep", factor: 1 });
    else cls.push({ kind: "static", factor: 1 });
  }

  // Group runs of identical classification (for speed, identical factor too).
  const groups = [];
  for (let i = 0; i < cls.length; ) {
    let j = i;
    while (j < cls.length && cls[j].kind === cls[i].kind && cls[j].factor === cls[i].factor) j++;
    groups.push({ i, j, kind: cls[i].kind, factor: cls[i].factor });
    i = j;
  }

  // Resolve static runs: long enough → apply mode; short → stay real time.
  for (const g of groups) {
    if (g.kind !== "static") continue;
    if (g.j - g.i >= minRun) {
      if (mode === "cut") g.kind = "cut";
      else if (mode === "speed") { g.kind = "speed"; g.factor = autoFactor; }
      else g.kind = "keep"; // mode === "keep"
    } else {
      g.kind = "keep";
    }
  }

  // Merge adjacent segments with identical (kind, factor); frames → seconds.
  const segs = [];
  for (const g of groups) {
    const prev = segs[segs.length - 1];
    if (prev && prev.kind === g.kind && prev.factor === g.factor) prev.end = (lo + g.j) / fps;
    else segs.push({ start: (lo + g.i) / fps, end: (lo + g.j) / fps, kind: g.kind, factor: g.factor });
  }
  return segs.every((s) => s.kind === "keep") ? null : segs;
}

/**
 * First readable TTF/TTC on disk, for the drawtext speed badge. Covers macOS
 * (Arial/Helvetica ship in Supplemental) and common Linux font packages.
 * Returns null when none is found, in which case the badge is simply skipped.
 */
function findFontFile() {
  const candidates = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/liberation/LiberationSans-Regular.ttf",
  ];
  for (const p of candidates) {
    try { if (statSync(p).isFile()) return p; } catch { /* keep looking */ }
  }
  return null;
}

/**
 * Map a RAW-video timestamp onto the FINALIZED timeline. The mp4 is a concat of
 * the surviving segments retimed by their factor, so raw time and output time
 * drift apart the moment anything is cut or sped up. A step that landed inside a
 * cut stretch has no output moment of its own - it clamps to the edge of the cut,
 * i.e. the next thing the viewer actually sees.
 */
function rawToOutput(kept, t) {
  let out = 0;
  for (const s of kept) {
    if (t < s.start) return out; // landed in a cut gap → clamp to this segment
    const len = (Math.min(t, s.end) - s.start) / (s.kind === "speed" ? s.factor : 1);
    out += len;
    if (t <= s.end) return out;
  }
  return out;
}

/**
 * Write an ffmetadata chapters file - one chapter per command the agent ran - so
 * the mp4 has a scrubbable table of contents in players that show one. Returns
 * the path, or null when there is nothing worth writing (best-effort: a chapter
 * problem must never cost us the recording).
 */
function writeChapters(kept, marks, totalSecs) {
  if (!marks.length) return null;
  const pts = [];
  // Every step that ran inside a CUT stretch maps onto the same segment edge, so
  // a burst of them wants the same timestamp - and zero-length chapters break
  // players. Spreading them out by a fixed gap would keep the list 1:1 with the
  // commands, but it invents timings: the viewer gets an even ladder of marks
  // that each point at whatever is on screen after the WHOLE burst, which reads
  // as precise and is wrong. So collapse them into one chapter instead. The
  // video really does have a single moment there, and the title says how many
  // steps landed in it; the per-step record lives in transcript.md and shots/.
  const gap = 0.25;
  for (const m of marks) {
    const t = rawToOutput(kept, m.t);
    if (t >= totalSecs) break; // past the end of the clip - nothing to point at
    const prev = pts[pts.length - 1];
    if (prev && t < prev.t + gap) { prev.merged = (prev.merged || 1) + 1; continue; }
    pts.push({ t, cmd: m.cmd });
  }
  for (const p of pts) if (p.merged) p.cmd = `${p.cmd} (+${p.merged - 1} more)`;
  if (!pts.length) return null;
  const lines = [";FFMETADATA1"];
  for (let i = 0; i < pts.length; i++) {
    const end = i + 1 < pts.length ? pts[i + 1].t : totalSecs;
    lines.push(
      "[CHAPTER]", "TIMEBASE=1/1000",
      `START=${Math.round(pts[i].t * 1000)}`,
      `END=${Math.round(end * 1000)}`,
      // ffmetadata escapes =, ;, # and \ with a backslash, and a RAW newline
      // ends the value - a multi-line `fill` would otherwise corrupt the file
      // and silently cost the session every one of its chapters.
      `title=${pts[i].cmd.replace(/\s+/g, " ").replace(/([=;#\\])/g, "\\$1")}`,
    );
  }
  const path = join(OUT, "chapters.txt");
  try { writeFileSync(path, lines.join("\n") + "\n"); return path; }
  catch { return null; }
}

/**
 * `browse close --gif`: a looping gif beside the mp4, in two passes (a palette
 * built from the whole clip, then applied - one pass quantizes per frame and
 * bands badly on flat UI). Deliberately NOT part of finalizeRecording: on a long
 * session this outlives the client's 120s timeout, so it runs after the daemon
 * has already replied with the mp4 path. Best-effort, returns nothing.
 */
function makeGif(mp4Path) {
  const ff = ffmpegBin();
  if (!ff) return;
  const pal = join(OUT, "palette.png");
  const vf = "fps=12,scale=720:-1:flags=lanczos";
  const run = (...args) => {
    try {
      const r = spawnSync(ff, ["-y", "-loglevel", "error", ...args], { stdio: "ignore" });
      return !!r && !r.error && r.status === 0;
    } catch { return false; }
  };
  if (run("-i", mp4Path, "-vf", `${vf},palettegen`, pal)) {
    run("-i", mp4Path, "-i", pal, "-filter_complex", `[0:v]${vf}[x];[x][1:v]paletteuse`, "-loop", "0", join(OUT, "recording.gif"));
  }
  try { rmSync(pal, { force: true }); } catch { /* ignore */ }
}

/**
 * Turn the raw session .webm into a shareable OUT/recording.mp4: cut any
 * pure-white lead-in/out, drop auto-detected static "thinking" dead air
 * (per IDLE.mode), and fast-forward any region the agent bracketed with
 * `browse speed` (its marks arrive as speedMarks) at that region's factor.
 * Sped-up stretches carry a "<factor>x" badge in the top-right so viewers can
 * tell compressed time from real time. Best-effort: returns the mp4 path, or
 * null (no ffmpeg / any failure) — on null the caller keeps the .webm as the
 * only recording.
 */
function finalizeRecording(webmPath, marks = {}) {
  const { speedMarks = [], keepMarks = [], cutMarks = [], stepMarks = [] } = marks;
  const ff = ffmpegBin();
  if (!ff) return null;
  const outPath = join(OUT, "recording.mp4");
  const win = analyzeVideo(webmPath);
  const forced = win ? forcedIntervals(speedMarks || []) : [];
  const segs = win ? planSegments(win, forced, IDLE.mode, IDLE.speed, keepMarks || [], cutMarks || []) : null;

  // Run ffmpeg once with the given pre-output args; true on a non-empty result.
  const runFfmpeg = (middle) => {
    const args = ["-y", "-loglevel", "error", "-i", webmPath, ...middle,
      "-an", "-movflags", "+faststart", "-pix_fmt", "yuv420p", outPath];
    let r;
    try { r = spawnSync(ff, args, { stdio: "ignore" }); } catch { return false; }
    if (!r || r.error || r.status !== 0) return false;
    try { return statSync(outPath).size > 0; } catch { return false; }
  };
  const run = (...args) => {
    try {
      const r = spawnSync(ff, ["-y", "-loglevel", "error", ...args], { stdio: "ignore" });
      return !!r && !r.error && r.status === 0;
    } catch { return false; }
  };

  /**
   * Everything that happens once the mp4 EXISTS, given the segments that made it
   * (a one-segment stand-in on the plain trim path). All of it is a bonus on top
   * of the deliverable, so each step is best-effort and none of it can lose or
   * corrupt the recording - the chapters go in as a stream-copy remux into a temp
   * file that only replaces the mp4 if it worked.
   */
  const finish = (keptSegs) => {
    const totalSecs = keptSegs.reduce(
      (n, s) => n + (s.end - s.start) / (s.kind === "speed" ? s.factor : 1), 0);
    const chapters = writeChapters(keptSegs, stepMarks || [], totalSecs);
    if (chapters) {
      const tmp = join(OUT, "recording.chapters.mp4");
      const ok = run("-i", outPath, "-i", chapters, "-map", "0", "-map_metadata", "1", "-c", "copy", tmp);
      try {
        if (ok && statSync(tmp).size > 0) renameSync(tmp, outPath);
        else rmSync(tmp, { force: true });
      } catch { /* keep the chapter-less mp4 */ }
      try { rmSync(chapters, { force: true }); } catch { /* ignore */ }
    }
    // The poster is what an embed shows before playback, so a white frame makes
    // the recording look broken. Seek to the first sample analyzeVideo saw MOVE
    // (falling back to the first non-blank one), mapped onto the output timeline
    // - "half a second in" lands in the white lead-in whenever it was too short
    // to be trimmed.
    if (totalSecs > 0) {
      let rawAt = win ? win.start : 0;
      if (win) {
        const firstMove = win.active.findIndex((a, i) => a && i >= win.firstFrame);
        if (firstMove >= 0) rawAt = Math.max(rawAt, firstMove / TRIM.sampleFps);
      }
      const at = Math.max(0, Math.min(rawToOutput(keptSegs, rawAt + 0.5), Math.max(0, totalSecs - 0.2)));
      run("-ss", at.toFixed(3), "-i", outPath, "-frames:v", "1", "-q:v", "3", join(OUT, "poster.jpg"));
    }
    return outPath;
  };

  // Keep only the segments that survive into the clip; `cut` segments are simply
  // omitted so their time never enters the concat (a hard cut). If everything was
  // cut (degenerate — the whole clip was dead air), fall through to the trim path
  // rather than emit an empty graph.
  const kept = segs && segs.filter((s) => s.kind !== "cut");
  if (kept && kept.length) {
    // One trim/setpts branch per kept segment, concatenated; blank lead-in/out
    // falls away for free since segments only cover the content window. `speed`
    // segments retime by /factor; `keep` segments stay 1×. The trailing
    // fps=OUTPUT_FPS re-times to a constant frame rate.
    //
    // Sped segments also get a "<factor>x" drawtext badge pinned top-right, so
    // the viewer always knows when the clip is compressing time vs playing real
    // time. drawtext needs a TTF + a libfreetype-enabled ffmpeg; if either is
    // missing the badged graph fails and we retry the identical speed-up without
    // the label, so the recording is never lost to a badge problem.
    // Both must hold: a TTF on disk AND a drawtext-capable ffmpeg (Homebrew's
    // slim core bottle has none). Checking up front skips a doomed encode; the
    // retry below still covers any other badge failure.
    const font = hasDrawtext() ? findFontFile() : null;
    const badge = (factor) => font
      ? `,drawtext=fontfile='${font}':text='${factor}x':fontcolor=white` +
        `:fontsize=32:box=1:boxcolor=black@0.5:boxborderw=12:x=w-tw-28:y=28`
      : "";
    const graph = (withBadge) =>
      kept
        .map((s, i) =>
          `[0:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},` +
          `setpts=(PTS-STARTPTS)${s.kind === "speed" ? "/" + s.factor : ""}` +
          `${s.kind === "speed" && withBadge ? badge(s.factor) : ""}[v${i}]`)
        .join(";") +
      ";" +
      kept.map((_, i) => `[v${i}]`).join("") +
      `concat=n=${kept.length}:v=1:a=0,fps=${OUTPUT_FPS}[v]`;

    const anySpeed = kept.some((s) => s.kind === "speed");
    if (font && anySpeed && runFfmpeg(["-filter_complex", graph(true), "-map", "[v]"])) return finish(kept);
    return runFfmpeg(["-filter_complex", graph(false), "-map", "[v]"]) ? finish(kept) : null;
  }

  // No cut/speed plan — just trim dead lead-in/out if worthwhile, and retime to
  // the constant output rate. The whole clip is then one real-time segment, which
  // is all `finish` needs to map step marks onto the output timeline.
  const middle = [];
  let plain = null;
  if (win) {
    const leadCut = win.start;
    const tailCut = Math.max(0, win.total - win.end);
    const keep = win.end - win.start;
    if ((leadCut >= TRIM.minLeadCut || tailCut >= TRIM.minTailCut) && keep >= TRIM.minKeep) {
      // -ss AFTER -i: accurate decode-seek — Playwright's .webm has no seek
      // cues, so a fast pre-input seek can land wide of the cut point.
      middle.push("-ss", win.start.toFixed(3), "-t", keep.toFixed(3));
      plain = [{ start: win.start, end: win.end, kind: "keep", factor: 1 }];
    } else {
      plain = [{ start: 0, end: win.total, kind: "keep", factor: 1 }];
    }
  }
  middle.push("-r", String(OUTPUT_FPS));
  if (!runFfmpeg(middle)) return null;
  return plain ? finish(plain) : outPath;
}

/* ============================================================ daemon mode */

function logTranscript(entry) {
  try { appendFileSync(TRANSCRIPT, entry); } catch { /* best-effort */ }
}
/** The transcript is the PROOF artifact, so a cut result must show as cut: three
 *  silent lines turned a 45-line snapshot into something that read like the whole
 *  answer, mid-sentence. Keep enough to be evidence, and name where the rest is. */
const TRANSCRIPT_LINES = 12;
function transcriptBody(result) {
  const lines = String(result).split("\n");
  const kept = lines.slice(0, TRANSCRIPT_LINES).map((l) => "- " + l).join("\n");
  // Says only what is true HERE: the reply itself may already have been capped
  // by clipForRead, so promising the full text was printed would be a lie.
  return lines.length > TRANSCRIPT_LINES
    ? `${kept}\n- _…${lines.length - TRANSCRIPT_LINES} more lines not kept in this transcript_`
    : kept;
}
function logDaemon(msg) {
  try { appendFileSync(DAEMON_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* ignore */ }
}

/**
 * Ask camoufox (a Python package) for the launch options its own API would use,
 * so Playwright-JS can launch the same browser with the same fingerprint.
 *
 * `camoufox.utils.launch_options()` returns a JSON-serialisable dict —
 * {executable_path, args, env, firefox_user_prefs, headless} — where `env`
 * carries the generated fingerprint in CAMOU_CONFIG_* chunks. That is the whole
 * value of camoufox, so we take it verbatim instead of reimplementing it.
 *
 * Deliberately NOT `camoufox server`: that mode cannot open a persistent
 * profile, and `-p <name>` logins surviving close→open matter more than the
 * simpler wiring.
 *
 * Returns null when camoufox isn't importable or its browser isn't fetched, so
 * the caller can fall back to Chromium instead of dying.
 */
let _camouOpts; // undefined = unresolved · object = options · null = unavailable
function camoufoxLaunchOptions() {
  if (_camouOpts !== undefined) return _camouOpts;
  // `window` MUST match the viewport we then hand Playwright. Camoufox
  // generates screen/window.outer* metrics as part of the fingerprint; if
  // Playwright afterwards forces a different viewport, the page reports a
  // window that disagrees with its own screen — a classic automation tell, and
  // in testing it was the difference between clearing Cloudflare and sitting on
  // the challenge forever. `humanize` adds human-like cursor timing.
  const script =
    "import json,sys;from camoufox.utils import launch_options;" +
    `print(json.dumps(launch_options(headless=True,humanize=True,window=(${VIEWPORT.width},${VIEWPORT.height}),i_know_what_im_doing=True)))`;
  // camoufox is a Python package but this skill is global, so a project venv is
  // no good. `uv tool install camoufox` is the normal way in, and its venv
  // python is not on PATH — look there before falling back to a system python
  // that happened to pip-install it.
  const candidates = [
    process.env.BROWSE_CAMOUFOX_PYTHON,
    join(homedir(), ".local/share/uv/tools/camoufox/bin/python"),
    "python3",
  ].filter(Boolean);
  for (const py of candidates) {
    try {
      const r = spawnSync(py, ["-c", script], { encoding: "utf8", timeout: 60000 });
      if (r.status !== 0) continue;
      const opts = JSON.parse(r.stdout);
      if (!opts?.executable_path || !existsSync(opts.executable_path)) {
        logDaemon(`camoufox (${py}) reports no browser binary — run \`${py} -m camoufox fetch\``);
        continue;
      }
      logDaemon(`camoufox options from ${py}`);
      return (_camouOpts = opts);
    } catch { /* try the next candidate */ }
  }
  logDaemon(`no usable camoufox python (tried: ${candidates.join(", ")})`);
  return (_camouOpts = null);
}

async function daemon() {
  // A rejected promise nobody awaited must never take the session down. Node's
  // default is to kill the process, and this daemon runs with stdio "ignore" —
  // so the browser, every tab, every cookie and the whole unfinalized recording
  // would vanish, and the only thing the agent would see is `socket hang up`.
  // `browse middleware` makes this reachable from agent-authored code, but any
  // stray Playwright rejection had the same power. Log it and stay up.
  process.on("unhandledRejection", (e) => {
    logDaemon(`unhandled rejection (session kept alive): ${e?.stack || e}`);
  });
  process.on("uncaughtException", (e) => {
    logDaemon(`uncaught exception (session kept alive): ${e?.stack || e}`);
  });
  mkdirSync(OUT, { recursive: true });
  mkdirSync(VIDEO_DIR, { recursive: true });
  mkdirSync(SHOTS_DIR, { recursive: true });
  logDaemon(`starting daemon (session ${SESSION}, out ${OUT})`);

  // Resolve Playwright from ~/.browse/node_modules (next to this file), or
  // wherever BROWSE_PW_BASE points. ESM import doesn't honour NODE_PATH, so we
  // use a CJS require anchored there.
  const require = createRequire(process.env.BROWSE_PW_BASE || SELF);
  const { chromium } = require("playwright");
  // camoufox is BUILT AGAINST a specific Playwright (0.5.4 → 1.60.0) and its
  // Firefox speaks that exact juggernaut protocol. Driving it with a newer one
  // fails at launch — 1.61 sends `viewport.isMobile`, which the build rejects
  // outright. So load Firefox from the pinned copy in ~/.browse/camoufox-pw
  // when it exists, and only fall back to the main install.
  // `browse setup` (and the launcher, on first sight of camoufox) installs that
  // pinned copy. Without it we still TRY the main install, but the launch almost
  // certainly fails — so remember why, to turn the eventual chromium fallback
  // from a mystery into one actionable line.
  let pinnedMissing = false;
  const firefoxFor = () => {
    const pinned = join(BROWSE_HOME, "camoufox-pw", "package.json");
    if (existsSync(pinned)) {
      try { return createRequire(pinned)("playwright-core").firefox; }
      catch (e) { logDaemon(`pinned camoufox playwright unusable: ${e.message}`); }
    }
    pinnedMissing = true;
    return require("playwright").firefox;
  };

  // PROFILE (module-level, from `-p <name>` / BROWSE_PROFILE) keeps cookies +
  // localStorage in its own user-data dir, so logins and tokens SURVIVE
  // close→open (one browser at a time per profile — the dir is locked while
  // live). Without it, every session is a throwaway context: nothing persists.
  // Resolve the engine. camoufox is the default but must degrade gracefully:
  // if its Python package or browser build is missing we log and fall back to
  // Chromium rather than leaving the agent with a dead daemon.
  // A fallback used to be visible ONLY in browsed.log, so a user who had
  // installed camoufox got silently downgraded to Chromium with no way to tell.
  // Whatever lands here is echoed on the first `open`.
  let engineNote = null;
  // Playwright's launch errors are a multi-KB protocol dump — useless inline,
  // so the note stays one actionable line and the full text goes to browsed.log.
  const fallback = (note, detail) => { engineNote = note; logDaemon(detail ? `${note} :: ${detail}` : note); };
  let engine = ENGINE, camouOpts = null;
  if (engine === "camoufox") {
    camouOpts = camoufoxLaunchOptions();
    if (!camouOpts) {
      fallback("camoufox not installed — using chromium. Set it up with " +
               "`uv tool install camoufox` then " +
               "`~/.local/share/uv/tools/camoufox/bin/python -m camoufox fetch`, " +
               "and re-run `browse setup`.");
      engine = "chromium";
    }
  }
  logDaemon(`engine ${engine}${engine === "camoufox" ? ` (${camouOpts.executable_path})` : ""}`);
  // recordVideo on the CONTEXT ⇒ the whole session is captured; flushed on close.
  const recordVideo = { dir: VIDEO_DIR, size: VIEWPORT };
  let browser = null, context;

  // One launch attempt for a given engine, so a camoufox failure (missing build,
  // protocol skew after an upgrade, …) can retry on Chromium instead of leaving
  // the agent with a dead daemon and a stack trace.
  const launchWith = async (eng) => {
    const camou = eng === "camoufox";
    const launcher = camou ? firefoxFor() : chromium;
    const args = camou ? (camouOpts.args || [])
      : (process.platform === "linux" ? ["--no-sandbox", "--disable-dev-shm-usage"] : []);
    const extra = camou
      ? { executablePath: camouOpts.executable_path,
          env: camouOpts.env,
          firefoxUserPrefs: camouOpts.firefox_user_prefs }
      : {};
    if (PROFILE) {
      // Firefox profiles and Chromium user-data dirs are different formats, so
      // camoufox gets its own dir rather than corrupting an existing one.
      const userDataDir = join(BROWSE_HOME, "profiles", camou ? `${PROFILE}-camoufox` : PROFILE);
      mkdirSync(userDataDir, { recursive: true });
      // Camoufox refuses to start when another copy holds the profile ("A copy
      // of Camoufox is already open"), and a crashed session leaves one behind.
      if (camou) {
        try { spawnSync("pkill", ["-f", userDataDir], { timeout: 10000 }); } catch { /* best-effort */ }
      }
      logDaemon(`persistent profile '${PROFILE}' (${userDataDir})`);
      // launchPersistentContext returns the context directly (no separate browser
      // handle); recordVideo still captures the whole session just like below.
      // This is why we build camoufox from launch_options() rather than using its
      // `camoufox server` mode: server mode cannot do a persistent profile, and
      // `-p` logins surviving close→open is the whole point of profiles.
      return { browser: null, context: await launcher.launchPersistentContext(userDataDir, {
        headless: !HEADFUL, viewport: VIEWPORT, recordVideo, args, ...extra,
      }) };
    }
    const b = await launcher.launch({ headless: !HEADFUL, args, ...extra });
    return { browser: b, context: await b.newContext({ viewport: VIEWPORT, recordVideo }) };
  };

  try {
    ({ browser, context } = await launchWith(engine));
  } catch (e) {
    if (engine !== "camoufox") throw e;
    fallback("camoufox failed to launch — using chromium. " + (pinnedMissing
      ? "Its pinned playwright-core is missing: run `browse setup`."
      : "See browsed.log in the session dir."), e.message);
    engine = "chromium";
    ({ browser, context } = await launchWith(engine));
  }
  context.__engine = engine; // read by the CDP-only guards below
  context.__engineNote = engineNote; // surfaced once, on the first `open`
  // Draw the animated cursor + keystroke overlay into every page (before the
  // page's own scripts run, and re-run on each navigation) so the recording shows
  // the pointer moving and the keys being pressed, like screen-recording software.
  if (CURSOR) await context.addInitScript(cursorInitScript);
  if (KEYLOG) await context.addInitScript(keylogInitScript);
  // Keep "open in a new tab" in THIS tab, so the demo never splits across two
  // video files (see popupSameTabInitScript). BROWSE_POPUPS=1 opts out.
  if (!POPUPS) await context.addInitScript(popupSameTabInitScript);

  // Anchor for `browse speed` marks. Playwright's video timeline runs in real
  // time from ~page creation, so (Date.now()-recStartMs)/1000 is the raw-video
  // timestamp analyzeVideo works in; the padSecs cushion absorbs the small
  // start-up offset. Each `browse speed` pushes { t, factor } here.
  const recStartMs = Date.now();
  const now = () => (Date.now() - recStartMs) / 1000;
  const speedMarks = []; // { t: secondsSinceRecStart, factor } — factor 1 = "off"
  // Raw-video intervals that must survive the dead-air cut at real time — the
  // on-screen life of each toast, so viewers get to read it. end=Infinity is an
  // open sticky toast, closed by the next toast / --clear.
  const keepMarks = []; // { start, end } in secondsSinceRecStart
  // Raw-video intervals the finalizer must CUT no matter what: the stretches
  // spent on an UNINTENDED popup - a page the site opened at us, which we
  // auto-switched to. Its frames went into its own .webm, so the clip we finalize
  // only shows a frozen main tab there, and skipping it is usually right anyway
  // (an OAuth consent screen with the user's email doesn't belong in a shared
  // demo). A tab the agent asked for with `browse target new` is NOT cut: it is
  // deliberate footage, and silently deleting a demo the agent just recorded is
  // far worse than leaving a stretch the dead-air pass will handle on its own.
  const cutMarks = []; // { start, end } - end=Infinity while still on that popup
  // One chapter marker per command the agent ran, mapped onto the finalized
  // timeline at close (see writeChapters).
  const stepMarks = []; // { t, cmd }

  const errors = [];
  const noteErr = (s) => { if (errors.length < 200) errors.push(s); };
  // Things that happen WITHOUT a command asking for them - a dialog answered, a
  // download saved, a popup we switched to. Queued here and appended to the next
  // command's result the same way new console errors are (see the POST handler),
  // so the agent hears about them without a verb to poll.
  const notes = [];
  const note = (s) => { if (notes.length < 50) notes.push(s); };

  // Every page of the context in the order it appeared, and which one commands
  // drive: `page` is always pages[activeIdx]. `activeFrame` (set by
  // `browse target "iframe#x"`) scopes element lookups one level deeper - see L().
  const pages = [];
  let activeIdx = 0;
  let page = null;
  let activeFrame = null, activeFrameSel = null;
  // One-shot dialog policy from `--dialog accept|dismiss[:text]`, consumed by the
  // next dialog the page raises. null = the default (accept).
  let dialogPolicy = null;
  // The most recent `browse state --load` payload ({ clean, origins }), served to
  // the single localStorage init script through a binding (see the `state` case).
  let stateOrigins = null;
  let stateScriptInstalled = false;
  // The speed badge can't render on every ffmpeg; say so once, not every time.
  let badgeWarned = false;
  // Set while WE are opening a tab (`browse target new`), so the context's page
  // listener can tell a deliberate tab from a popup the site threw at us.
  let openingTab = false;
  // Pages the AGENT asked for. Intent has to be tracked, not inferred: every page
  // except the first looks identical afterwards, and getting this wrong means
  // either cutting a demo the agent deliberately recorded or keeping a consent
  // screen nobody wanted to publish.
  const wantedPages = new WeakSet();

  /** Bring the active tab to the front. A backgrounded tab throttles
   *  requestAnimationFrame, which stalls the cursor glide and smooth scroll, so
   *  this is not cosmetic. Best-effort: headless has nothing to raise. */
  async function focusActive() {
    try { await page.bringToFront(); } catch { /* headless / already gone */ }
  }

  /** Make pages[i] the page commands drive, keeping cutMarks in sync. Only an
   *  UNWANTED popup opens a cut interval - see cutMarks. */
  function activate(i) {
    activeIdx = Math.max(0, Math.min(pages.length - 1, i));
    page = pages[activeIdx];
    activeFrame = null; activeFrameSel = null; // a frame scope belongs to its tab
    const open = cutMarks.find((c) => c.end === Infinity);
    const cuttable = page !== primaryPage && !wantedPages.has(page);
    if (!cuttable) { if (open) open.end = now(); }
    else if (!open) cutMarks.push({ start: now(), end: Infinity });
    focusActive(); // fire and forget: nothing downstream should wait on a raise
    return page;
  }

  /** Attach the per-page listeners. Runs for EVERY page (the first one and any
   *  popup): console errors, dialogs and downloads all fire on the page that
   *  produced them, not on the context, so a popup would otherwise be silent. */
  function wirePage(p) {
    p.on("console", (m) => { if (m.type() === "error") noteErr("console: " + m.text()); });
    p.on("pageerror", (e) => noteErr("pageerror: " + (e?.message || e)));
    // An unanswered alert/confirm/prompt BLOCKS the page, so without this the
    // NEXT command just times out with nothing on screen to explain why. Accept
    // is the demo path; `--dialog dismiss` on the triggering command overrides.
    p.on("dialog", async (d) => {
      const policy = dialogPolicy;
      dialogPolicy = null;
      const dismiss = policy?.action === "dismiss";
      try {
        if (dismiss) await d.dismiss();
        else await d.accept(policy?.text ?? "");
      } catch { /* the page moved on and took the dialog with it */ }
      note(`dialog(${d.type()}): ${JSON.stringify(d.message())} → ${dismiss ? "dismissed" : "accepted"}`);
    });
    // A download renders nothing, so it is invisible both on video and in the
    // command's result unless we say where the file landed.
    p.on("download", async (d) => {
      const dir = join(OUT, "downloads");
      const file = join(dir, sanitizeName(d.suggestedFilename() || `download-${Date.now()}`));
      try { mkdirSync(dir, { recursive: true }); await d.saveAs(file); note(`download: ${file}`); }
      catch (e) { note(`download failed: ${e?.message || e}`); }
    });
    p.on("close", () => {
      // During teardown every page closes at once; re-activating siblings then
      // would only add bogus cut intervals to a recording we're already cutting.
      if (closing) return;
      const i = pages.indexOf(p);
      if (i < 0) return;
      const wasActive = i === activeIdx;
      pages.splice(i, 1);
      if (!pages.length) return; // the whole context is going away (close/idle)
      activate(wasActive ? Math.max(0, i - 1) : i < activeIdx ? activeIdx - 1 : activeIdx);
    });
  }

  // A persistent context spawns with one blank page already open — reuse it.
  page = context.pages()[0] ?? (await context.newPage());
  pages.push(page);
  wirePage(page);
  // The PRIMARY page owns the recording: recordVideo is per context, but
  // Playwright writes one .webm per PAGE and this is the one we finalize.
  const primaryPage = page;
  // The recording handle for this page. recordVideo is on the CONTEXT, so the
  // whole session lands in ONE .webm; we surface its EXACT path on `close`
  // so the caller gets the file it just recorded — never a guessed glob or a
  // stale/leftover .webm sitting in the artifacts dir.
  const video = page.video();

  // A popup or a tab the page opened itself: wire it and SWITCH to it, because
  // an agent left driving the page behind the popup is stranded with no way to
  // notice. `browse target <n>` switches back.
  context.on("page", (p) => {
    if (pages.includes(p)) return;
    if (openingTab) wantedPages.add(p); // `browse target new`, not a popup
    wirePage(p);
    pages.push(p);
    activate(pages.length - 1);
    if (!openingTab) note(`↗ switched to popup tab ${activeIdx}: ${p.url() || "about:blank"} · 'browse target' lists tabs · this popup's time is CUT from the video (only the first tab is recorded)`);
  });

  /** Resolve a selector against whatever is in scope right now: the active tab,
   *  or the iframe `browse target "iframe#x"` scoped into. Every element method
   *  we use exists on Locator, so this is the ONLY place tabs and frames have to
   *  be thought about - including the cursor glide, since a Locator's
   *  boundingBox() is already in main-frame (i.e. video) coordinates. */
  const L = (sel) => (activeFrame ?? page).locator(sel);

  /** The same scope as L(), but as a Frame — `eval` needs a real execution
   *  context and a FrameLocator has none. Resolved per call: the iframe element
   *  can be replaced between commands, and a stale handle would evaluate against
   *  a detached document. */
  async function frameForEval() {
    // elementHandle THROWS a raw locator timeout when the iframe is gone, so the
    // guidance has to hang off the catch, not off a null check.
    let h;
    try { h = await page.locator(activeFrameSel).first().elementHandle({ timeout: 8000 }); }
    catch { h = null; }
    const f = h && (await h.contentFrame());
    if (!f) throw new Error(`eval: the frame scope '${activeFrameSel}' is no longer on the page - run 'browse target top' to leave it, or re-scope with 'browse target <iframe selector>'`);
    return f;
  }

  // `browse emulate` overrides (timezone, locale, cpu, network) live on a CDP
  // session and die with it, so we keep ONE session per page rather than opening
  // a fresh one per call - detaching would quietly undo what was just set.
  const emuSessions = new WeakMap(); // page → CDPSession
  async function emuCdp() {
    // CDP is Chromium-only. Under camoufox (Firefox) there is no equivalent, so
    // say so plainly instead of throwing Playwright's "newCDPSession is not a
    // function" at the agent.
    if (context.__engine !== "chromium")
      throw new Error(
        `emulate needs CDP, which only Chromium has (engine: ${context.__engine}). ` +
        `Re-run this session with --chromium.`);
    let s = emuSessions.get(page);
    if (!s) { s = await context.newCDPSession(page); emuSessions.set(page, s); }
    return s;
  }

  // Keep the caller snappy: a missing selector should fail in seconds (so it can
  // adapt), not block on Playwright's 30s default. Navigation gets a bit longer.
  context.setDefaultTimeout(12000);
  context.setDefaultNavigationTimeout(25000);

  // ---------------------------------------------------------------- network
  // Log EVERY request the context makes (all pages, frames, workers, popups) to
  // network.jsonl, one JSON object per line, as it finishes. The file lives in
  // the session dir and outlives the daemon, so `browse net` can query the same
  // log live and after close. Purely observational — never fails a command.
  const NET_FILE = netFileIn(OUT);
  const netStart = new WeakMap(); // request → { i, t0 }
  // Requests a `browse middleware` rule ANSWERED, so the log can say so. Without
  // this an agent's own `route.abort()` reads as an organic network failure in
  // `browse net --failed`, and a mocked 200 is indistinguishable from a real one
  // — the log stops being evidence exactly when it matters most. A rule that
  // fell back is deliberately NOT recorded: it matched, but the response is
  // still whatever the origin said, and calling that "mocked" is the same lie in
  // the other direction.
  const mwMarks = new WeakMap(); // request → { pattern, via }
  let netSeq = 0;
  const netAppend = (e) => { try { appendFileSync(NET_FILE, JSON.stringify(e) + "\n"); } catch { /* best effort */ } };
  async function netRecord(req, error) {
    const meta = netStart.get(req) || { i: ++netSeq, t0: Date.now() };
    netStart.delete(req);
    const e = {
      i: meta.i,
      t: Number(((meta.t0 - recStartMs) / 1000).toFixed(2)), // seconds into the recording
      at: new Date(meta.t0).toISOString(),
      ms: Date.now() - meta.t0,
      method: req.method(),
      url: req.url(),
      type: req.resourceType(),
    };
    const mock = mwMarks.get(req);
    if (mock) { e.mock = mock.pattern; e.mockVia = mock.via; }
    if (error) e.error = error;
    try { e.reqHeaders = netRedact(await req.allHeaders()); } catch { /* gone */ }
    if (NET.bodies) {
      try { const post = req.postData(); if (post) e.reqBody = netClip(post); } catch { /* binary/none */ }
    }
    let res = null;
    try { res = await req.response(); } catch { /* failed before a response */ }
    if (res) {
      e.status = res.status();
      e.ok = res.ok();
      try { e.resHeaders = netRedact(await res.allHeaders()); } catch { /* gone */ }
      e.mime = String(e.resHeaders?.["content-type"] || "").split(";")[0];
      try { e.size = (await req.sizes()).responseBodySize; } catch { /* unknown */ }
      // Bodies only for text-ish types (JSON APIs are the point) and only up to
      // NET.bodyMax — never pull a video/image payload into the log.
      if (NET.bodies && NET.bodyMax > 0 && NET_TEXTY.test(e.mime)) {
        try { e.resBody = netClip((await res.body()).toString("utf8")); } catch { /* redirect/no body */ }
      }
    }
    netAppend(e);
  }
  if (NET.on) {
    context.on("request", (req) => { netStart.set(req, { i: ++netSeq, t0: Date.now() }); });
    context.on("requestfinished", (req) => { netRecord(req, null).catch(() => {}); });
    context.on("requestfailed", (req) => {
      let why = "request failed";
      try { why = req.failure()?.errorText || why; } catch { /* gone */ }
      netRecord(req, why).catch(() => {});
    });
  }

  // ------------------------------------------------------------- middleware
  // `browse middleware <pattern> '<route handler>'` — request interception. The
  // handler is compiled and run HERE, in the daemon, against the real Playwright
  // Route, so the agent gets the whole API (fulfill/abort/continue/fallback/fetch)
  // instead of a wrapper that only covers the cases we thought of.
  //
  // Registered on the CONTEXT, not the page: a mock has to hold across tabs,
  // iframes and workers, or it silently stops applying the moment a popup opens.
  // Newest-first is Playwright's own order (context.route unshifts), and this
  // array is kept in the same order so the listing IS the match order.
  const middleware = []; // { pattern, handler, hits, errs, warned }
  // console.* inside a handler has nowhere to go — the daemon is spawned with
  // stdio "ignore" — so give it the session log instead of a black hole. A Proxy
  // rather than a fixed list of levels: console.table/group/time are rare but a
  // missing one is a TypeError that aborts the request and reads like a browse bug.
  const mwFormat = (v) => {
    if (typeof v === "string") return v;
    try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
  };
  const mwConsole = new Proxy({}, {
    get: (_t, level) => (...a) => logDaemon(`middleware console.${String(level)}: ${a.map(mwFormat).join(" ")}`),
  });

  /** Compile handler source into a function. `console` is passed as a parameter
   *  so it SHADOWS the global one inside the handler (see mwConsole). */
  function mwCompile(src) {
    let fn;
    // A trailing `;` is what anyone writes by reflex and would otherwise land
    // inside `return (…)` as a syntax error pointing at nothing; the newlines
    // keep a trailing `// comment` from swallowing the closing paren.
    const clean = String(src).replace(/[\s;]+$/, "");
    try { fn = new Function("console", `"use strict"; return (\n${clean}\n);`)(mwConsole); }
    // V8 quotes the offending token ("Unexpected identifier 'apiSecret'"), so the
    // detail goes on a LATER line: the caller sees all of it on stderr, and the
    // transcript — which keeps only the first line — can never pick up a
    // fragment of the source.
    catch (e) { throw new Error(`middleware: that handler didn't compile.\n  ${e.message}\n  It must be a single function expression, e.g. 'route => route.fulfill({json: {ok: true}})'`); }
    // The example goes on a SECOND line on purpose: the transcript records only
    // the first line of an error, and an arrow function there would be
    // indistinguishable from a leaked handler.
    if (typeof fn !== "function")
      throw new Error(`middleware: expected a function expression, got ${typeof fn}\ne.g. 'route => route.abort()'`);
    return fn;
  }

  /** The four ways a handler may answer its route. */
  const MW_ANSWERS = new Set(["fulfill", "abort", "continue", "fallback"]);

  /** Hand the handler the real Route, but notice the MOMENT it answers.
   *
   *  `route => { route.fulfill(…) }` — block body, no `return` — is the shape
   *  everyone writes, and it hands us back a resolved promise while fulfill is
   *  still mid-IPC. Playwright only clears its internal handling promise once
   *  that round-trip lands, so asking "is it handled yet?" afterwards answers NO,
   *  and a safety-net fallback() there would pass the request through untouched
   *  and then crash the daemon when the real fulfill finally reported in. So
   *  answering is recorded SYNCHRONOUSLY, at call time, and the promise is kept
   *  so we can wait for it before deciding anything. */
  function mwTrack(route, state) {
    return new Proxy(route, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (typeof v !== "function") return v;
        if (!MW_ANSWERS.has(prop)) return v.bind(target);
        return (...a) => {
          state.answered = true;
          state.via = prop; // fallback() answers the route but changes nothing
          const p = v.apply(target, a);
          // Attaching a catch here also ADOPTS the rejection, so an un-awaited
          // `route.fulfill()` that fails can't take the whole daemon down.
          state.pending.push(Promise.resolve(p).catch((e) => { state.error ??= e; }));
          return p;
        };
      },
    });
  }

  /** Wrap a compiled handler so neither an exception nor a forgotten
   *  fulfill/abort/continue/fallback can wedge the page or the daemon. */
  function mwWrap(entry, fn) {
    return async (route) => {
      entry.hits++;
      let url = "", req = null;
      try { req = route.request(); url = req.url(); } catch { /* gone */ }
      // Record only once the rule has actually ANSWERED, and only when the answer
      // changed something — see mwMarks.
      const mark = (via) => { if (req) mwMarks.set(req, { pattern: entry.pattern, via }); };
      const state = { answered: false, via: null, pending: [], error: null };
      try {
        await fn(mwTrack(route, state));
        // An un-awaited answer is still in flight here. Let it land before
        // judging anything, or we race the handler's own decision.
        await Promise.all(state.pending);
        if (state.error) throw state.error;
      } catch (e) {
        entry.errs++;
        // The route is unanswered unless the throw came after it was answered,
        // in which case abort() just tells us so — and saying "aborted" then
        // would be a lie about a request that actually went through.
        let aborted = false;
        try { await route.abort(); aborted = true; } catch { /* already answered */ }
        // A request this rule killed must not read as an organic network failure.
        if (aborted) mark("abort");
        else if (state.via && state.via !== "fallback") mark(state.via);
        mwThrew(entry, url, stripAnsi(e && e.message ? e.message : String(e)), aborted);
        logDaemon(`middleware '${entry.pattern}' threw on ${url}: ${e?.stack || e}`);
        return;
      }
      if (state.answered) {
        if (state.via !== "fallback") mark(state.via);
        return;
      }
      // Playwright waits on a promise only fulfill/abort/continue/fallback
      // resolve, so a handler that answers nothing hangs that request until it
      // times out — with nothing on screen or in the log to explain it. Fall the
      // request through instead, and say so once per rule.
      try { await route.fallback(); } catch { /* the context is going away */ }
      if (!entry.warned) {
        entry.warned = true;
        note(`middleware '${entry.pattern}' returned without calling fulfill/abort/continue/fallback, so the request was passed through untouched (said once per rule)`);
      }
    };
  }

  // A rule matching '**/api/**' on a busy page throws once per REQUEST. Reporting
  // each one would bury the command's actual result and blow past the 50-note cap
  // — which then silently eats the dialog/download notes too. So throws are
  // counted per rule here and collapsed into one line when the next command reports.
  const mwThrows = new Map(); // entry → { n, url, msg, aborted }
  function mwThrew(entry, url, msg, aborted) {
    const agg = mwThrows.get(entry) || { n: 0 };
    mwThrows.set(entry, { n: agg.n + 1, url, msg, aborted });
  }
  function mwFlushThrows() {
    for (const [entry, a] of mwThrows) {
      note(a.n === 1
        ? `middleware '${entry.pattern}' threw on ${a.url}: ${a.msg}${a.aborted ? " — request aborted" : " — the route had already been answered, so it was NOT aborted"}`
        : `middleware '${entry.pattern}' threw on ${a.n} requests — last, ${a.url}: ${a.msg}`);
    }
    mwThrows.clear();
  }

  // How many errors we've already shown the caller. New ones past this cursor are
  // appended inline to the next command's result (see the POST handler), so a
  // runtime fault surfaces even when the caller never runs `browse errors`.
  let reportedErrors = 0;

  let step = 0;
  logTranscript(`# browse session\n\n_Started ${new Date().toISOString()} — recording to \`video/\`._\n\n`);

  /** Flush the recording and finalize the mp4. Shared by `close` and the idle
   *  timer; runs at most once. */
  let closing = false;
  async function closeSession(reason, { keepRaw = KEEP_WEBM } = {}) {
    if (closing) return null;
    closing = true;
    // Close any still-open interval so the finalizer sees a bounded one: a
    // session that ends on a popup would otherwise carry end=Infinity.
    const openCut = cutMarks.find((c) => c.end === Infinity);
    if (openCut) openCut.end = now();
    logTranscript(`\n_Session closed ${new Date().toISOString()} (${reason})._\n`);
    try { await context.close(); } catch { /* already gone */ } // flushes the .webm
    try { if (browser) await browser.close(); } catch { /* already gone */ } // no-op for persistent profiles
    // Report the EXACT saved path so the caller gets the file it just recorded.
    // The .webm is finalized by context.close() above, so page.video().path()
    // now points at a real file.
    // video.path() returns the path the engine was ASKED to write, which exists
    // only if the engine actually recorded. An engine that took the recordVideo
    // option and then wrote nothing (camoufox with an unpatched playwright-core)
    // otherwise reported a path to a missing file, and `close` blamed ffmpeg.
    let webm = null;
    try { webm = video ? await video.path() : null; } catch { /* no video */ }
    if (webm && !existsSync(webm)) {
      logDaemon(`engine '${engine}' recorded no video (expected ${webm})`);
      webm = null;
    }
    const mp4 = webm ? finalizeRecording(webm, { speedMarks, keepMarks, cutMarks, stepMarks }) : null;
    if (mp4 && !keepRaw) {
      // The mp4 is the deliverable — the raw .webm is just its temp source.
      // Keep it only when the mp4 could not be written (it's the sole recording),
      // or when the caller asked to (--keep-raw / BROWSE_KEEP_WEBM=1) so the
      // session can be re-cut later without re-recording it.
      try { rmSync(webm, { force: true }); rmSync(VIDEO_DIR, { recursive: true, force: true }); } catch { /* keep it */ }
      webm = null;
    }
    if (webm || mp4) logTranscript(`_Recording saved: ${mp4 || webm}_\n`);
    // Retire this session's run file — but only if it is still ours.
    try {
      const info = JSON.parse(readFileSync(runFile(SESSION), "utf8"));
      if (info.pid === process.pid) rmSync(runFile(SESSION), { force: true });
    } catch { /* already gone */ }
    return { webm, mp4 };
  }

  let idleT = null;
  function armIdle() {
    if (!IDLE_MS) return;
    clearTimeout(idleT);
    idleT = setTimeout(async () => {
      // A client-initiated close may already be running: closeSession() would
      // no-op on `closing` and we would exit out from under it, killing the
      // ffmpeg finalize and leaving the session with a raw .webm and no mp4
      // (seen for real on a long session). That close exits by itself.
      if (closing) return;
      logDaemon(`idle for ${IDLE_MS}ms — closing session`);
      await closeSession("idle timeout");
      process.exit(0);
    }, IDLE_MS);
  }

  async function autoShot(cmd) {
    step++;
    const name = `step-${String(step).padStart(2, "0")}-${cmd}.png`;
    try { await page.screenshot({ path: `${SHOTS_DIR}/${name}`, timeout: 5000 }); return `shots/${name}`; }
    catch { return null; }
  }

  function coerce(cmd, args) {
    if (cmd === "goto") return [args[0], { waitUntil: "domcontentloaded", timeout: 20000 }];
    if (cmd === "waitForTimeout") return [Number(args[0] || 1000)];
    return args;
  }

  async function brief() {
    let title = "";
    try { title = await page.title(); } catch { /* mid-navigation */ }
    return `${title ? title + " — " : ""}${page.url()}`;
  }

  /** Inject (or clear) the demo NOTE toast — a white capsule in the iOS Dynamic
   *  Island idiom: it appears in place as a small pill and springs open to fit
   *  its content (symmetric, center-out) with a slight overshoot; the content
   *  fades/deblurs in a beat behind the expansion. No slide-in from the screen
   *  edge, no backdrop blur. A hairline accent bar sweeps left-to-right along
   *  the top edge over the toast's lifetime so the viewer can see it is about to
   *  go. Dismissal contracts back to the pill and fades. Auto-dismisses after
   *  roughly reading time unless sticky. A single reused node (id
   *  __ups_browse_toast__) so repeated calls replace rather than stack.
   *  Best-effort — a toast hiccup must never fail the command. */
  async function showToast({ text, color, pos, clear, sticky, durMs }) {
    try {
      await page.evaluate(({ text, color, pos, clear, sticky, durMs }) => {
        const ID = "__ups_browse_toast__";
        const COLLAPSED = "52px";
        const COLLAPSED_H = "40px"; // one text line + vertical padding
        const prev = document.getElementById(ID);
        const dismiss = (el) => {
          if (!el || !el.isConnected) return;
          clearTimeout(el.__browseToastTimer);
          const out = "cubic-bezier(.4,0,1,1)";
          const inner = el.firstElementChild;
          if (inner) { inner.style.transition = `opacity .1s ${out}`; inner.style.opacity = "0"; }
          el.style.transition = `width .2s ${out} .04s,height .2s ${out} .04s,transform .2s ${out} .04s,opacity .14s ${out} .1s`;
          el.style.width = COLLAPSED;
          el.style.height = COLLAPSED_H;
          el.style.transform = "translateX(-50%) scale(.8)";
          el.style.opacity = "0";
          setTimeout(() => el.remove(), 280);
        };
        if (clear || !text) { dismiss(prev); return; }
        if (prev) { clearTimeout(prev.__browseToastTimer); prev.remove(); }
        text = String(text).replace(/\s*[—–]\s*/g, " · "); // house style: no em dashes on camera
        // Mid-weight accents: saturated enough to read as a status colour on a
        // white capsule, dark enough not to glow out at 6px.
        const ACCENT = {
          yellow: "#f59e0b", blue: "#3b82f6", green: "#10b981",
          red: "#ef4444", neutral: "#71717a", dark: "#71717a",
        };
        const accent = ACCENT[color] || ACCENT.yellow;
        const bottom = pos === "bottom";
        // Gently springy back-out curve: a small overshoot, then settles — the
        // Dynamic Island feel without wobble. Content uses plain ease-out.
        const spring = "cubic-bezier(.3,1.15,.5,1)";
        const el = document.createElement("div");
        el.id = ID;
        el.style.cssText =
          "position:fixed;left:50%;z-index:2147483647;max-width:min(560px,90vw);" +
          "display:flex;justify-content:center;box-sizing:border-box;overflow:hidden;" +
          "background:#fff;color:rgba(0,0,0,.86);" +
          // Hairline ring + a tight contact shadow under a soft ambient one, so
          // the capsule lifts off light page backgrounds instead of dissolving.
          "box-shadow:0 0 0 1px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.07),0 8px 28px rgba(0,0,0,.16);" +
          "font:450 13.5px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
          "letter-spacing:.005em;padding:10px 18px;border-radius:999px;" +
          "pointer-events:none;will-change:width,height,transform,opacity;" +
          (bottom ? "bottom:22px;" : "top:14px;") +
          "transform:translateX(-50%);";
        const inner = document.createElement("div");
        inner.style.cssText =
          // shrinkable while we measure, so long text wraps inside max-width
          // instead of overflowing the capsule and getting clipped mid-word;
          // locked to its measured width afterwards (see below).
          "flex:0 1 auto;min-width:0;display:flex;gap:9px;align-items:flex-start;" +
          "opacity:0;filter:blur(4px);transition:opacity .16s ease-out .07s,filter .16s ease-out .07s;";
        const dot = document.createElement("span");
        // margin-top centers the 6px dot on the first text line (13.5px * 1.45).
        dot.style.cssText =
          `flex:none;width:6px;height:6px;margin-top:7px;border-radius:50%;` +
          `background:${accent};box-shadow:0 0 0 3px ${accent}1f;`;
        const tx = document.createElement("span");
        tx.style.cssText = "min-width:0;overflow-wrap:anywhere;";
        tx.textContent = text;
        inner.append(dot, tx);
        el.append(inner);
        document.body.appendChild(el);
        // Measure the natural size, then lock the inner width so the text keeps
        // its layout while the capsule's width animates around it (overflow
        // clips both sides evenly thanks to justify-content:center).
        const box = el.getBoundingClientRect();
        const w = Math.ceil(box.width);
        const h = Math.ceil(box.height);
        // measure while still shrinkable (wrapped), THEN freeze — flex:none first
        // would snap it back to max-content and re-flatten the text to one line.
        inner.style.width = Math.ceil(inner.getBoundingClientRect().width) + "px";
        inner.style.flex = "none";
        // Wrapped text makes a tall capsule; a full pill radius on that looks
        // like a lozenge, so soften to a rounded rect once past one line.
        if (h > 46) el.style.borderRadius = "18px";
        // Countdown: a hairline accent bar along the top edge that sweeps
        // left-to-right over the toast's life, so the viewer can see how much
        // reading time is left. Only for auto-dismissing toasts — a sticky one
        // has no deadline to draw. Absolutely positioned, so it never disturbs
        // the measurement above; scaleX (not width) keeps it on the compositor.
        // The pill's own border-radius clips its ends into a slight taper.
        const life = durMs || 4000;
        let bar = null;
        if (!sticky) {
          const track = document.createElement("div");
          track.style.cssText =
            "position:absolute;top:0;left:0;right:0;height:2.5px;background:rgba(0,0,0,.05);";
          bar = document.createElement("div");
          bar.style.cssText =
            `position:absolute;inset:0;background:${accent};opacity:.9;` +
            "transform:scaleX(0);transform-origin:left center;";
          track.append(bar);
          el.append(track);
        }
        el.style.width = COLLAPSED;
        el.style.height = COLLAPSED_H;
        el.style.transform = "translateX(-50%) scale(.6)";
        el.style.opacity = "0";
        // Double rAF: guarantees the browser paints the collapsed "from" state
        // before we flip to the expanded one, so the spring actually animates
        // even when the toast is injected the instant the page mounts.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            el.style.transition =
              `width .28s ${spring},height .28s ${spring},transform .28s ${spring},opacity .1s ease-out`;
            el.style.width = w + "px";
            el.style.height = h + "px";
            el.style.transform = "translateX(-50%) scale(1)";
            el.style.opacity = "1";
            inner.style.opacity = "1";
            inner.style.filter = "blur(0)";
            // Started here rather than at inject time so the sweep is linear
            // from the first painted frame; the ~1 frame it lags the dismiss
            // timer below is invisible against a multi-second life.
            if (bar) {
              bar.style.transition = `transform ${life}ms linear`;
              bar.style.transform = "scaleX(1)";
            }
          }));
        if (!sticky) el.__browseToastTimer = setTimeout(() => dismiss(el), life);
      }, { text, color, pos, clear, sticky, durMs });
    } catch { /* toast is decorative — never fail the command over it */ }
  }

  /** Glide the on-page cursor to an element's center before we act on it, so the
   *  recording shows the pointer travelling there. Best-effort: the real action
   *  must never be blocked or failed by a cursor hiccup. */
  async function cursorGlideTo(selector) {
    if (!CURSOR || !selector) return;
    try {
      const loc = L(selector).first();
      // Short timeouts: gliding the cursor is cosmetic, so a missing/typo'd
      // selector must NOT wait the context default here — humanType/page[cmd] is
      // what actually reports the error, and should do so fast.
      try { await loc.scrollIntoViewIfNeeded({ timeout: 1500 }); } catch { /* ignore */ }
      const b = await loc.boundingBox({ timeout: 1500 });
      if (!b) return;
      await page.evaluate(
        ([x, y]) => window.__browseCursor && window.__browseCursor.moveTo(x, y, 340),
        [b.x + b.width / 2, b.y + b.height / 2],
      );
    } catch { /* best-effort */ }
  }
  /** Scroll the way a hand on a trackpad does - an eased ~450ms glide, because an
   *  instant jump is indistinguishable from a hard cut on the recording.
   *
   *  Driven off requestAnimationFrame, which a BACKGROUNDED tab throttles to a
   *  stop - and page.evaluate is not covered by setDefaultTimeout, so a stalled
   *  animation would hang the daemon forever, not just fail. Hence the race and
   *  the instant fallback: the scroll always happens, only the prettiness of it
   *  is best-effort. Runs against the scoped frame's document, not always the
   *  top one. */
  const scrollInFrame = (fn, arg) => L("body").first().evaluate(fn, arg, { timeout: 8000 });
  async function smoothScroll(dy, dx) {
    const glide = scrollInFrame((body, [dy, dx]) => new Promise((resolve) => {
      const doc = body.ownerDocument;
      const win = doc.defaultView;
      const el = doc.scrollingElement || doc.documentElement;
      const sx = el.scrollLeft, sy = el.scrollTop;
      const tx = Math.max(0, Math.min(el.scrollWidth - el.clientWidth, sx + dx));
      const ty = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, sy + dy));
      const dur = 450;
      const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
      let t0;
      const frame = (ts) => {
        if (t0 === undefined) t0 = ts;
        const t = Math.min(1, (ts - t0) / dur), e = ease(t);
        el.scrollTo(sx + (tx - sx) * e, sy + (ty - sy) * e);
        if (t < 1) win.requestAnimationFrame(frame); else resolve();
      };
      win.requestAnimationFrame(frame);
    }), [dy, dx]);
    glide.catch(() => {}); // it may still be pending when the race is lost
    let stalled;
    try {
      await Promise.race([
        glide,
        new Promise((_, reject) => { stalled = setTimeout(() => reject(new Error("stalled")), 2500); }),
      ]);
      return;
    } catch { /* fall through to the instant scroll */ }
    finally { clearTimeout(stalled); }
    try {
      await scrollInFrame((body, [dy, dx]) => {
        const doc = body.ownerDocument;
        const el = doc.scrollingElement || doc.documentElement;
        el.scrollTo(el.scrollLeft + dx, el.scrollTop + dy);
      }, [dy, dx]);
    } catch { /* the page went away mid-scroll */ }
  }

  async function cursorClickFx() {
    if (!CURSOR) return;
    try { await page.evaluate(() => window.__browseCursor && window.__browseCursor.click()); }
    catch { /* best-effort */ }
  }

  async function keylogKey(key) {
    if (!KEYLOG || !key) return;
    const label = String(key).split("+").map((p) => KEY_LABEL[p] || p).join(" + ");
    try { await page.evaluate((l) => window.__browseKeys && window.__browseKeys.key(l), label); }
    catch { /* best-effort */ }
  }

  /** Enter text into a field the way a person does — click in, then press the
   *  keys one at a time (TYPE_DELAY apart) rather than pasting the whole value.
   *  `clear` wipes the field first (that's what `fill` means); `type` appends.
   *
   *  The keystroke overlay is shown here (not before the action) and only once the
   *  field is confirmed present, so a bad selector fails FAST (~6s, like the rest
   *  of browse) instead of hanging on the type, and the bezel never shows text that
   *  didn't actually get typed. Password fields are masked to bullets. */
  async function humanType(selector, text, clear) {
    const loc = L(selector).first();
    // Resolve the field quickly; a missing/typo'd selector should fail in seconds
    // so the caller adapts — not block for the full pressSequentially timeout.
    await loc.waitFor({ state: "visible", timeout: 4000 });
    try { await loc.click({ timeout: 4000 }); } catch { /* pressSequentially focuses it */ }
    if (clear) { try { await loc.fill("", { timeout: 4000 }); } catch { /* just type over it */ } }
    if (!text) return;
    if (KEYLOG) {
      let shown = text;
      try { if ((await loc.getAttribute("type")) === "password") shown = "•".repeat(text.length); }
      catch { /* show as-is */ }
      const cps = TYPE_DELAY > 0 ? 1000 / TYPE_DELAY : 1000;
      try { await page.evaluate(([t, c]) => window.__browseKeys && window.__browseKeys.type(t, c), [shown, cps]); }
      catch { /* best-effort */ }
    }
    await loc.pressSequentially(text, { delay: TYPE_DELAY, timeout: 20000 });
  }

  /** Tokens worth matching on: words from a selector or an accessible name, minus
   *  the selector-engine noise that every selector shares. */
  const HINT_NOISE = new Set(["text", "css", "xpath", "role", "name", "has", "div", "span", "the", "and"]);
  function hintTokens(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")
      .filter((w) => w.length > 1 && !HINT_NOISE.has(w));
  }

  /**
   * A selector that matches nothing is the single most common way a session
   * stalls, and the agent's instinct is to guess again. So when one fails, read
   * the a11y tree we can already produce and hand back the closest things that DO
   * exist, as selectors it can paste straight back. No model in the daemon - the
   * caller is the model; this is just token overlap against accessible names.
   */
  async function selectorHint(selector) {
    const want = hintTokens(selector);
    if (!want.length) return "";
    let snap = "";
    try { snap = await L("body").ariaSnapshot({ timeout: 4000 }); } catch { return ""; }
    const seen = new Set();
    const cands = [];
    for (const line of snap.split("\n")) {
      // ariaSnapshot lines look like: `- button "Sign in":` / `- textbox "Email"`.
      const m = /^\s*-\s+([a-z]+)(?:\s+"([^"]*)")?/.exec(line);
      if (!m || !m[2]) continue;
      const key = `${m[1]}|${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const have = hintTokens(`${m[1]} ${m[2]}`);
      let score = 0;
      for (const w of want) {
        if (have.includes(w)) score += 2;
        else if (have.some((h) => h.startsWith(w) || w.startsWith(h))) score += 1;
      }
      if (score > 0) cands.push({ score, role: m[1], name: m[2] });
    }
    cands.sort((a, b) => b.score - a.score || a.name.length - b.name.length);
    const top = cands.slice(0, 3).map((c) => `role=${c.role}[name="${c.name}"]`);
    return top.length ? `did you mean: ${top.join(" · ")}` : "";
  }

  /** Append the closest existing elements to a selector failure, so the agent can
   *  fix it in the SAME turn instead of guessing again.
   *
   *  Gated on the selector matching ZERO elements, asked of the page directly -
   *  NOT on the error text. Playwright prefixes almost everything with "Timeout
   *  Nms exceeded", so a text test also fires for "element intercepts pointer
   *  events", where the element WAS found and a list of look-alikes buries the
   *  real cause (a modal on top of it). */
  async function withSelectorHint(e, selector) {
    if (!selector) return e;
    let n = -1;
    try { n = await L(selector).count(); } catch { return e; } // bad syntax: no idea
    if (n !== 0) return e; // found it - the failure is about something else
    const msg = e && e.message ? e.message : String(e);
    let hint = "";
    try { hint = await selectorHint(selector); } catch { /* the hint is a bonus */ }
    return hint ? new Error(`${msg}\n${hint}`) : e;
  }

  /** Pull a one-shot `--dialog accept|dismiss[:text]` out of ANY command's args:
   *  it arms the policy for the dialog that command's action raises. Parsed here,
   *  before coerce, so no command has to know about it.
   *
   *  It only counts as the flag when a well-formed value FOLLOWS it, so a literal
   *  `browse fill "#q" --dialog` types the word instead of silently arming a
   *  policy and clearing the field. */
  const DIALOG_SPEC = /^(accept|dismiss)(:[\s\S]*)?$/i;
  function takeDialogFlag(args) {
    const i = args.indexOf("--dialog");
    if (i < 0 || !DIALOG_SPEC.test(String(args[i + 1] ?? ""))) return args;
    const spec = String(args[i + 1]);
    const sep = spec.indexOf(":");
    dialogPolicy = {
      action: (sep < 0 ? spec : spec.slice(0, sep)).toLowerCase(),
      text: sep < 0 ? "" : spec.slice(sep + 1),
    };
    return args.slice(0, i).concat(args.slice(i + 2));
  }

  /** The policy is scoped to the ONE command that armed it. Without this it
   *  outlives a command that threw before raising any dialog, and dismisses some
   *  unrelated confirm() many steps later. */
  async function dispatch(cmd, args) {
    const stripped = takeDialogFlag(args);
    const armed = stripped !== args;
    try {
      return await dispatchCmd(cmd, stripped);
    } finally {
      if (armed) dialogPolicy = null;
    }
  }

  async function dispatchCmd(cmd, args) {
    if (cmd === "close") {
      return { __close: true, gif: args.includes("--gif"), keepRaw: KEEP_WEBM || args.includes("--keep-raw") };
    }

    if (cmd === "open") {
      const url = args[0] || APP_DEFAULT;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      // Report the engine we ACTUALLY got, once. A camoufox→chromium fallback
      // otherwise looked identical to a working stealth session.
      let note = "";
      if (context.__engineNote) { note = `\nnote: ${context.__engineNote}`; context.__engineNote = null; }
      return `opened ${await brief()}${note}`;
    }
    if (cmd === "drag") {
      // Real mouse moves rather than page.dragAndDrop, so the recording SHOWS the
      // element being carried across - an instant teleport reads as a glitch.
      const [from, to] = args;
      if (!from || !to) throw new Error("drag: needs a source and a target selector");
      // drag returns before the PAGE_METHODS flag check, so it needs its own:
      // `drag a b --timeout 3000` used to drop the flag and report success.
      if (args.length > 2) throw new Error(`drag: unexpected argument '${args[2]}' - drag takes a source and a target selector only`);
      const center = async (sel) => {
        // Same timeout as every other element command: a drop target that is
        // still rendering shouldn't fail faster here than a click on it would.
        const b = await L(sel).first().boundingBox({ timeout: 12000 });
        if (!b) throw new Error(`drag: '${sel}' has no box on screen`);
        return [b.x + b.width / 2, b.y + b.height / 2];
      };
      // BOTH boxes are resolved BEFORE the button goes down. Resolving the target
      // mid-press meant a bad target selector threw with the mouse still held: on
      // a draggable="true" source that leaves the browser inside a native drag
      // session which swallows every later click and hover, while each one still
      // reports ok. Nothing between down() and up() is allowed to throw, and the
      // `finally` covers what a future edit might add.
      let side = "source", failed = from;
      let sx, sy, tx, ty;
      try {
        await cursorGlideTo(from);
        [sx, sy] = await center(from);
        side = "target"; failed = to;
        [tx, ty] = await center(to);
      } catch (e) {
        // Both sides raise the same shape of locator timeout, so without this the
        // message names a selector and leaves you to work out which end it was.
        const hinted = await withSelectorHint(e, failed);
        throw new Error(`drag: ${side} '${failed}' - ${hinted && hinted.message ? hinted.message : String(hinted)}`);
      }
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      try {
        await cursorGlideTo(to);
        // Several intermediate moves: HTML5 drop zones often only arm after a few
        // dragover events, and one jump can also miss a sortable list's threshold.
        for (let i = 1; i <= 8; i++) await page.mouse.move(sx + ((tx - sx) * i) / 8, sy + ((ty - sy) * i) / 8);
      } finally { await page.mouse.up().catch(() => { /* page gone */ }); }
      return `dragged ${from} → ${to}`;
    }
    if (PAGE_METHODS.has(cmd)) {
      const typing = cmd === "fill" || cmd === "type";
      // Extra args go into Playwright's options slot as plain strings, where they
      // are DROPPED - so `click x --timeout 3000` used to wait the default 12s
      // and exit 0 as if the flag had been honoured. `wait` and `screenshot`
      // reject unknown flags for the same reason; act commands must too.
      //
      // Only where an extra arg is MEANINGLESS. Commands whose trailing args are
      // DATA are exempt: fill/type text, a press key, a selectOption value
      // (`<option value="--">-- pick one --</option>` is a real pattern) and a
      // setInputFiles path may all legitimately start with a dash.
      const DATA_ARGS = typing || cmd === "press" || cmd === "selectOption" || cmd === "setInputFiles";
      if (!DATA_ARGS && ELEMENT_TARGETED.has(cmd) && args.length > 1) {
        // These take exactly ONE selector, so ANYTHING after it is a mistake -
        // a single-dash flag (`-timeout 3000`) and a stray word are both dropped
        // into Playwright's options slot and ignored, which is the exit-0 lie
        // this rejects. `wait` and `screenshot` reject any leading dash too.
        const extra = args[1];
        if (extra === "--dialog") {
          throw new Error(`${cmd}: --dialog needs a value: accept | dismiss | "accept:my answer"`);
        }
        throw new Error(`${cmd}: unexpected argument '${extra}' - ${cmd} takes only a selector` +
          `${String(extra).startsWith("-") ? ". Per-command timeouts live on 'browse wait <selector> --timeout <ms>'" : ""}`);
      }
      if (ELEMENT_TARGETED.has(cmd)) {
        // `browse press Escape` - one arg, so there is no selector: send the key
        // to the page itself (Escape, Tab, "Meta+k" …).
        if (cmd === "press" && args.length === 1) {
          await keylogKey(args[0]);
          await page.keyboard.press(args[0]);
          return `ok - ${await brief()}`;
        }
        await cursorGlideTo(args[0]);
        // Clicking into a field to type gets a ripple too, like a real click.
        if (CLICK_LIKE.has(cmd) || typing) await cursorClickFx();
        // press shows its key chip up front; typing shows its overlay inside
        // humanType, once the field is confirmed (so a bad selector shows nothing).
        if (cmd === "press") await keylogKey(args[1]);
        // A link that opens a new tab hands the session to a popup, but the
        // page event lands after the click resolves - so the click reported the
        // OLD tab and the "switched to popup" note only showed up on the NEXT
        // command. Asked BEFORE the click (the element is still there) and only
        // for an explicit target=_blank, so an ordinary click pays nothing.
        let expectPopup = false;
        if (CLICK_LIKE.has(cmd)) {
          try {
            expectPopup = await L(args[0]).first().evaluate(
              (el) => { const a = el.closest?.("a"); return !!(a && a.target === "_blank"); });
          } catch { /* detached, cross-origin: fall back to the late note */ }
        }
        // Everything past the selector goes through a Locator, which is what makes
        // an iframe scope (see L) work without any per-command handling.
        try {
          if (typing) await humanType(args[0], args.slice(1).join(" "), cmd === "fill");
          // setInputFiles takes ONE array argument - spreading it would silently
          // drop every file but the first.
          else if (cmd === "setInputFiles") {
            // Checked here so a typo'd path says so, instead of surfacing a raw
            // "ENOENT: stat" that reads like a browse fault.
            const missing = args.slice(1).filter((f) => !existsSync(f));
            if (missing.length) throw new Error(`setInputFiles: no such file: ${missing.join(", ")} (paths are resolved from the directory browse runs in)`);
            await L(args[0]).first().setInputFiles(args.slice(1));
          }
          else await L(args[0]).first()[cmd](...args.slice(1));
        } catch (e) { throw await withSelectorHint(e, args[0]); }
        // Let the popup land (context.on("page") switches to it) so this command
        // reports where the session actually IS, with its note attached.
        if (expectPopup) await context.waitForEvent("page", { timeout: 3000 }).catch(() => { /* never opened */ });
        return `ok - ${await brief()}`;
      }
      if (typeof page[cmd] !== "function") throw new Error(`page has no method '${cmd}'`);
      await page[cmd](...coerce(cmd, args));
      return `ok - ${await brief()}`;
    }
    switch (cmd) {
      case "snapshot": {
        let snap = "";
        try { snap = await L("body").ariaSnapshot(); }
        catch { snap = JSON.stringify(await page.accessibility.snapshot(), null, 1) || ""; }
        return `${await brief()}\n\n${clipForRead(snap, "snapshot", "run 'browse snapshot' again scoped by 'browse target <iframe>', or read a region with 'browse text <selector>'", 6000)}`;
      }
      case "text": {
        const loc = L(args[0] || "body");
        const t = await loc.first().innerText();
        return clipForRead(t, "text", `pass a narrower selector than '${args[0] || "body"}'`, 6000);
      }
      case "title": return await page.title();
      case "url": return page.url();
      case "content": return clipForRead(await page.content(), "content", "use 'browse text <selector>' or 'browse eval' for the part you need");
      case "errors": return errors.length ? errors.join("\n") : "(no console/page errors)";
      case "screenshot": {
        let name = null, full = false, sel = null;
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (a === "--full") full = true;
          else if (a === "--sel") sel = args[++i];
          // Without this a retired spelling (--fullpage, --selector) would be
          // taken as the FILENAME and silently save an unwanted screenshot. One
          // dash counts too: `-full` would otherwise land as a file named _full.
          else if (a.startsWith("-")) throw new Error(`screenshot: unknown flag '${a}' - try [name] [--full] [--sel <selector>]`);
          else if (name == null) name = a;
        }
        name = (name || `shot-${Date.now()}.png`).replace(/[^\w.-]/g, "_");
        // Playwright picks its encoder from the extension, so a bare name like
        // `checkout` failed with a raw 'unsupported mime type "null"'. The name
        // is a label, not a path - default the extension instead of erroring.
        // The extension is lowercased rather than merely ACCEPTED case-insensitively:
        // Playwright's mime lookup and the .pdf branch below are both
        // case-sensitive, so `REPORT.PDF` would otherwise fail the same way.
        const ext = /\.(png|jpe?g|pdf)$/i.exec(name);
        if (ext) name = name.slice(0, -ext[0].length) + ext[0].toLowerCase();
        else name += ".png";
        const path = `${OUT}/${name}`;
        // A .pdf name means print the page, not screenshot it (headless only).
        // page.pdf() is Chromium-only — Firefox/camoufox has no equivalent.
        if (name.endsWith(".pdf")) {
          if (context.__engine !== "chromium")
            throw new Error(
              `PDF export is Chromium-only (engine: ${context.__engine}). Re-run ` +
              `this session with --chromium, or save a .png instead.`);
          await page.pdf({ path });
          return `saved ${path}`;
        }
        if (sel) {
          try { await L(sel).first().screenshot({ path }); }
          catch (e) { throw await withSelectorHint(e, sel); }
          return `saved ${path} (${sel})`;
        }
        await page.screenshot({ path, fullPage: full });
        // --full captures past the viewport via CDP, so the page never moves and
        // the recording is unaffected - but anything that only loads once it is
        // scrolled to simply isn't in the DOM yet.
        let tip = "";
        if (full) {
          let tall = false;
          try { tall = await page.evaluate(() => document.body.scrollHeight > 2 * window.innerHeight); }
          catch { /* mid-navigation */ }
          if (tall) tip = "\ntip: run 'browse scroll bottom' first if the page lazy-loads";
        }
        return `saved ${path}${tip}`;
      }
      case "wait": {
        // One verb for every "hold until…": an element appearing or disappearing,
        // a navigation, or a plain pause. It is ALSO the assertion - a wait that
        // never resolves throws, which the client turns into a non-zero exit.
        let sel = null, gone = false, url = null, timeout = 10000;
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (a === "--gone") gone = true;
          else if (a === "--url") url = args[++i];
          else if (a === "--timeout") timeout = Number(args[++i]) || timeout;
          // Without this a retired spelling (--hidden, -t) would be taken as the
          // SELECTOR and fail ten seconds later as a mystery timeout.
          else if (a.startsWith("-")) throw new Error(`wait: unknown flag '${a}' - try [selector|ms] [--gone] [--url <pattern>] [--timeout <ms>]`);
          else if (sel == null) sel = a;
        }
        if (url) {
          // A bare path is what an agent naturally passes; waitForURL wants a glob
          // (or a full url), so wrap a path into one rather than never matching.
          const pat = /^[a-z]+:\/\//i.test(url) || url.includes("*") ? url : `**${url}**`;
          await page.waitForURL(pat, { timeout });
          return `ok - ${await brief()}`;
        }
        if (sel != null && /^\d+$/.test(sel)) { await page.waitForTimeout(Number(sel)); return `waited ${sel}ms`; }
        if (!sel) throw new Error("wait: needs a selector, a number of ms, or --url <pattern>");
        try { await L(sel).first().waitFor({ state: gone ? "hidden" : "visible", timeout }); }
        catch (e) { throw await withSelectorHint(e, gone ? "" : sel); }
        return `${gone ? "gone" : "visible"}: ${sel} - ${await brief()}`;
      }
      case "scroll": {
        let target = null, x = 0;
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "--x") x = Number(args[++i]) || 0;
          else if (args[i].startsWith("--")) throw new Error(`scroll: unknown flag '${args[i]}' - try <n|-n|top|bottom|<selector>> [--x <n>]`);
          else if (target == null) target = args[i];
        }
        const a = String(target ?? "").trim();
        // A bare `scroll` (or an explicit `scroll 0`) used to "scroll 0px" at
        // exit 0 and still burn a step number on a screenshot of an unmoved page.
        if (!x && (!a || /^-?0+$/.test(a))) {
          throw new Error(`scroll: ${a ? `'${a}' moves nothing` : "needs a target"} - try <n|-n|top|bottom|<selector>> (or --x <n> for horizontal)`);
        }
        const named = a.toLowerCase() === "top" || a.toLowerCase() === "bottom";
        if (a && !named && !/^-?\d+$/.test(a)) {
          // A selector: let Playwright put it on screen (it also handles nested
          // scroll containers, which window.scrollBy can't).
          try { await L(a).first().scrollIntoViewIfNeeded({ timeout: 5000 }); }
          catch (e) { throw await withSelectorHint(e, a); }
          return `scrolled ${a} into view`;
        }
        // 1e9 is "as far as it goes" - smoothScroll clamps to the scroll extent.
        const dy = a.toLowerCase() === "top" ? -1e9 : a.toLowerCase() === "bottom" ? 1e9 : Number(a || 0);
        await smoothScroll(dy, x);
        return `scrolled ${named ? a.toLowerCase() : `${dy}px`}${x ? ` · x ${x}px` : ""} - ${await brief()}`;
      }
      case "eval": {
        let src = args.join(" ");
        if (!src.trim()) throw new Error("eval: needs a js expression, e.g. `browse eval \"document.title\"`");
        // `await fetch(...)` is the reflex spelling and page.evaluate rejects it
        // as a SyntaxError (the string is an expression, not an async body).
        // Wrap it rather than making every caller remember the difference.
        const wrapped = /(^|[^.\w])await\s/.test(src);
        if (wrapped) src = `(async () => (${src}))()`;
        // An iframe scope from `browse target <iframe>` steers click/text/wait
        // through L(); eval bypassed it and silently ran in the TOP frame, so a
        // scoped session read the wrong document.
        const target = activeFrame ? await frameForEval() : page;
        let out;
        try { out = await target.evaluate(src); }
        catch (e) {
          // The wrap only takes a single EXPRESSION, so `const r = await f(); r.x`
          // fails on a token the caller never typed. Say who rewrote it.
          if (wrapped && /SyntaxError/.test(e.message)) {
            throw new Error(`${e.message}\nnote: browse wrapped this in an async IIFE so top-level 'await' works, which only accepts ONE expression. For statements, write it yourself: '(async () => { const r = await f(); return r.x })()'`);
          }
          throw e;
        }
        // `undefined` is what a void expression returns, and printing nothing at
        // exit 0 is indistinguishable from a command that produced no output.
        // An empty string reads the same way (the client drops empty replies), so
        // it is quoted rather than sent as nothing.
        if (out === undefined) return "undefined";
        if (out === "") return '""';
        const text = typeof out === "string" ? out : JSON.stringify(out);
        return clipForRead(text, "eval", "narrow the expression (e.g. .slice(0, 2000), .length, or a specific field)");
      }
      case "toast": {
        // NOTE overlay for demo videos — for context the viewer can't get from
        // the screen (an explanation, a caveat), NOT a narration of each action.
        // Auto-dismisses after ~reading time so it never lingers over the rest
        // of the recording; never blocks clicks (pointer-events: none).
        //   browse toast [--for <sec>] [--sticky] [--color yellow|blue|green|red|neutral]
        //                [--pos top|bottom] <text…>
        //   browse toast --clear     remove a sticky toast (animated out)
        let color = "yellow", pos = "top", clear = false, sticky = false, forMs = 0;
        const words = [];
        // A caption is a deliverable: a mistyped --color or --pos used to fall
        // back silently and ship the wrong accent (or the wrong corner) in a
        // video nobody re-renders. Validate rather than guess.
        const COLORS = ["yellow", "blue", "green", "red", "neutral"], POS = ["top", "bottom"];
        // A caption is free text and may legitimately start with a dash, so `--`
        // ends the flags and everything after it is the caption.
        let endOfFlags = false;
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (endOfFlags) { words.push(a); continue; }
          if (a === "--") { endOfFlags = true; continue; }
          if (a === "--clear" || a === "-c") clear = true;
          else if (a === "--sticky") sticky = true;
          else if (a === "--for") {
            const secs = Number(args[++i]);
            if (!Number.isFinite(secs) || secs <= 0) throw new Error(`toast: --for expects seconds - got '${args[i]}'`);
            forMs = Math.round(secs * 1000);
          } else if (a === "--color") {
            color = String(args[++i] ?? "").toLowerCase();
            if (!COLORS.includes(color)) throw new Error(`toast: unknown --color '${color}' - try ${COLORS.join("|")}`);
          } else if (a === "--pos") {
            pos = String(args[++i] ?? "").toLowerCase();
            if (!POS.includes(pos)) throw new Error(`toast: unknown --pos '${pos}' - try ${POS.join("|")}`);
          } else if (a.startsWith("--")) throw new Error(`toast: unknown flag '${a}' - try [--for <sec>] [--sticky] [--color ${COLORS.join("|")}] [--pos ${POS.join("|")}] | --clear`);
          else words.push(a);
        }
        const text = words.join(" ");
        // Without text there is nothing to show, but it used to report success,
        // take a transcript line and earn an mp4 chapter pointing at nothing.
        if (!clear && !text) throw new Error("toast: needs the caption text, e.g. `browse toast \"this data is mocked\"` (or --clear to remove a sticky one)");
        const t = (Date.now() - recStartMs) / 1000;
        // A new toast (or --clear) ends the previous one's protection early -
        // nobody is still reading it once it has been replaced.
        const prevKeep = keepMarks[keepMarks.length - 1];
        if (prevKeep && prevKeep.end > t) prevKeep.end = t + 0.5;
        let durMs = 0;
        if (!clear && text) {
          // Lifetime ≈ reading time: ~60ms/char, clamped 3.2–7s (or --for).
          durMs = forMs || Math.min(7000, Math.max(3200, 1800 + 60 * text.length));
          // Protect the toast's on-screen life from the dead-air cut so the final
          // video keeps it at real time (+0.6s covers enter/exit anims).
          //
          // A --sticky toast stays up until something clears it, but protecting
          // it until THEN would pin every remaining frame of the session at real
          // time and effectively switch the dead-air cut off for the rest of the
          // recording. It gets reading time plus a cushion instead, which is
          // strictly more than the window keepMarks exist to defend, so a toast
          // still can't be cut mid-read. Nothing is lost either way: the toast is
          // a DOM element, so it keeps showing in whatever frames survive - the
          // protection only decides how many MOTIONLESS ones we keep behind it.
          keepMarks.push({ start: Math.max(0, t - 0.2), end: t + durMs / 1000 + (sticky ? 3 : 0) + 0.6 });
        }
        await showToast({ text, color, pos, clear, sticky, durMs });
        return clear ? "toast cleared" : `toast (${sticky ? "sticky" : "auto-dismiss"}): ${text}`;
      }
      case "speed": {
        // Bracket a region to fast-forward in the final mp4 (badged), for a long
        // but visibly-progressing wait. Pure timeline annotation: it does NOT
        // wait, act on the page, or screenshot — just records a mark against the
        // recording clock. `browse speed <n>` (n>=2) opens/re-opens the region;
        // `browse speed off` closes it; bare `browse speed` uses the default
        // factor. See finalizeRecording / forcedIntervals.
        const a = String(args[0] ?? "").trim().toLowerCase();
        const t = (Date.now() - recStartMs) / 1000;
        const open = speedMarks.length && speedMarks[speedMarks.length - 1].factor > 1;
        let factor;
        if (a === "off") {
          // Closing nothing used to answer "back to real time", which reads as
          // confirmation that a region you thought was open has just ended.
          if (!open) throw new Error("speed: no fast-forward region is open - 'browse speed <factor>' opens one");
          factor = 1;
        } else if (a === "") factor = IDLE.speed;
        else {
          // A bare word here used to mean "end the region" (end/stop/1/0). Those
          // spellings are gone, so fall through to a hard error rather than
          // silently OPENING a fast-forward the caller meant to close.
          const n = Number(a);
          if (!Number.isFinite(n) || n < 2) throw new Error(`speed: expected a factor >= 2, or 'off' - got '${args[0]}'`);
          factor = n;
        }
        speedMarks.push({ t, factor });
        // The "Nx" badge needs a drawtext-capable ffmpeg AND a TTF on disk, and
        // homebrew's current core bottle has no drawtext. Without it the region
        // is still sped up but carries no label, so it reads as a jump cut - the
        // agent should know that BEFORE it builds a demo around the effect.
        let badgeWarning = "";
        if (factor > 1 && !badgeWarned && (!hasDrawtext() || !findFontFile())) {
          badgeWarned = true;
          badgeWarning = "\nnote: this ffmpeg has no drawtext filter, so the 'Nx' badge won't render - the sped-up stretch will look like a jump cut. Consider a 'browse toast' before it, or install an ffmpeg built with libfreetype.";
        }
        return factor > 1
          ? `speed: ${factor}x from ${t.toFixed(1)}s${badgeWarning}`
          : `speed: back to real time at ${t.toFixed(1)}s`;
      }
      case "target": {
        // Tabs and iframes in one verb, because from the agent's side they are
        // the same question: "what do my selectors resolve against?".
        const a = String(args[0] ?? "").trim();
        if (!a) {
          const rows = [];
          for (let i = 0; i < pages.length; i++) {
            let t = "";
            try { t = await pages[i].title(); } catch { /* mid-navigation */ }
            // Every tab says where it stands with the recording, on every listing -
            // the `target new` warning is easy to miss twenty commands later, and
            // that is exactly the tab whose work is happening off camera.
            const tag = pages[i] === primaryPage ? " [recorded]"
              : wantedPages.has(pages[i]) ? " [not in the video]"
                : " [popup, cut from video]";
            rows.push(`${i === activeIdx ? "*" : " "} ${i}  ${t ? t + " - " : ""}${pages[i].url()}${tag}`);
          }
          if (activeFrameSel) rows.push(`  frame scope: ${activeFrameSel} ('browse target top' to leave)`);
          return rows.join("\n");
        }
        if (a === "top") {
          activeFrame = null; activeFrameSel = null;
          return `back to the top frame - ${await brief()}`;
        }
        if (a === "new") {
          // The flag must cover ONLY newPage(): held across the goto below, a
          // popup the loading page throws would arrive while it is still set and
          // be filed as deliberate - escaping the cut and skipping its warning.
          let p;
          openingTab = true;
          try { p = await context.newPage(); } // context.on("page") wires + activates it
          finally { openingTab = false; }
          if (args[1]) await p.goto(args[1], { waitUntil: "domcontentloaded", timeout: 20000 });
          // The video follows tab 0 only. Say so, because a demo driven here
          // looks perfect on screen and shows up as a frozen tab 0 in the mp4.
          return `tab ${pages.indexOf(p)} - ${await brief()}\nnote: the recording follows tab 0, so what you do here is NOT in the video - go back with 'browse target 0' for anything that must be seen. Leave tab 0 on a STATIC page first: motionless time there is cut automatically, but a spinner or live log keeps it in the clip at real time`;
        }
        if (a === "close") {
          // Two ways this ends a session by accident: the last page tears the
          // context down, and the FIRST page owns the .webm we finalize - closing
          // it makes Playwright flush that file on the spot, so everything after
          // is missing from the mp4 while every command still reports ok.
          if (pages.length < 2) throw new Error("target close: this is the last tab - use `browse close` to end the session (it finalizes the video)");
          if (page === primaryPage) throw new Error("target close: tab 0 is the one being recorded - closing it would end the video mid-session. Switch to the tab you meant with `browse target <n>` first, or `browse close` to finish the session");
          await page.close(); // the page's own close handler activates a sibling
          return `closed - now on tab ${activeIdx}: ${await brief()}`;
        }
        if (/^\d+$/.test(a)) {
          if (!pages[Number(a)]) throw new Error(`target: no tab ${a} - run 'browse target' to list them`);
          activate(Number(a));
          await focusActive();
          return `tab ${activeIdx} - ${await brief()}`;
        }
        // Anything else is an iframe selector. A FrameLocator's boundingBox() is
        // still in MAIN-frame coordinates, so the cursor keeps gliding to the
        // right spot on screen with no extra work.
        const fl = page.frameLocator(a);
        try { await fl.locator("body").first().waitFor({ state: "attached", timeout: 8000 }); }
        catch (e) { throw await withSelectorHint(e, a); }
        activeFrame = fl; activeFrameSel = a;
        return `scoped into ${a} - selectors now resolve inside it ('browse target top' to leave)`;
      }
      case "emulate": {
        // Everything the page can be lied to about, in one verb. Context options
        // are immutable after creation, so tz/locale/cpu/net go through CDP -
        // re-creating the context would end the recording.
        if (!args.length) throw new Error("emulate: e.g. `browse emulate viewport=390x844 dark=1 net=3g`, or `browse emulate off`");
        const applied = [];
        for (const kv of args) {
          const eq = kv.indexOf("=");
          const k = (eq < 0 ? kv : kv.slice(0, eq)).toLowerCase();
          const v = eq < 0 ? "" : kv.slice(eq + 1);
          const on = /^(1|true|on|yes|dark)$/i.test(v);
          if (k === "off") {
            await page.emulateMedia({ colorScheme: null });
            await page.setViewportSize(VIEWPORT);
            const s = await emuCdp();
            for (const [m, p] of [
              ["Emulation.setCPUThrottlingRate", { rate: 1 }],
              ["Emulation.setTimezoneOverride", { timezoneId: "" }],
              ["Emulation.setLocaleOverride", {}],
              ["Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }],
            ]) { try { await s.send(m, p); } catch { /* not overridden in the first place */ } }
            // geo= lives on the CONTEXT, not CDP, so the four resets above left a
            // spoofed position in place while claiming everything was default.
            try { await context.setGeolocation(null); } catch { /* never set */ }
            try { await context.clearPermissions(); } catch { /* never granted */ }
            applied.push("off (everything back to default)");
          } else if (k === "dark") {
            const scheme = v === "light" ? "light" : on ? "dark" : "light";
            await page.emulateMedia({ colorScheme: scheme });
            applied.push(`dark=${scheme === "dark" ? 1 : 0}`);
          } else if (k === "geo") {
            const [lat, lon] = v.split(",").map(Number);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error(`emulate geo: expected lat,lon - got '${v}'`);
            await context.grantPermissions(["geolocation"]);
            await context.setGeolocation({ latitude: lat, longitude: lon });
            applied.push(`geo=${lat},${lon}`);
          } else if (k === "viewport") {
            const m = /^(\d+)\s*[x×]\s*(\d+)$/.exec(v);
            if (!m) throw new Error(`emulate viewport: expected WxH - got '${v}'`);
            await page.setViewportSize({ width: +m[1], height: +m[2] });
            applied.push(`viewport=${m[1]}x${m[2]}`);
            // recordVideo.size is FROZEN at context creation, and Playwright pads
            // each frame from the top-left, so a smaller page records with grey
            // dead space to the right/bottom rather than centre-frame. Nothing
            // inside the page can move it; say so, and point at the one thing
            // that records phone-shaped for real.
            if (+m[1] < VIEWPORT.width || +m[2] < VIEWPORT.height) {
              applied.push(`(the video frame stays ${VIEWPORT.width}x${VIEWPORT.height} - for a phone-shaped RECORDING, close and respawn with --viewport ${m[1]}x${m[2]})`);
            }
          } else if (k === "tz") {
            await (await emuCdp()).send("Emulation.setTimezoneOverride", { timezoneId: v });
            applied.push(`tz=${v}`);
          } else if (k === "locale") {
            await (await emuCdp()).send("Emulation.setLocaleOverride", { locale: v });
            applied.push(`locale=${v}`);
            // CDP moves Intl (dates, number formats) but NOT navigator.language(s)
            // or Accept-Language, which are fixed at context creation. An app that
            // branches on navigator.language keeps rendering English, so a bare
            // "locale=tr-TR" would read as a lie.
            applied.push("(Intl only - navigator.language(s) and Accept-Language keep the browser default, so an app that branches on navigator.language will NOT switch)");
          } else if (k === "cpu") {
            const rate = Number(v);
            if (!Number.isFinite(rate) || rate < 1) throw new Error(`emulate cpu: expected a slowdown factor >= 1 - got '${v}'`);
            await (await emuCdp()).send("Emulation.setCPUThrottlingRate", { rate });
            applied.push(`cpu=${rate}x slower`);
          } else if (k === "net") {
            const key = v.toLowerCase().replace(/[^a-z0-9]/g, "");
            const s = await emuCdp();
            try { await s.send("Network.enable"); } catch { /* already on */ }
            if (key === "off" || key === "none") {
              await s.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
              applied.push("net=off");
            } else {
              const c = NET_CONDITIONS[key];
              if (!c) throw new Error(`emulate net: expected ${Object.keys(NET_CONDITIONS).join("|")}|off - got '${v}'`);
              await s.send("Network.emulateNetworkConditions", {
                offline: !!c.offline, latency: c.latency,
                downloadThroughput: c.download, uploadThroughput: c.upload,
              });
              applied.push(`net=${key}`);
            }
          } else {
            throw new Error(`emulate: unknown key '${k}' - try viewport= dark= geo= tz= locale= cpu= net= or off`);
          }
        }
        return `emulate: ${applied.join(" · ")}`;
      }
      case "state": {
        // Carry a login between sessions: save once by hand, load at the start of
        // every later run instead of re-driving the whole sign-in flow on camera.
        const i = args.findIndex((a) => a === "--save" || a === "--load");
        const file = i < 0 ? null : args[i + 1];
        if (!file) throw new Error("state: use `--save <file>` or `--load <file>`");
        // --load MERGES onto whatever is already there, which is what you want
        // when restoring one login. Switching IDENTITIES needs the opposite, or
        // the previous user's keys and cookies survive underneath.
        const clean = args.includes("--clean");
        // A bare name lives in ~/.browse/state/, NOT the session dir - the whole
        // point is that the next session (a different dir) can load it back.
        const path = file.includes("/") ? file : join(BROWSE_HOME, "state", file);
        if (args[i] === "--save") {
          mkdirSync(join(BROWSE_HOME, "state"), { recursive: true });
          await context.storageState({ path });
          return `saved cookies + localStorage → ${path}`;
        }
        // NOT browser.newContext({ storageState }): recordVideo lives on THIS
        // context, so building a fresh one to load state into would end the
        // recording mid-session and leave a truncated video. Cookies go straight
        // into the live context; localStorage needs its origin to be loaded, so
        // it is written into the current page now and re-applied on every later
        // navigation by ONE init script.
        // A raw ENOENT here reads as a browse crash. Name the file, and list what
        // IS saved - the usual cause is a typo or a state saved under another name.
        let st;
        try { st = JSON.parse(readFileSync(path, "utf8")); }
        catch (e) {
          if (e.code !== "ENOENT") throw new Error(`state --load ${file}: ${path} is not readable state JSON (${e.message})`);
          let saved = [];
          try { saved = readdirSync(join(BROWSE_HOME, "state")); } catch { /* none saved yet */ }
          throw new Error(`state --load: no saved state '${file}' at ${path}` +
            (saved.length ? `\nsaved states: ${saved.join(", ")}` : "\nnothing is saved yet - run `browse state --save <file>` while logged in"));
        }
        if (clean) await context.clearCookies();
        if (st.cookies?.length) await context.addCookies(st.cookies);
        const origins = st.origins || [];
        // Playwright has no removeInitScript, so a second `state --load` would
        // stack a second script and keep resurrecting the FIRST file's keys
        // forever. Register exactly one, reading through a binding, and let the
        // latest load replace what it serves.
        stateOrigins = { clean, origins };
        if (origins.length && !stateScriptInstalled) {
          await context.exposeBinding("__browseStateOrigins", () => stateOrigins || { clean: false, origins: [] });
          // Flagged the INSTANT the binding lands, before anything else can throw:
          // exposeBinding rejects a second registration outright, so a retry after
          // a half-finished install would fail `state --load` forever.
          stateScriptInstalled = true;
          await context.addInitScript(async () => {
            try {
              const data = await window.__browseStateOrigins();
              const entry = (data.origins || []).find((o) => o.origin === location.origin);
              if (!entry) return;
              if (data.clean) { try { localStorage.clear(); } catch { /* blocked */ } }
              // One key failing (quota, a security policy) must not cost the rest.
              for (const kv of entry.localStorage || []) {
                try { localStorage.setItem(kv.name, kv.value); } catch { /* skip this key */ }
              }
            } catch { /* storage blocked, or the binding is gone */ }
          });
        }
        // The page we are on right now loaded before any of that, so write it
        // there directly too - the reload below then starts from the real state.
        try {
          await page.evaluate((data) => {
            const entry = (data.origins || []).find((o) => o.origin === location.origin);
            if (!entry) return;
            if (data.clean) { try { localStorage.clear(); } catch { /* blocked */ } }
            for (const kv of entry.localStorage || []) {
              try { localStorage.setItem(kv.name, kv.value); } catch { /* skip this key */ }
            }
          }, { clean, origins });
        } catch { /* about:blank, or a cross-origin storage block */ }
        try { await page.reload({ waitUntil: "domcontentloaded" }); } catch { /* nothing loaded yet */ }
        return `loaded ${st.cookies?.length || 0} cookies + ${origins.length} origin(s) from ${path}${clean ? " (cleared first)" : " (merged onto what was there)"} - ${await brief()}`;
      }
      case "middleware": {
        const mw = parseMiddleware(args);
        if (mw.error) throw new Error(mw.error);
        // "matched", not "handled": a rule that ends in fallback() matches the
        // request and then passes it on, and calling that "handled" would read
        // as though the mock had applied.
        const list = () => middleware.length
          ? middleware.map((m) => `  ${m.pattern}   ${m.hits} matched${m.errs ? `, ${m.errs} threw` : ""}`).join("\n")
            + `\n(${middleware.length} rule${middleware.length > 1 ? "s" : ""}, newest first — that is also the order they run in)`
          : "(no middleware)";
        if (mw.action === "list") return list();
        if (mw.action === "clear") {
          const n = middleware.length;
          if (!n) return "(no middleware to clear)";
          for (const m of middleware) {
            try { await context.unroute(m.pattern, m.handler); } catch { /* context going away */ }
          }
          middleware.length = 0;
          return `cleared ${n} middleware rule${n > 1 ? "s" : ""}`;
        }
        if (mw.action === "remove") {
          const i = middleware.findIndex((m) => m.pattern === mw.pattern);
          if (i < 0) throw new Error(`middleware: nothing registered for '${mw.pattern}'\n${list()}`);
          await context.unroute(mw.pattern, middleware[i].handler);
          middleware.splice(i, 1);
          return `removed middleware ${mw.pattern}`;
        }
        const { pattern, src } = mw;
        const fn = mwCompile(src);
        // Same pattern twice is almost always a REWRITE of the rule, not a second
        // one — silently stacking them would leave the older (now shadowed) rule
        // running forever with no way to tell the two apart in the listing.
        const prev = middleware.findIndex((m) => m.pattern === pattern);
        if (prev >= 0) {
          await context.unroute(pattern, middleware[prev].handler);
          middleware.splice(prev, 1);
        }
        const entry = { pattern, handler: null, hits: 0, errs: 0, warned: false };
        entry.handler = mwWrap(entry, fn);
        await context.route(pattern, entry.handler);
        middleware.unshift(entry);
        // The pattern is matched against the whole url, so a bare path matches
        // nothing at all — and a rule that never fires looks exactly like a rule
        // whose handler is wrong. Say it at registration, not after the debugging.
        const hint = pattern.startsWith("/") && !pattern.startsWith("//")
          ? `\nnote: '${pattern}' is matched against the FULL url (there is no base url), so it will never match. Use '**${pattern}'.`
          : "";
        return `middleware ${prev >= 0 ? "replaced" : "+"} ${pattern}${middleware.length > 1 ? ` (${middleware.length} rules, this one runs first)` : ""}${hint}`;
      }
      case "dir": return OUT;
      default:
        // Retired spellings never reach here — the client answers them (see
        // RETIRED) so they don't cost a browser launch.
        throw new Error(`unknown command '${cmd}' — run: browse help`);
    }
  }

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, session: SESSION, out: OUT }));
      return;
    }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    armIdle();
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let cmd = "?", args = [];
      try { ({ cmd, args = [] } = JSON.parse(body)); } catch { /* ignore */ }
      const send = (obj) => { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(obj)); };
      try {
        // Timestamped BEFORE the command so the chapter lands on the moment the
        // viewer sees it start, but only PUSHED after it succeeds - a chapter
        // pointing at a command that threw points at nothing on screen.
        const stepAt = now();
        const out = await dispatch(cmd, args);
        if (!CHAPTERLESS.has(cmd)) stepMarks.push({ t: stepAt, cmd: logLabel(cmd, args).slice(0, 64) });
        // Collapse any middleware faults raised since the last command into the
        // notes queue, so they ride out on this reply like every other note.
        mwFlushThrows();
        if (out && out.__close) {
          const saved = await closeSession("closed by client", { keepRaw: out.keepRaw });
          const wantGif = out.gif && saved && saved.mp4;
          // The mp4 is what gets shared as proof, and mocked data looks exactly
          // like real data on video. Say which rules were live for the recording
          // (patterns only — never the handlers), or a demo of a mocked "Pro"
          // plan is indistinguishable from a demo of a real one.
          const mocks = middleware.length
            ? `\n  mock: ${middleware.length} middleware rule${middleware.length > 1 ? "s were" : " was"} active during this recording — ${middleware.map((m) => m.pattern).join(", ")}`
            : "";
          // A note queued by the very last interception would otherwise die with
          // the process: this is its only chance to be said.
          const lastNotes = notes.length ? `\n${notes.splice(0).map((n) => "  " + n).join("\n")}` : "";
          send({
            ok: true,
            result: (saved && (saved.mp4 || saved.webm)
              ? `closed - recording saved\n  ${saved.mp4 ? `mp4:  ${tildePath(saved.mp4)} (hand this path to the user as-is)` : `webm: ${tildePath(saved.webm)} (ffmpeg missing/failed - mp4 not written)`}\n${saved.mp4 && saved.webm ? `  webm: ${tildePath(saved.webm)} (kept - re-cut it with one ffmpeg call)\n` : ""}${wantGif ? `  gif:  ${tildePath(join(OUT, "recording.gif"))} (encoding now - give it a few seconds)\n` : ""}  dir:  ${tildePath(OUT)}\n  net:  browse net --dir ${tildePath(OUT)} (the request log is still queryable)${mocks}\n  next: write feedback.md into that dir (what worked / friction / one improvement idea)`
              : "closed - recording flushed (no video captured)") + lastNotes,
          });
          // The gif is a two-pass encode that can outlast the client's 120s
          // timeout on a long session. It runs AFTER the reply, so the mp4 path
          // always reaches the caller even if the gif takes minutes or fails.
          setTimeout(() => {
            if (wantGif) makeGif(saved.mp4);
            process.exit(0);
          }, 100);
          return;
        }
        let shot = null;
        if (MUTATING.has(cmd) || cmd === "open" || cmd === "scroll") shot = await autoShot(cmd);
        let result = shot ? `${out}\n[${shot}]` : out;
        // Surface any NEW console/page errors inline so a runtime fault (e.g. a
        // Next.js error overlay) can't slip by just because the caller didn't run
        // `browse errors`. `errors` already lists them all, so we skip the append
        // there but still advance the cursor so they aren't echoed again later.
        const freshErrors = errors.slice(reportedErrors);
        reportedErrors = errors.length;
        if (cmd !== "errors" && freshErrors.length) {
          result = `${result}\n⚠️ new page errors (${freshErrors.length}):\n${freshErrors.map((e) => "  " + e).join("\n")}`;
        }
        // Same idea for things nothing asked for: a dialog we answered, a file
        // that downloaded, a popup we switched to. Drained, so each is said once.
        if (notes.length) {
          result = `${result}\n${notes.splice(0).map((n) => "  " + n).join("\n")}`;
        }
        logTranscript(`### ${step || "·"} · \`${logLabel(cmd, args)}\`\n${transcriptBody(result)}\n\n`);
        send({ ok: true, result });
      } catch (e) {
        let msg = stripAnsi(e && e.message ? e.message : String(e));
        // A popup that closes itself mid-command takes the page out from under
        // whatever was running on it, and Playwright reports that as a bare
        // "Target page, context or browser has been closed" - which reads like
        // the whole session died. It didn't: the close handler already moved us
        // to a surviving tab, so say which one and that a retry is the fix.
        if (!closing && pages.length && /(target|page|context or browser) (page, context or browser )?has been closed|Target closed/i.test(msg)) {
          let where = `tab ${activeIdx}`;
          try { where = `tab ${activeIdx} (${await brief()})`; } catch { /* mid-navigation */ }
          msg = `the tab this command was running in closed itself (a self-closing popup) - the session is fine and now on ${where}. Re-run the command.`;
        }
        // The notes queue must drain on FAILURE too: a download that landed, or a
        // dialog we answered, belongs to the command that caused it - held back,
        // it resurfaces later attached to something unrelated and misleads.
        mwFlushThrows();
        if (notes.length) msg = `${msg}\n${notes.splice(0).map((n) => "  " + n).join("\n")}`;
        logTranscript(`### · \`${logLabel(cmd, args)}\`\n- ❌ ${msg.split("\n")[0]}\n\n`);
        send({ ok: false, error: msg });
      }
    });
  });

  server.on("error", (e) => {
    if (e && e.code === "EADDRINUSE") { logDaemon("pinned port busy — another daemon won; exiting"); process.exit(0); }
    logDaemon("server error: " + (e?.message || e));
    process.exit(1);
  });
  // Only report healthy once the browser/page are ready (server starts last).
  // Publishing the run file is what makes this daemon discoverable by name.
  server.listen(FIXED_PORT, HOST, () => {
    const port = server.address().port;
    try {
      mkdirSync(RUN_DIR, { recursive: true });
      writeFileSync(runFile(SESSION), JSON.stringify({ port, pid: process.pid, out: OUT }));
    } catch (e) { logDaemon("run file write failed: " + (e?.message || e)); }
    logDaemon(`listening on ${port} (session ${SESSION}) — browser ready`);
    armIdle();
  });
}

/* ==================================================================== main */

const mode = process.argv[2];
if (mode === "__serve") {
  daemon().catch((e) => { logDaemon("fatal: " + (e?.stack || e)); process.exit(1); });
} else {
  // Set exitCode and let node exit on its own once the event loop drains —
  // process.exit() here would TRUNCATE a large stdout write into a pipe
  // (`browse net --json | jq …` is megabytes), since writes to a pipe are async.
  client(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((e) => {
    process.stderr.write(`browse: ${e?.message || e}\n`);
    process.exitCode = 1;
  });
}
