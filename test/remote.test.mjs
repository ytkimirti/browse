#!/usr/bin/env node
// Integration coverage for --remote: driving a browser that lives on ANOTHER
// machine over an ssh tunnel, and copying its artifacts back.
//
//   node test/remote.test.mjs                      # client + /file endpoint
//   BROWSE_TEST_HOST=<sshhost> node test/remote.test.mjs   # …plus a real remote
//
// Two halves. The first needs no remote at all: flag handling, the error a dead
// host produces, and the daemon's /file endpoint — which is the whole mirroring
// mechanism, exercised against a LOCAL daemon over localhost. The second half
// runs only with BROWSE_TEST_HOST set and drives a real session on it end to
// end, because "the mp4 came back" is not something the local half can prove.
//
// Asserts stdout AND exit status for both the success and the failure paths.

import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, "bin", "browse");
const SESSION = `remotetest-${process.pid}`;
const HOME = mkdtempSync(join(tmpdir(), "browse-remote-"));
const OUT = join(HOME, "out");
const REMOTE_HOST = process.env.BROWSE_TEST_HOST || "";

let failures = 0, checks = 0;
function check(name, ok, detail = "") {
  checks++;
  if (ok) { console.log(`  ok   ${name}`); return true; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n       ${String(detail).split("\n").join("\n       ")}` : ""}`);
  return false;
}

const ENV = { ...process.env, BROWSE_OUT: OUT, BROWSE_SESSION: SESSION, BROWSE_IDLE_MS: "120000" };

/** Client-only command against a throwaway data home — straight to browse.mjs,
 *  since a temp BROWSE_HOME has no playwright and the launcher would install a
 *  fresh copy into it. */
