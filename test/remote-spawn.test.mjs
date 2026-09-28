#!/usr/bin/env node
// Integration coverage for starting a --remote daemon, against a fake ssh whose
// "remote" is this machine under another HOME (test/ssh-fixture.mjs). The
// client, the launcher's `__serve` path and the daemon are all the real ones;
// only the transport is faked.
//
//   node test/remote-spawn.test.mjs
//
// Covers: the launcher starting a remote daemon at all (its preflight once ran
// `__serve` itself and killed every remote session), a daemon that dies at
// start-up failing the client fast with the real error, and `init --file`
// being read on the client, and refused there before any session starts.
//
// Asserts output AND exit status for the success and the failure paths.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, symlinkSync, copyFileSync, chmodSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, "bin", "browse");
const REAL_HOME = join(homedir(), ".browse");
// /tmp, not tmpdir(): macOS's is deep enough that the ssh ControlPath built
// under it blows the 104-byte socket limit.
const STORE = mkdtempSync("/tmp/brs-");
const CLIENT_HOME = join(STORE, "c");
const REMOTE_HOME = join(STORE, "r");
const CLIENT_CWD = join(STORE, "cwd");
const FAKEBIN = join(STORE, "bin");
const SESSION = `rspawn-${process.pid}`;

let failures = 0, checks = 0;
function check(name, ok, detail = "") {
  checks++;
  if (ok) { console.log(`  ok   ${name}`); return true; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n       ${String(detail).split("\n").join("\n       ")}` : ""}`);
  return false;
}

// Both data homes borrow the installed Playwright rather than downloading one:
// the launcher installs into whatever BROWSE_HOME it is given otherwise.
function seedHome(dir) {
  mkdirSync(dir, { recursive: true });
  symlinkSync(join(REAL_HOME, "node_modules"), join(dir, "node_modules"));
  copyFileSync(join(REAL_HOME, "package.json"), join(dir, "package.json"));
  if (existsSync(join(REAL_HOME, "camoufox-pw"))) symlinkSync(join(REAL_HOME, "camoufox-pw"), join(dir, "camoufox-pw"));
}
if (!existsSync(join(REAL_HOME, "node_modules", "playwright"))) {
  console.log("skipped: needs an installed browse (run: browse setup)");
  process.exit(0);
}
seedHome(CLIENT_HOME);
seedHome(join(REMOTE_HOME, ".browse"));
mkdirSync(CLIENT_CWD);
mkdirSync(FAKEBIN);
const quote = (s) => `'${s.replace(/'/g, `'"'"'`)}'`;
writeFileSync(join(FAKEBIN, "ssh"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(ROOT, "test", "ssh-fixture.mjs"))} ssh "$@"\n`, { mode: 0o755 });
// macOS has no setsid; the remote spawn line uses it.
const shims = join(STORE, "shims");
mkdirSync(shims);
writeFileSync(join(shims, "setsid"), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
// A remote whose browse answers `version` but whose daemon cannot load
// Playwright: exactly the shape of the broken launcher this suite guards.
const BROKEN = join(STORE, "broken-browse");
writeFileSync(BROKEN, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(ROOT, "browse.mjs"))} "$@"\n`);
chmodSync(BROKEN, 0o755);

const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH ||
  (platform() === "darwin" ? join(homedir(), "Library", "Caches", "ms-playwright") : join(homedir(), ".cache", "ms-playwright"));
const ENV = { ...process.env, PATH: `${FAKEBIN}:${process.env.PATH}`, BROWSE_HOME: CLIENT_HOME,
  BROWSE_REMOTE_BIN: BIN, BROWSE_ENGINE: "chromium", BROWSE_VIDEO: "0", BROWSE_SESSION: SESSION,
  BROWSE_SSH_PASSWORD: "", UPSTASH_BOX_API_KEY: "", BROWSE_REMOTE_SPAWN: "", BROWSE_PROFILE: "",
  FAKE_REMOTE_HOME: REMOTE_HOME, FAKE_REMOTE_BROWSERS: browsers,
  FAKE_REMOTE_PATH: `${shims}:${dirname(process.execPath)}:${process.env.PATH}` };
for (const k of ["BROWSE_OUT", "BROWSE_PORT", "BROWSE_REMOTE", "BROWSE_CDP", "BROWSE_PW_BASE"]) delete ENV[k];

