#!/usr/bin/env node
// Integration coverage for $BROWSE_HOME/no-local, the file that makes browse
// refuse to start a browser on this machine. Client-only: no case here may
// launch a browser, since the point of the file is a machine that must not.
//
//   node test/no-local.test.mjs
//
// Covers: the refusal (message and exit status, and no daemon or run file left
// behind), BROWSE_LOCAL=1 getting past it, --remote and BROWSE_CDP sessions
// never hitting it, and help --env documenting it.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME = mkdtempSync(join(tmpdir(), "brnl-"));
const SESSION = `nolocal-${process.pid}`;
const REFUSAL = /local browsers are off on this machine/;

let failures = 0, checks = 0;
function check(name, ok, detail = "") {
  checks++;
  if (ok) { console.log(`  ok   ${name}`); return true; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n       ${String(detail).split("\n").join("\n       ")}` : ""}`);
  return false;
}

/** browse.mjs straight, not bin/browse: a temp BROWSE_HOME has no playwright,
 *  and BROWSE_PW_BASE points nowhere so that no case can start a browser even
 *  if the guard lets it through. */
function browse(env, ...args) {
  const r = spawnSync(process.execPath, [join(ROOT, "browse.mjs"), ...args], {
    encoding: "utf8",
    env: {
      ...process.env, BROWSE_HOME: HOME, BROWSE_SESSION: SESSION, BROWSE_PW_BASE: join(HOME, "nowhere"),
      BROWSE_REMOTE: undefined, BROWSE_CDP: undefined, BROWSE_LOCAL: undefined, ...env,
    },
    timeout: 120000,
  });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

mkdirSync(HOME, { recursive: true });
writeFileSync(join(HOME, "no-local"), "");

try {
  console.log("refusal");
  const r = browse({}, "open", "about:blank");
  check("open exits 1", r.code === 1, `code ${r.code}\n${r.err}`);
  check("says local browsers are off and names the file", REFUSAL.test(r.err) && r.err.includes(join(HOME, "no-local")), r.err);
  check("points at browse box", /browse box up/.test(r.err) && /--remote <host>/.test(r.err), r.err);
  check("names the override", /BROWSE_LOCAL=1/.test(r.err), r.err);
  const runDir = join(HOME, "run");
  const left = existsSync(runDir) ? readdirSync(runDir).filter((f) => f.startsWith(SESSION)) : [];
  check("leaves no run file or spawn lock", left.length === 0, left.join(", "));

  console.log("override and exemptions");
  const o = browse({ BROWSE_LOCAL: "1" }, "open", "about:blank");
  check("BROWSE_LOCAL=1 gets past the refusal", !REFUSAL.test(o.err), o.err);
  const c = browse({ BROWSE_CDP: "http://127.0.0.1:9" }, "open", "about:blank");
  check("a BROWSE_CDP session is not refused", !REFUSAL.test(c.err), c.err);
  const m = browse({ BROWSE_SSH_OPTS: "-o ConnectTimeout=3" }, "--remote", "no-such-host.invalid", "open", "about:blank");
  check("a --remote session is not refused", m.code !== 0 && !REFUSAL.test(m.err), `code ${m.code}\n${m.err}`);

  console.log("help");
  const h = browse({}, "help", "--env");
  check("help --env documents BROWSE_LOCAL and the file", h.code === 0 && /BROWSE_LOCAL=1/.test(h.out) && /no-local/.test(h.out), h.out.slice(-400));
} finally {
  // Whatever the override case started (it cannot load playwright) goes too.
  browse({ BROWSE_LOCAL: "1" }, "close");
  rmSync(HOME, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
