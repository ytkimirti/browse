#!/usr/bin/env node
/**
 * box.mjs — what `browse-box` runs. Upstash Boxes for `browse --remote`: make one, put browse on it,
 * copy files in and out, run commands on it, and stop it when you are done.
 *
 *   browse-box help
 *
 * None of this is part of browse. browse only needs ssh and a `browse` on the
 * far side; this is one way to arrange that, and the cost control around it.
 *
 * Needs UPSTASH_BOX_API_KEY — the same key `browse --remote` hands the box's
 * ssh as its password, so once a box is up there is nothing else to configure.
 *
 * Everything goes through the box's HTTP API rather than ssh, on purpose: a
 * box's ssh gateway attaches into the container, relays back neither stdout nor
 * an exit status, and kills whatever a command leaves running. The API does
 * none of that.
 *
 * Two box facts the commands are built around:
 *   • Only /workspace/home belongs to the box user. It is also the half of the
 *     disk that survives a restart, so everything installed lands there.
 *   • A box with no keep-alive bills per ACTIVE CPU second and pauses itself
 *     when idle, so a session box costs roughly what it computes. `down` makes
 *     that immediate; storage keeps billing until `rm`.
 */

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { join, basename, resolve as resolvePath } from "node:path";

const BASE = process.env.UPSTASH_BOX_URL || "https://us-east-1.box.upstash.com";
const KEY = process.env.UPSTASH_BOX_API_KEY;
const REPO = process.env.BROWSE_REPO || "https://github.com/ytkimirti/browse";
// The box user's own, persistent half of the volume (see the header).
const WORK = "/workspace/home";
// Remembers the last snapshot taken, so `up` starts warm without being told an
// id. One file, next to browse's own data.
const STATE = join(process.env.BROWSE_HOME || join(homedir(), ".browse"), "box.json");