function remote(extraEnv, ...args) {
  const at = Date.now();
  const r = spawnSync(BIN, ["--remote", "fakehost", ...args], {
    encoding: "utf8", cwd: CLIENT_CWD, env: { ...ENV, ...extraEnv }, timeout: 180000 });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim(), ms: Date.now() - at };
}
const spawnLogs = () => readdirSync(join(REMOTE_HOME, ".browse")).filter((f) => f.startsWith("spawn-"));

try {
  console.log("\nthe launcher's probes never start a daemon");
  {
    const home = join(STORE, "probe");
    const r = spawnSync(process.execPath, [join(ROOT, "browse.mjs"), "__serve"], {
      encoding: "utf8", timeout: 20000,
      env: { ...ENV, BROWSE_HOME: home, BROWSE_PREFLIGHT: "1", BROWSE_PORT: "0" } });
    check("BROWSE_PREFLIGHT=1 __serve exits 0 without serving", r.status === 0, `${r.status} ${r.stderr}`);
    check("…and creates no session", !existsSync(join(home, "sessions")), home);
  }

  console.log("\na remote daemon starts through the launcher");
  let r = remote({}, "open", "about:blank");
  check("--remote open succeeds", r.code === 0 && /\[shots\/[^\]]+\.png\]/.test(r.out), `${r.code} ${r.out}\n${r.err}`);
  check("…with the daemon spawned by the remote launcher (per-session spawn log)",
    spawnLogs().includes(`spawn-${SESSION}.log`), spawnLogs().join(","));

  console.log("\ninit --file is read on the client");
  writeFileSync(join(CLIENT_CWD, "mark.js"), "window.__mark = 'from-client-file';\n");
  r = remote({}, "init", "--file", "mark.js");
  check("init --file with a client-relative path registers", r.code === 0 && /init \+#1/.test(r.out), `${r.code} ${r.out}\n${r.err}`);
  r = remote({}, "goto", "data:text/html,<p>x</p>");
  r = remote({}, "eval", "window.__mark");
  check("…and the script runs on the next navigation", r.code === 0 && /from-client-file/.test(r.out), `${r.code} ${r.out}\n${r.err}`);

  // The daemon never opens the path, so a caller whose file is only on its own
  // machine works the same over --remote. A body without the source is refused.
  const port = Number((/port (\d+)/.exec(remote({}, "whoami").out) || [])[1]);
  if (port) {
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST",
      body: JSON.stringify({ cmd: "init", args: ["--file", join(CLIENT_CWD, "mark.js")] }) }).then((x) => x.json());
    check("the daemon does not read an init --file path itself",
      res.ok === false && /arrived without its contents/.test(res.error), JSON.stringify(res));
  } else check("whoami names the tunnel port", false, "no port");

  console.log("\na failing first init leaves no session behind");
  const fresh = `${SESSION}-f`;
  r = remote({}, "-s", fresh, "init", "--file", "missing.js");
  check("an unreadable init --file exits 1 and says so",
    r.code === 1 && /cannot read 'missing\.js'/.test(r.err) && /on this machine/.test(r.err), `${r.code} ${r.err}`);
  check("…without starting a remote daemon", !spawnLogs().includes(`spawn-${fresh}.log`), spawnLogs().join(","));
  writeFileSync(join(CLIENT_CWD, "bad.js"), "window.(\n");
  r = remote({}, "-s", fresh, "init", "--file", "bad.js");
  check("a file that does not parse exits 1 before starting anything",
    r.code === 1 && /'bad\.js' does not parse/.test(r.err) && !spawnLogs().includes(`spawn-${fresh}.log`), `${r.code} ${r.err}`);
  r = remote({}, "-s", fresh, "--viewport", "800x600", "open", "about:blank");
  check("…so the retry's launch flags are accepted, not refused", r.code === 0 && !/only applies when the browser starts/.test(r.err), `${r.code} ${r.err}`);
  remote({}, "-s", fresh, "close");

  console.log("\na remote daemon that dies at start-up");
  r = remote({ BROWSE_REMOTE_BIN: BROKEN }, "-s", `${SESSION}-broken`, "open", "about:blank");
  check("fails with exit 1", r.code === 1, `${r.code} ${r.out}\n${r.err}`);
  check("…fast, not after the start-up timeout", r.ms < 30000, `${r.ms}ms`);
  check("…and names the real error from the remote log",
    /failed to start on fakehost/.test(r.err) && /Cannot find module/.test(r.err), r.err);

  r = remote({}, "close");
  check("close on the remote session exits 0", r.code === 0 && /closed/.test(r.out), `${r.code} ${r.out}\n${r.err}`);
} finally {
  remote({}, "close");
  remote({}, "-s", `${SESSION}-f`, "close");
  rmSync(STORE, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
