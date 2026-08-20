#!/usr/bin/env node
/**
 * box.mjs — what `browse box` runs. Upstash Boxes for `browse --remote`: make one, put browse on it,
 * copy files in and out, run commands on it, and stop it when you are done.
 *
 *   browse box help
 *
 * None of this is part of browse. browse only needs ssh and a `browse` on the
 * far side; this is one way to arrange that, and the cost control around it.
 *
 * Needs the Box API key, which is also what `browse --remote` hands the box's
 * ssh as its password — so once a box is up there is nothing else to configure.
 * `browse box key` saves it 0600 in ~/.browse/box.json; UPSTASH_BOX_API_KEY
 * still wins when set. It lives in a file rather than a shell export so one
 * credential is not in the environment of every process on the machine.
 *
 * Everything goes through the box's HTTP API rather than ssh, on purpose: a
 * box's ssh gateway attaches into the container, relays back neither stdout nor
 * an exit status, and kills whatever a command leaves running. The API does
 * none of that.
 *
 * The model: a box is DISPOSABLE. `up` makes one from a snapshot that already
 * has browse, Chromium and ffmpeg on it (~13s, no install), and `down` deletes
 * it. Nothing is left running, and nothing bills between sessions except the
 * one snapshot's storage. The snapshot is built once by `image`, which is the
 * only slow step (~6 min) and the only thing worth keeping.
 *
 * Two box facts the commands are built around:
 *   • Only /workspace/home belongs to the box user, so everything installed
 *     lands there. A snapshot, though, restores the WHOLE disk — the apt
 *     packages and /usr/local/bin/browse come back with it.
 *   • Restoring is `POST /v2/box/from-snapshot`. Passing `snapshot_id` to plain
 *     `POST /v2/box` is silently ignored: you get an empty box and no error.
 */

import { readFile, writeFile, mkdir, readdir, stat, chmod, rename } from "node:fs/promises";
import { createWriteStream, createReadStream } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, basename, resolve as resolvePath } from "node:path";

const BASE = process.env.UPSTASH_BOX_URL || "https://us-east-1.box.upstash.com";
const REPO = process.env.BROWSE_REPO || "https://github.com/ytkimirti/browse";
// The box user's own, persistent half of the volume (see the header).
const WORK = "/workspace/home";
// Remembers the last snapshot taken, so `up` starts warm without being told an
// id. One file, next to browse's own data.
const STATE = join(process.env.BROWSE_HOME || join(homedir(), ".browse"), "box.json");
// A backstop, not a schedule: a session box you forget deletes itself rather
// than sitting on the account. Eight hours outlasts any browse session; the API
// caps it at three days.
const TTL_DEFAULT = 28800;

/** Fail the command. A THROW, not process.exit: `buildImage` deletes its builder
 *  box in a `finally`, and process.exit skips finally blocks — so an install that
 *  failed used to leave a box nobody was watching. Caught at the bottom of the
 *  file, which prints and sets the exit status. */
class BoxError extends Error {}
const die = (msg) => { throw new BoxError(msg); };
const say = (msg) => process.stderr.write(`${msg}\n`); // stdout stays machine-readable
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Cut long API/error bodies, and SAY that they were cut — a silently clipped
 *  error reads as the whole error. */
const clip = (text, n) => {
  const t = String(text ?? "").trim();
  return t.length <= n ? t : `${t.slice(0, n)}… (${t.length - n} more chars)`;
};

async function api(method, path, body, timeout = 120000) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "X-Box-Api-Key": await apiKey(), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  }).catch((e) => die(`${method} ${path}: ${e.message}`));
  const text = await res.text();
  if (!res.ok) die(`${method} ${path} → ${res.status} ${clip(text, 300)}`);
  return text ? JSON.parse(text) : {};
}

/** Accepts a box id or the ssh host `--remote` uses, so `$BROWSE_REMOTE` can be
 *  passed to any of these commands verbatim. */
const boxId = (s) => String(s || "").split("@")[0].trim();
const sshHost = (id) => `${id}@${new URL(BASE).host}`;

/** One command in the box. Unlike ssh, this gives back output and a status. */
const exec = (id, command, timeout) =>
  api("POST", `/v2/box/${id}/exec`, { command: ["sh", "-c", command] }, timeout);