const die = (msg) => { process.stderr.write(`box: ${msg}\n`); process.exit(1); };
const say = (msg) => process.stderr.write(`${msg}\n`); // stdout stays machine-readable
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, timeout = 120000) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "X-Box-Api-Key": KEY, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  }).catch((e) => die(`${method} ${path}: ${e.message}`));
  const text = await res.text();
  if (!res.ok) die(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
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
async function writeState(patch) {
  const next = { ...(await readState()), ...patch };
  await mkdir(join(STATE, ".."), { recursive: true });
  await writeFile(STATE, JSON.stringify(next, null, 2) + "\n");
  return next;
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
  if (probe.exit_code !== 0) die(`cannot write ${log} on ${id}: ${(probe.error || probe.output || "").trim().slice(0, 200)}`);
  // base64, not a quoted script: a multi-line one loses its newlines on the way
  // across (they arrive as a literal \n, the whole thing collapses onto one
  // line, and the first `then` is a syntax error).
  const payload = Buffer.from(`${script}\necho __DONE__ $?\n`).toString("base64");
  await exec(id, `nohup setsid sh -c "echo ${payload} | base64 -d | sh" > ${log} 2>&1 </dev/null &`);
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
  const st = await stat(path);
  if (!st.isDirectory()) return [{ abs: resolvePath(path), rel: basename(path) }];
  const out = [];
  const walk = async (dir, prefix) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue; // never worth uploading
      const abs = join(dir, e.name), rel = `${prefix}/${e.name}`;
      if (e.isDirectory()) await walk(abs, rel);
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
      form.append("paths", `${dest}/${f.rel}`);
      form.append("files", new Blob([await readFile(f.abs)]), f.rel);
      n++;
    }
  }
  if (!n) die("nothing to push");
  const res = await fetch(`${BASE}/v2/box/${id}/files/upload`, {
    method: "POST", headers: { "X-Box-Api-Key": KEY }, body: form,
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
  const res = await fetch(url, { headers: { "X-Box-Api-Key": KEY }, signal: AbortSignal.timeout(600000) })
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

/* ── commands ─────────────────────────────────────────────────────────────── */

const HELP = `box.mjs — Upstash Boxes for 'browse --remote'

  up [--new] [--size medium] [--name <n>]
                              bring up THE session box and print its --remote host. Resumes the
                              one you used last (under a second, with its browsers and packages
                              intact); makes and provisions one the first time, or with --new.
                              No keep-alive, so it bills per active CPU second
  down [box]                  pause it — stops the CPU meter now, keeps the whole disk. Defaults
                              to the box 'up' last brought up
  rm <box>                    delete it, disk and all
  ls                          every box on the account, newest first

  exec <box> <cmd…>           run a command on the box and show its output. This is how you
                              install and start a dev server there — ssh into a box relays
                              nothing back
  push <box> <path…> [--to <dir>]   copy files or dirs in (default ${WORK}, skips .git/node_modules)
  pull <box> <remote> [local]       copy one file out
  url <box> <port>            public URL for a port on the box, to share a dev server
  install <box>               (re)install browse on a box you already have

<box> is a box id or the '<id>@…' host you pass to browse --remote, so $BROWSE_REMOTE works.

A session, end to end:
  export BROWSE_REMOTE=$(browse-box up)
  browse-box push $BROWSE_REMOTE ./my-app
  browse-box exec $BROWSE_REMOTE 'cd ${WORK}/my-app && npm i && (npm run dev &)'
  browse open http://127.0.0.1:3000     # 127.0.0.1 is the BOX's
  browse close                          # the mp4 lands here
  browse-box down                       # meter off

Costs: CPU only while it runs, plus ~$0.10/GB/month for the disk of a paused box
(a provisioned one is about 1GB). A box left running pauses itself when idle, so
forgetting 'down' is a small bill, not a standing one.
`;

/** Pull `--name value` out of the args, leaving the positionals behind. */
function flag(name, fallback) {
  const i = rest.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const [, value] = rest.splice(i, 2);
  return value ?? fallback;
}
function has(name) {
  const i = rest.indexOf(`--${name}`);
  if (i === -1) return false;
  rest.splice(i, 1);
  return true;
}

const args = process.argv.slice(2);
const cmd = args[0];
const rest = args.slice(1);
// The key is checked here rather than at load: `help` (and a typo, which prints
// help) must answer on a machine that has no key yet — that is the command you
// run to find out what to set.
const NEEDS_KEY = new Set(["up", "down", "rm", "ls", "exec", "push", "pull", "url", "install"]);
if (NEEDS_KEY.has(cmd) && !KEY) die("set UPSTASH_BOX_API_KEY (Upstash console → Box)");

switch (cmd) {
  case "up": {
    const size = flag("size", "medium");
    const name = flag("name", "browse-box");
    let id = has("new") ? null : boxId(flag("box", (await readState()).box));
    // A box that is merely PAUSED keeps its whole disk — the browse checkout,
    // the ~1GB of browsers, the apt packages — and resumes in under a second,
    // while costing only storage (cents a month) in the meantime. So a session
    // reuses one box rather than making one: creating is minutes, resuming is
    // instant, and neither bills CPU while nothing is running.
    if (id) {
      const box = await api("GET", `/v2/box/${id}`).catch(() => null);
      if (!box || !box.id) { say(`${id} is gone — making a new one`); id = null; }
      else if (box.status === "paused") { await api("POST", `/v2/box/${id}/resume`, undefined, 300000); say(`resumed ${id}`); }
      else say(`${id} is already up`);
    }
    if (!id) {
      // No keep-alive: a session box should bill for what it computes and pause
      // itself when it stops. keep-alive is a flat monthly charge instead, which
      // is the wrong shape for something you use in bursts.
      say(`creating ${size} box (one time — later sessions just resume it)…`);
      let box = await api("POST", "/v2/box", { name, size, runtime: "node", labels: ["browse"] }, 300000);
      for (let i = 0; i < 90 && box.status === "creating"; i++) {
        await sleep(2000);
        box = await api("GET", `/v2/box/${box.id}`);
      }
      if (box.status === "creating") die(`${box.id} is still creating — check the console`);
      id = box.id;
    }
    const ready = await exec(id, "command -v browse >/dev/null && browse version");
    if (ready.exit_code !== 0) await runScript(id, INSTALL, "install");
    await writeState({ box: id });
    say(`\n${id} is up. Stop the meter when you are done: browse-box down ${id}`);
    process.stdout.write(`${sshHost(id)}\n`);
    break;
  }
  case "down": {
    const id = boxId(rest[0]) || boxId((await readState()).box) || die("down needs a box");
    await api("POST", `/v2/box/${id}/pause`);
    say(`${id} paused — no more CPU charge. Its disk (and storage charge) stays until 'rm'.`);
    break;
  }
  case "rm": {
    const id = boxId(rest[0]) || die("rm needs a box");
    await api("DELETE", `/v2/box/${id}`);
    if (boxId((await readState()).box) === id) await writeState({ box: null });
    say(`${id} deleted`);
    break;
  }
  case "ls": {
    const boxes = await api("GET", "/v2/box");
    const list = Array.isArray(boxes) ? boxes : boxes.boxes || [];
    if (!list.length) { say("(no boxes)"); break; }
    for (const b of list) {
      process.stdout.write(`${(b.id || "").padEnd(24)} ${(b.status || "?").padEnd(8)} ${b.name || ""}\n`);
    }
    break;
  }
  case "exec": {
    const id = boxId(rest[0]) || die("exec needs a box");
    const command = rest.slice(1).join(" ");
    if (!command) die("exec needs a command");
    const run = await exec(id, command, 600000);
    if (run.output) process.stdout.write(run.output.endsWith("\n") ? run.output : run.output + "\n");
    if (run.error) process.stderr.write(run.error.endsWith("\n") ? run.error : run.error + "\n");
    process.exit(run.exit_code || 0);
    break;
  }
  case "push": {
    const id = boxId(rest[0]) || die("push needs a box");
    const dest = flag("to", WORK);
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
    process.stdout.write(HELP);
    process.exit(cmd && cmd !== "help" ? 1 : 0);
}