function browse(...args) {
  const r = spawnSync(process.execPath, [join(ROOT, "browse.mjs"), ...args], {
    encoding: "utf8", env: { ...ENV, BROWSE_HOME: HOME }, timeout: 180000,
  });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
/** A command that really starts a browser: the launcher + the REAL data home,
 *  so it finds the installed playwright. Isolation is the session name + OUT. */
function browseLive(...args) {
  const r = spawnSync(BIN, args, { encoding: "utf8", env: ENV, timeout: 300000 });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
/** Same, aimed at the remote host under test. */
function browseRemote(...args) {
  return browseLive("--remote", REMOTE_HOST, ...args);
}
/** …with extra env, for the cases that pin the remote control port. */
function browseRemoteEnv(env, ...args) {
  const r = spawnSync(BIN, ["--remote", REMOTE_HOST, ...args], {
    encoding: "utf8", env: { ...ENV, ...env }, timeout: 300000,
  });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
async function get(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buf };
}

/* ── the flag itself ─────────────────────────────────────────────────────── */

console.log("\n--remote");
{
  let r = browse("--remote");
  check("--remote with no destination fails", r.code === 1 && /wants an ssh destination/.test(r.err), `${r.code} ${r.err}`);

  r = browse("--remote", "--headful", "open");
  check("--remote swallowing the next flag fails", r.code === 1 && /wants an ssh destination/.test(r.err), `${r.code} ${r.err}`);

  // Same rule as -s/-p: after the command it is just an argument, and a silently
  // LOCAL browser is the worst possible outcome of a remote command.
  r = browse("open", "--remote", "somebox");
  check("--remote after the command is refused, not swallowed",
    r.code === 1 && /before the command/i.test(r.err), `${r.code} ${r.err}`);
  check("…and shows the corrected spelling", /--remote somebox open/.test(r.err), r.err);

  r = browse("help");
  check("help documents --remote", r.code === 0 && /--remote <sshhost>/.test(r.out), `${r.code}`);
  r = browse("help", "--env");
  check("help --env documents the remote knobs",
    r.code === 0 && /BROWSE_REMOTE/.test(r.out) && /BROWSE_SSH_PASSWORD/.test(r.out) && /BROWSE_REMOTE_BIN/.test(r.out),
    r.out.slice(0, 200));
}

/* ── a host that isn't there ─────────────────────────────────────────────── */

console.log("\nunreachable host");
{
  const r = spawnSync(process.execPath, [join(ROOT, "browse.mjs"), "--remote", "browse-nosuchhost.invalid", "open"], {
    encoding: "utf8", timeout: 120000,
    env: { ...ENV, BROWSE_HOME: HOME, BROWSE_SSH_OPTS: "-o BatchMode=yes -o ConnectTimeout=5" },
  });
  const err = (r.stderr || "").trim();
  check("an unreachable host fails instead of hanging", r.status === 1, `${r.status} ${err}`);
  check("…and the error names ssh and the host",
    /ssh to browse-nosuchhost.invalid failed/.test(err), err);
  check("…and points at the password knob for a key-less host",
    /BROWSE_SSH_PASSWORD/.test(err), err);
}

/* ── /file: the mirroring mechanism, against a local daemon ──────────────── */

console.log("\ndaemon /file endpoint");
try {
  let r = browseLive("open", "about:blank");
  check("a live session to read artifacts out of", r.code === 0, `${r.code} ${r.err}`);

  r = browseLive("whoami");
  const port = (/port (\d+)/.exec(r.out) || [])[1];
  check("the daemon reports its port", !!port, r.out);

  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  check("/health carries the session dir and its home",
    health.out === OUT && typeof health.home === "string" && health.home.length > 0, JSON.stringify(health));

  // The auto-shot from `open` is the file a remote client would mirror first.
  const shot = readFileSync(join(OUT, "shots", "step-01-open.png"));
  let res = await get(port, "/file?p=shots/step-01-open.png");
  check("/file serves an artifact byte-for-byte",
    res.status === 200 && res.buf.length === shot.length && res.buf.equals(shot),
    `${res.status} ${res.buf.length} vs ${shot.length}`);

  res = await get(port, "/file?p=transcript.md");
  check("/file serves the transcript", res.status === 200 && res.buf.length > 0, `${res.status}`);

  res = await get(port, "/file?p=nope.png");
  check("/file 404s a missing artifact", res.status === 404, `${res.status}`);

  // The port is on 127.0.0.1 (or, on a container, on an interface a tunnel can
  // reach) — either way it must not be a file server for the whole disk.
  for (const bad of ["../../../../etc/passwd", "..%2f..%2fetc%2fpasswd", "/etc/passwd"]) {
    res = await get(port, `/file?p=${encodeURIComponent(bad)}`);
    check(`/file refuses to escape the session dir (${bad.slice(0, 24)})`,
      res.status === 400 || res.status === 404, `${res.status} ${res.buf.toString().slice(0, 60)}`);
  }
  res = await get(port, "/file?p=");
  check("/file with no path is refused", res.status === 400, `${res.status}`);
} finally {
  browseLive("close");
}

/* ── browse-box: the Upstash Box side ────────────────────────────────────── */

// Offline only. Everything past argument handling talks to a real account, and
// the box lifecycle (up/push/exec/down) is exercised by hand against one —
// there is no way to fake a box that would prove anything about the real API.
console.log("\nbrowse-box");
{
  const box = (...args) => {
    const r = spawnSync(join(ROOT, "bin", "browse-box"), args, {
      encoding: "utf8", env: { ...process.env, UPSTASH_BOX_API_KEY: "" }, timeout: 60000,
    });
    return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
  };
  let r = box("help");
  check("browse-box help lists the lifecycle",
    r.code === 0 && /\bup\b/.test(r.out) && /\bdown\b/.test(r.out) && /\bexec\b/.test(r.out) && /\bpush\b/.test(r.out),
    `${r.code} ${r.out.slice(0, 120)}`);
  check("…and says what a box costs while paused", /storage|GB\/month/.test(r.out), r.out.slice(0, 200));
  check("…and hands the host to browse --remote", /BROWSE_REMOTE=\$\(browse-box up\)/.test(r.out), r.out.slice(0, 200));

  r = box("nonsense");
  check("an unknown command exits non-zero with the usage", r.code === 1 && /up \[--new\]/.test(r.out), `${r.code} ${r.out.slice(0, 80)}`);

  // Without a key nothing can work, and the failure has to name the variable
  // rather than surface a 401 from a request that should never have been made.
  r = box("ls");
  check("no API key fails with the variable to set",
    r.code === 1 && /UPSTASH_BOX_API_KEY/.test(r.err), `${r.code} ${r.err.slice(0, 120)}`);
}

/* ── a real remote, end to end ───────────────────────────────────────────── */

if (!REMOTE_HOST) {
  console.log("\nreal remote: skipped (set BROWSE_TEST_HOST=<sshhost> to run it)");
} else {
  console.log(`\nreal remote (${REMOTE_HOST})`);
  try {
    let r = browseRemote("open", "https://example.com");
    check("open on the remote succeeds", r.code === 0 && /example/i.test(r.out), `${r.code} ${r.out}${r.err}`);
    check("…and names the step screenshot", /\[shots\/step-01-open\.png\]/.test(r.out), r.out);

    r = browseRemote("dir");
    const dir = r.out.split("\n")[0].trim();
    check("dir prints a LOCAL mirror dir", r.code === 0 && existsSync(dir), `${r.code} ${r.out}`);
    check("…and still says where the browser's own copy is",
      new RegExp(`remote:.*on ${REMOTE_HOST.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(r.out), r.out);
    check("the step screenshot was copied down",
      existsSync(join(dir, "shots", "step-01-open.png")) && statSync(join(dir, "shots", "step-01-open.png")).size > 1000,
      `nothing at ${join(dir, "shots")}`);

    // An explicit artifact: the path printed must be one this machine can open,
    // not the remote path it was written to.
    r = browseRemote("screenshot", "proof.png");
    const shotPath = (/saved (\S+)/.exec(r.out) || [])[1];
    check("screenshot prints a path that exists HERE",
      r.code === 0 && shotPath && existsSync(shotPath), `${r.code} ${r.out}`);

    // A failing command must fail the same way it does locally — the tunnel is
    // not allowed to turn an error into a hang or a zero exit.
    r = browseRemote("click", "text=no-such-element-anywhere");
    check("a failing remote command exits non-zero", r.code === 1 && /Timeout|not found|waiting for/i.test(r.err), `${r.code} ${r.err}`);

    // The remote control port is derived from the session name, so something
    // else already holding it has to fail FAST and say which port — not spend
    // the whole start-up poll to report a browser that "did not come up". Two
    // sessions pinned to one port is the cheapest way to really occupy it.
    const pinned = { BROWSE_PORT: "47321" };
    r = browseRemoteEnv(pinned, "-s", `${SESSION}-pin`, "open", "about:blank");
    check("a session on a pinned remote port opens", r.code === 0, `${r.code} ${r.err}`);
    r = browseRemoteEnv(pinned, "-s", `${SESSION}-pin2`, "url");
    check("a second session on that port is refused, not waited out",
      r.code === 1 && /already taken by browse session/.test(r.err), `${r.code} ${r.err}`);
    check("…and the error names the port and the way out",
      /47321/.test(r.err) && /BROWSE_PORT/.test(r.err), r.err);
    browseRemoteEnv(pinned, "-s", `${SESSION}-pin`, "close");

    r = browseRemote("close");
    const mp4 = (/mp4:\s+(\S+)/.exec(r.out) || [])[1];
    check("close reports an mp4", r.code === 0 && !!mp4, `${r.code} ${r.out}`);
    // Size alone would pass on a truncated pull, so check it is really an mp4:
    // bytes 4..8 of one are the `ftyp` box type.
    const head = mp4 && existsSync(mp4) ? readFileSync(mp4).subarray(4, 8).toString("latin1") : "";
    check("…and the mp4 is HERE, and is a whole mp4",
      mp4 && existsSync(mp4) && statSync(mp4).size > 2000 && head === "ftyp",
      `${mp4}: ${mp4 && existsSync(mp4) ? `${statSync(mp4).size}B, box '${head}'` : "missing"}`);
    check("…and the transcript came with it", existsSync(join(dir, "transcript.md")), dir);
    check("…and the network log came with it", existsSync(join(dir, "network.jsonl")), dir);

    r = browseRemote("close");
    check("closing an already-closed remote session is a no-op",
      r.code === 0 && /no active browser session/.test(r.out), `${r.code} ${r.out}`);
  } finally {
    browseRemote("close");
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