async function readState() {
  try { return JSON.parse(await readFile(STATE, "utf8")); } catch { return {}; }
}
// 0600 because the same file now holds the API key. It is rewritten on every
// `up`/`down`, so the mode has to be set on the write, not once at setup.
async function writeState(patch) {
  const next = { ...(await readState()), ...patch };
  await mkdir(join(STATE, ".."), { recursive: true });
  // Write-then-rename: writeFile truncates in place, so a process killed midway
  // through leaves JSON that will not parse — and readState swallows that, which
  // would silently lose the API key the file now holds.
  const tmp = `${STATE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {}); // umask can widen the create mode
  await rename(tmp, STATE);
  return next;
}
/** Everything on stdin, for a secret that should not be an argument. At a
 *  terminal nothing is piped in, so PROMPT rather than returning empty: passing
 *  the key as an argument is the exact thing this exists to avoid, and telling
 *  someone to remember a pipe idiom is not a fix. Read from /dev/tty with echo
 *  off, so a pasted credential is not left on screen either. */
async function readStdin() {
  if (!process.stdin.isTTY) {
    let out = "";
    for await (const chunk of process.stdin) out += chunk;
    return out;
  }
  const echo = (on) => spawnSync("stty", [on ? "echo" : "-echo"], { stdio: ["inherit", "ignore", "ignore"] });
  process.stderr.write("paste the Box API key (not echoed): ");
  echo(false);
  const tty = createReadStream("/dev/tty");
  try {
    let line = "";
    for await (const chunk of tty) { line += chunk; if (line.includes("\n")) break; }
    return line;
  } finally { tty.destroy(); echo(true); process.stderr.write("\n"); }
}
/** The API key: the env var, else what `browse box key` saved. Read per call
 *  rather than at load so `key` itself can run without one. */
async function apiKey() {
  return process.env.UPSTASH_BOX_API_KEY || (await readState()).apiKey || null;
}

/* ── installing browse onto a box ─────────────────────────────────────────── */

// Everything browse needs that a bare box does not have. `browse setup` pulls
// Playwright, Chromium and (being root-capable here) Chromium's system
// libraries itself; this provides what setup assumes: ffmpeg for the mp4
// finalize, fonts so headless Chromium renders text instead of boxes, and
// browse on PATH with its data pointed at the persistent volume.
const INSTALL = `set -e
sudo apt-get update -qq
echo "installing ffmpeg + fonts…"
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg fonts-liberation fonts-noto-color-emoji git
echo "fetching browse…"
if [ -d ${WORK}/browse/.git ]; then (cd ${WORK}/browse && git pull -q); else git clone -q --depth 1 ${REPO} ${WORK}/browse; fi
chmod +x ${WORK}/browse/bin/browse
# A wrapper, not a symlink: BROWSE_HOME and Playwright's browser cache have to
# land on the persistent volume rather than in ~/.cache, and a non-interactive
# ssh command reads no shell profile that could set them.
printf '#!/bin/sh\\nexport BROWSE_HOME=\${BROWSE_HOME:-${WORK}/.browse}\\nexport PLAYWRIGHT_BROWSERS_PATH=\${PLAYWRIGHT_BROWSERS_PATH:-${WORK}/.browse/ms-playwright}\\nexec ${WORK}/browse/bin/browse "$@"\\n' | sudo tee /usr/local/bin/browse > /dev/null
sudo chmod +x /usr/local/bin/browse
echo "installing playwright + chromium (~1GB, a few minutes)…"
browse setup`;

/** Run a long script in the box and stream its log. The exec API is not a place
 *  to hold a connection open for minutes, so the script runs detached against a
 *  log file and this polls it — the same shape as watching a build, and it
 *  survives a dropped laptop. */
async function runScript(id, script, label) {
  const log = `${WORK}/browse-install.log`;
  // Probe first: a detached run that cannot even create its log (unwritable
  // dir, a box that is not up) looks exactly like a slow one, and this would
  // poll a file that is never going to exist.
  const probe = await exec(id, `rm -f ${log} && touch ${log} && echo ok`);
  if (probe.exit_code !== 0) die(`cannot write ${log} on ${id}: ${clip(probe.error || probe.output, 200)}`);
  // base64, not a quoted script: a multi-line one loses its newlines on the way
  // across (they arrive as a literal \n, the whole thing collapses onto one
  // line, and the first `then` is a syntax error).
  // The marker runs in the PARENT shell, not inside the script: INSTALL opens with
  // `set -e`, so appending the echo to the script itself meant a failing step
  // exited before it ever printed — the failure branch below was unreachable and
  // every broken install was reported 20 minutes later as a timeout.
  const payload = Buffer.from(script).toString("base64");
  await exec(id, `nohup setsid sh -c "echo ${payload} | base64 -d | sh; echo __DONE__ \$?" > ${log} 2>&1 </dev/null &`);
  let seen = 0;
  for (let i = 0; i < 240; i++) {
    await sleep(5000);
    const { output = "" } = await exec(id, `cat ${log} 2>/dev/null || true`);
    for (const line of output.slice(seen).split("\n").filter(Boolean)) {
      if (!line.startsWith("__DONE__")) say(`  ${line}`);
    }
    seen = output.length;
    const done = /__DONE__ (\d+)/.exec(output);
    if (done) {
      if (done[1] !== "0") die(`${label} failed on the box — full log: ${log}`);
      return;
    }
  }
  die(`${label} did not finish in 20 minutes — check ${log} on the box`);
}

/* ── file transfer ────────────────────────────────────────────────────────── */

async function filesUnder(path) {
  const st = await stat(path); // stat, not lstat: a symlinked target is what we want
  if (!st.isDirectory()) return [{ abs: resolvePath(path), rel: basename(path) }];
  const out = [];
  const walk = async (dir, prefix) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue; // never worth uploading
      const abs = join(dir, e.name), rel = `${prefix}/${e.name}`;
      // isDirectory() is false for a SYMLINK to a directory, which then got
      // queued as a file and blew up on readFile with a raw EISDIR. Resolve the
      // link to decide; a dangling one is skipped rather than fatal.
      let dir_;
      try { dir_ = (e.isSymbolicLink() ? await stat(abs) : e).isDirectory(); }
      catch { say(`  skipping ${rel} (broken symlink)`); continue; }
      if (dir_) await walk(abs, rel);
      else out.push({ abs, rel });
    }
  };
  await walk(resolvePath(path), basename(path));
  return out;
}

async function push(id, paths, dest) {
  const form = new FormData();
  let n = 0;
  for (const p of paths) {
    for (const f of await filesUnder(p).catch(() => die(`no such file: ${p}`))) {
      const body = await readFile(f.abs).catch((e) => die(`cannot read ${f.abs}: ${e.code || e.message}`));
      form.append("paths", `${dest}/${f.rel}`);
      form.append("files", new Blob([body]), f.rel);
      n++;
    }
  }
  if (!n) die("nothing to push");
  const res = await fetch(`${BASE}/v2/box/${id}/files/upload`, {
    method: "POST", headers: { "X-Box-Api-Key": await apiKey() }, body: form,
    signal: AbortSignal.timeout(600000),
  }).catch((e) => die(`upload: ${e.message}`));
  if (!res.ok) die(`upload → ${res.status} ${(await res.text()).slice(0, 200)}`);
  say(`pushed ${n} file${n > 1 ? "s" : ""} to ${dest}/ on ${id}`);
  // Uploads arrive without their exec bit, which is silent until something tries
  // to run one and gets "Permission denied" with no other clue.
  await exec(id, `find ${dest} -maxdepth 3 -name '*.sh' -o -path '*/bin/*' -type f | xargs -r chmod +x`);
}

async function pull(id, remote, dest) {
  const url = `${BASE}/v2/box/${id}/files/download?folder=${encodeURIComponent(remote)}`;
  const res = await fetch(url, { headers: { "X-Box-Api-Key": await apiKey() }, signal: AbortSignal.timeout(600000) })
    .catch((e) => die(`download: ${e.message}`));
  if (!res.ok) die(`download ${remote} → ${res.status}`);
  const out = dest || `./${basename(remote)}`;
  await new Promise((ok, no) => {
    const w = createWriteStream(out);
    w.on("error", no); w.on("finish", ok);
    res.body.pipeTo(new WritableStream({ write: (c) => void w.write(c), close: () => w.end() })).catch(no);
  });
  process.stdout.write(`${out}\n`);
}

/** Every box on the account, flattened out of the two shapes the API answers in. */
async function listBoxes() {
  const boxes = await api("GET", "/v2/box");
  return Array.isArray(boxes) ? boxes : boxes.boxes || [];
}
/** A box THIS made: the label it is created with, or the name `up` gives it.
 *  Only ever consulted to decide what an argument-less `down` is allowed to
 *  delete — an explicit id is always obeyed. */
const isBrowseBox = (b) => (b?.labels || []).includes("browse") || /^browse-/.test(b?.name || "");
/** Does this `--remote` target point at a box on THIS API, rather than at some
 *  other ssh host? `down` reads $BROWSE_REMOTE, and deleting by an id parsed out
 *  of `--remote nerd` would be a DELETE against an id that is not a box's.
 *  The hostname alone, not host:port — the API base carries a port in tests and
 *  an ssh target may carry one anywhere. */
const isBoxHost = (s) => {
  const after = String(s || "").split("@")[1];
  const hostOf = (h) => String(h).split(":")[0];
  return !!after && hostOf(after) === hostOf(new URL(BASE).host);
};

/** Every browse image on the account, newest first. Snapshots outlive the box
 *  they were taken from, so this is the only durable list of them — the box a
 *  snapshot names is usually long deleted. */
async function listImages() {
  const { snapshots = [] } = await api("GET", "/v2/box/snapshots");
  return snapshots
    .filter((s) => s.status === "ready" && /^browse-/.test(s.name || ""))
    .sort((a, b) => b.created_at - a.created_at);
}
const newestImage = async () => (await listImages())[0];

/** Build the warm image: a throwaway box, browse installed on it, a snapshot of
 *  the result, and the box deleted. A snapshot restores the WHOLE disk, so the
 *  apt packages and /usr/local/bin/browse come back with it and a session box
 *  has nothing left to install. Snapshots outlive the box they came from. */
async function buildImage(size) {
  say(`creating a ${size} box to build the image on…`);
  // ephemeral + a ttl on the BUILDER too. It lives ~6 minutes and is deleted in
  // the finally below, but that window is long enough to lose a laptop or hit
  // Ctrl-C in, and a builder with no expiry is a box that bills until someone
  // reads the console. An hour outlasts any real build.
  let box = await api("POST", "/v2/box",
    { name: "browse-image-builder", size, runtime: "node", labels: ["browse"], ephemeral: true, ttl: 3600 }, 300000);
  for (let i = 0; i < 90 && box.status === "creating"; i++) {
    await sleep(2000);
    box = await api("GET", `/v2/box/${box.id}`);
  }
  if (box.status === "creating") {
    await api("DELETE", `/v2/box/${box.id}`).catch(() => {});
    die(`${box.id} never finished creating — deleted it; try again`);
  }
  try {
    await runScript(box.id, INSTALL, "install");
    say("snapshotting it…");
    const snap = await api("POST", `/v2/box/${box.id}/snapshots`, { name: `browse-${Date.now().toString(36)}` }, 600000);
    for (let i = 0; i < 120; i++) {
      const { snapshots = [] } = await api("GET", `/v2/box/${box.id}/snapshots`);
      const mine = snapshots.find((x) => x.id === snap.id);
      if (mine && mine.status !== "creating") {
        if (mine.status !== "ready") die(`snapshot ${snap.id} ended up ${mine.status}`);
        say(`image ${snap.id} ready (${(mine.size_bytes / 1e9).toFixed(1)}GB)`);
        break;
      }
      if (i === 119) die(`snapshot ${snap.id} did not become ready`);
      await sleep(5000);
    }
    await writeState({ snapshot: snap.id });
    return snap.id;
  } finally {
    // The builder has done its job either way, and a forgotten one is a box
    // nobody is watching. The snapshot survives it.
    await api("DELETE", `/v2/box/${box.id}`).catch(() => {});
    say(`builder ${box.id} deleted`);

  }
}

/* ── commands ─────────────────────────────────────────────────────────────── */

const HELP = `browse box — disposable Upstash Boxes for 'browse --remote'

  up [--ttl <sec>] [--size medium|small] [--name <n>] [--snapshot <id>]
                              make a box from the warm image and print its --remote host.
                              ~13s, nothing to install. Builds the image first if there
                              isn't one yet (~6 min, once). The box also deletes itself
                              after --ttl (default ${TTL_DEFAULT}s) if you never call down.
                              --size picks the DISK and nothing else (same CPU and RAM
                              either way): medium is 10GB, small is 5GB — of which the warm
                              image already uses ~2.5GB, so 'small' does not fit an app's
                              node_modules. Each box gets a unique name; --name overrides it
  down [box]                  DELETE it. With no argument: the box in $BROWSE_REMOTE, else the
                              only browse box up. It REFUSES to guess between several — box.json
                              is shared by every process here, so guessing deletes the box
                              another agent is recording on
  image [--size medium]       build the warm image: a box, browse installed on it, snapshot
                              taken, box thrown away. Re-run after a browse update
  ls                          boxes and images on the account
  key [<key>]                 save the Box API key 0600 in ~/.browse/box.json, so it does not
                              have to be exported into every process. With no argument it reads
                              stdin, which keeps it out of 'ps' and your shell history.
                              UPSTASH_BOX_API_KEY still wins when set

  exec <box> <cmd…>           run a command on the box and show its output. This is how you
                              install and start a dev server there — ssh into a box relays
                              nothing back. Leave something RUNNING with 'setsid nohup <cmd>
                              >/tmp/x.log 2>&1 &'. Note a 'pkill -f <pattern>' in here matches
                              exec's OWN shell (the pattern is in its command line) and kills
                              the command that is doing the killing — go by port or pid file
  push <box> <path…> [--to <dir>]   copy files or dirs in (default ${WORK}, skips .git/node_modules)
  pull <box> <remote> [local]       copy one file out
  url <box> <port>            public https URL for a port, to hand someone who wants to click
                              around the app themselves. The server must be listening on
                              0.0.0.0, not 127.0.0.1, or the URL answers 502
  install <box>               (re)install browse on a box, e.g. to refresh the image builder

<box> is a box id or the '<id>@…' host you pass to browse --remote, so $BROWSE_REMOTE works.

A session, end to end:
  export BROWSE_REMOTE=$(browse box up)
  browse box push $BROWSE_REMOTE ./my-app
  browse box exec $BROWSE_REMOTE 'cd ${WORK}/my-app && npm i'
  browse box exec $BROWSE_REMOTE 'cd ${WORK}/my-app && setsid nohup npm run dev >/tmp/dev.log 2>&1 &'
  browse open http://127.0.0.1:3000     # 127.0.0.1 is the BOX's
  browse close                          # the mp4 lands here
  browse box down                       # gone — $BROWSE_REMOTE says which one

Costs: CPU seconds while it runs, and the image's storage (~0.6GB, cents a month)
between sessions. A box you forget still bills nothing once idle, and expires by
itself at the TTL.
`;

/** Pull `--name value` out of the args, leaving the positionals behind. */
function flag(name, fallback) {
  const i = rest.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const [, value] = rest.splice(i, 2);
  return value ?? fallback;
}

const args = process.argv.slice(2);
const cmd = args[0];
const rest = args.slice(1);
// The key is checked here rather than at load: `help` (and a typo, which prints
// help) must answer on a machine that has no key yet — that is the command you
// run to find out what to set.
const NEEDS_KEY = new Set(["up", "down", "image", "ls", "exec", "push", "pull", "url", "install"]);

try {
if (NEEDS_KEY.has(cmd) && !(await apiKey()))
  die("no Box API key. Make one at https://console.upstash.com (Box), then:\n" +
      "       browse box key          # it prompts, so the key stays out of ps and your history\n" +
      "     UPSTASH_BOX_API_KEY overrides the saved one when set.");

switch (cmd) {
  case "up": {
    // medium, not small: on this platform `size` buys DISK and nothing else —
    // small and medium hand out the same 48 cores and the same 185GB of RAM, and
    // differ only in the overlay (5GB vs 10GB). 5GB is about 2.5GB once the warm
    // image is restored, which a real app's `node_modules` + a Next build fills.
    // A full disk there does not say so: chromium's renderer dies and playwright
    // reports "Target crashed", which reads as a browse fault (browse now checks
    // the disk when a target crashes, but not paying for the crash is better).
    const size = flag("size", "medium");
    const ttlRaw = String(flag("ttl", TTL_DEFAULT));
    // Unvalidated, `--ttl 8h` became NaN, serialized to null, and the box got
    // whatever the API defaults to while we printed "expires in NaNh".
    if (!/^\d+$/.test(ttlRaw)) die(`--ttl wants whole seconds, e.g. --ttl 3600 (got: ${ttlRaw})`);
    const ttl = Number(ttlRaw);
    // The account is the source of truth for which images exist — a local note
    // of the last one is a convenience, not a record, and a machine that has
    // never run this should still find the image you built on another one.
    let snapshot = flag("snapshot", (await readState()).snapshot) || (await newestImage())?.id;
    if (!snapshot) {
      say("no warm image yet — building one first (once, ~6 minutes)");
      snapshot = await buildImage(flag("image-size", "medium"));
    }
    // from-snapshot, NOT plain create with a snapshot_id: that field is ignored
    // there and you get an empty box back with no error to tell you.
    // `ephemeral` boxes are ready the moment the call returns — no polling — and
    // expire on their own, which is what makes a box safe to just make one of.
    const box = await api("POST", "/v2/box/from-snapshot", {
      snapshot_id: snapshot, ephemeral: true, ttl, size, runtime: "node",
      // Unique per box, not a fixed "browse-session": the API rejects a duplicate
      // name outright (409 "already in use"), so a second agent's `up` failed
      // while the first one's box was alive — and two agents at once is the whole
      // reason to run the browser somewhere else. Still `browse-`-prefixed, which
      // is what `down` recognises as ours.
      name: flag("name", `browse-${Date.now().toString(36)}`), labels: ["browse"],
    }, 600000);
    if (!box.id) die(`from-snapshot returned no box: ${JSON.stringify(box).slice(0, 200)}`);
    // One exec for both: is browse really on this image, and how much disk is
    // left for the app that is about to be pushed here.
    const ready = await exec(box.id, "command -v browse >/dev/null && browse version && df -Pm / | tail -1");
    if (ready.exit_code !== 0) {
      await api("DELETE", `/v2/box/${box.id}`).catch(() => {});
      die(`image ${snapshot} has no browse on it — rebuild it with: browse box image`);
    }
    const [version = "", dfLine = ""] = String(ready.output).trim().split("\n");
    const freeMb = Number(dfLine.trim().split(/\s+/)[3]);
    // Remember the image too, so a one-off `--snapshot` becomes the default and
    // the next `up` needs no arguments.
    await writeState({ box: box.id, snapshot });
    say(`${box.id} up from ${snapshot} — ${version.trim()}, expires in ${Math.round(ttl / 3600)}h` +
        (freeMb ? `, ${(freeMb / 1024).toFixed(1)}GB disk free` : ""));
    // Named, because `down` with no argument now refuses when the account has
    // more than one box up rather than guessing at one.
    say(`Delete it when you are done: browse box down ${box.id}`);
    process.stdout.write(`${sshHost(box.id)}\n`);
    break;
  }
  case "key": {
    // Written through writeState so it lands 0600 next to the snapshot id, and
    // so saving a key never clobbers the box/image already noted there.
    //
    // Reads stdin when given no argument (or `-`): an argument is visible in `ps`
    // to every user on the machine and lands in the shell's history file, which
    // is most of what keeping the key out of the environment was for.
    const value = (rest[0] && rest[0] !== "-" ? rest[0] : await readStdin()).trim();
    if (!value) die("key needs the API key: browse box key <key>, or pipe it in.\n" +
                     "     Make one at https://console.upstash.com (Box); they start with box_");
    // Never echo the rejected value: pasting the wrong Upstash token here is the
    // likely mistake, and that token is live somewhere else.
    if (!/^box_\w+$/.test(value)) die("that does not look like a Box API key (they start with box_)");
    await writeState({ apiKey: value });
    say(`saved to ${STATE} (0600)`);
    break;
  }
  case "down": {
    // Three ways to name the box, in order of how sure each one is:
    //   1. the argument
    //   2. $BROWSE_REMOTE — the box THIS shell is driving
    //   3. the note `up` left in box.json
    //
    // (3) used to be the only fallback, and box.json is one file shared by every
    // process on the machine: a second agent's `up` overwrites it, so the first
    // agent's bare `down` deleted the SECOND agent's box, mid-session, and said
    // it had deleted its own. That is unrecoverable — the recording goes with the
    // box — so the note is now only trusted when it is the account's only browse
    // box. Anything else refuses and prints the list, which costs a turn instead
    // of a session.
    let id = boxId(rest[0]);
    let why = "";
    if (!id && isBoxHost(process.env.BROWSE_REMOTE)) {
      id = boxId(process.env.BROWSE_REMOTE);
      why = " (from $BROWSE_REMOTE)";
    }
    if (!id) {
      const noted = boxId((await readState()).box);
      const mine = (await listBoxes()).filter(isBrowseBox);
      if (!mine.length) {
        // Teardown runs at the end of a session, often after the box already
        // expired or someone else deleted it. Nothing to do is not a failure.
        if (noted) await writeState({ box: null });
        say(noted ? `${noted} is already gone (expired or deleted)` : "no browse box is up");
        break;
      }
      if (mine.length > 1 || (noted && mine[0].id !== noted)) {
        die(`${mine.length > 1
              ? `${mine.length} browse boxes are up, so 'down' will not guess which one is yours.`
              // One box up, and it is not the one this shell noted: someone else
              // made it. Guessing here is the same delete, one box further along.
              : `the box noted here (${noted}) is gone, and the one that IS up was not made by this shell.`}\n` +
            `     Name it: browse box down <box>   (or set BROWSE_REMOTE and re-run)\n` +
            mine.map((b) => `       ${b.id}  ${b.status || "?"}  ${b.name || ""}`).join("\n"));
      }
      id = noted || mine[0].id;
      why = " (the only browse box up)";
    }
    await api("DELETE", `/v2/box/${id}`);
    if (boxId((await readState()).box) === id) await writeState({ box: null });
    say(`${id} deleted${why}`);
    break;
  }
  case "image": {
    const snapshot = await buildImage(flag("size", "medium"));
    process.stdout.write(`${snapshot}\n`);
    break;
  }
  case "ls": {
    const list = await listBoxes();
    for (const b of list) {
      process.stdout.write(`${(b.id || "").padEnd(24)} ${(b.status || "?").padEnd(8)} ${b.name || ""}\n`);
    }
    if (!list.length) say("(no boxes)");
    const images = await listImages();
    if (!images.length) say("images: none yet — 'browse box up' will build one");
    for (const i of images) {
      process.stdout.write(`${i.id}  ${(i.status || "?").padEnd(8)} ${(i.size_bytes / 1e9).toFixed(1)}GB  ${i.name}\n`);
    }
    break;
  }
  case "exec": {
    const id = boxId(rest[0]) || die("exec needs a box");
    const command = rest.slice(1).join(" ");
    if (!command) die("exec needs a command");
    const run = await exec(id, command, 600000);
    // process.exitCode, NOT process.exit: exit() drops whatever is still in the
    // stdout pipe buffer, which on macOS is 64KB — an `npm i` whose error is in
    // the tail came back looking like it succeeded quietly.
    if (run.output) process.stdout.write(run.output.endsWith("\n") ? run.output : run.output + "\n");
    if (run.error) process.stderr.write(run.error.endsWith("\n") ? run.error : run.error + "\n");
    // A run with no status is a run we cannot vouch for; the probe in runScript
    // already treats a missing one as failure, and success is the wrong guess.
    process.exitCode = run.exit_code == null ? 1 : run.exit_code;
    break;
  }
  case "push": {
    // flag() splices out of `rest`, so it has to run BEFORE the positional read:
    // `push --to /x $BOX ./app` otherwise takes "--to" as the box id.
    const dest = flag("to", WORK);
    const id = boxId(rest[0]) || die("push needs a box");
    const paths = rest.slice(1);
    if (!paths.length) die("push needs at least one path");
    await push(id, paths, dest.replace(/\/$/, ""));
    break;
  }
  case "pull": {
    const id = boxId(rest[0]) || die("pull needs a box");
    const remote = rest[1] || die("pull needs a path on the box");
    await pull(id, remote.startsWith("/") ? remote : `${WORK}/${remote}`, rest[2]);
    break;
  }
  case "url": {
    const id = boxId(rest[0]) || die("url needs a box");
    const port = Number(rest[1]) || die("url needs a port");
    const pub = await api("POST", `/v2/box/${id}/preview`, { port });
    process.stdout.write(`${pub.url || JSON.stringify(pub)}\n`);
    break;
  }
  case "install": {
    const id = boxId(rest[0]) || die("install needs a box");
    await runScript(id, INSTALL, "install");
    say(`browse is on ${id} — drive it with: browse --remote ${sshHost(id)} open …`);
    break;
  }
  default:
    // Usage on the ERROR path goes to stderr, so `browse box $typo | …` does not
    // feed a help page into whatever was expecting output.
    (cmd && cmd !== "help" ? process.stderr : process.stdout).write(HELP);
    process.exitCode = cmd && cmd !== "help" ? 1 : 0;
}
} catch (e) {
  // die() throws rather than exiting so that `finally` blocks run — buildImage's
  // deletes the builder box. This is where that lands.
  if (!(e instanceof BoxError)) throw e;
  process.stderr.write(`browse box: ${e.message}\n`);
  process.exitCode = 1;
}
