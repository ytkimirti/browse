#!/usr/bin/env node
/**
 * box.mjs — put `browse` on an Upstash Box, so `browse --remote <box>` has
 * something to drive. Nothing here is part of browse itself: browse only needs
 * ssh and a `browse` on the far side, and this is one way to arrange that.
 *
 *   node scripts/box.mjs create [--size small|medium|large] [--name <name>]
 *   node scripts/box.mjs install <box-id>          # (re)install onto an existing box
 *   node scripts/box.mjs snapshot <box-id>         # freeze it, so the next box starts warm
 *
 * Needs UPSTASH_BOX_API_KEY — the same key `browse --remote` hands ssh as the
 * box's password, so once this ran there is nothing else to configure.
 *
 * Why the box's own exec API and not ssh: a box's ssh gateway attaches into the
 * container, relays no stdout back, and kills whatever the attach leaves behind
 * — so a long install run over ssh would be invisible and a backgrounded one
 * would die. The exec API does neither.
 *
 * Two box-specific decisions worth knowing:
 *   • everything lives under /workspace/home, the box user's half of the volume
 *     that survives a restart.
 *     ~/.cache is not it, and Playwright's browsers (~1GB) default to ~/.cache.
 *   • medium (4 vCPU / 8 GB / 10 GB) is the smallest size this fits in with room
 *     to work: ~1GB of browsers, plus a dev server, plus ffmpeg finalizing an
 *     mp4. small's 5GB disk is gone before you check anything out.
 */

// The box's persistent volume is mounted at /workspace, but only /workspace/home
// belongs to the box user — /workspace itself is root-owned, and writing there
// fails with a permission error that a detached install would swallow whole.
const WORK = "/workspace/home";
const BASE = process.env.UPSTASH_BOX_URL || "https://us-east-1.box.upstash.com";
const KEY = process.env.UPSTASH_BOX_API_KEY;
const REPO = process.env.BROWSE_REPO || "https://github.com/ytkimirti/browse";

if (!KEY) die("set UPSTASH_BOX_API_KEY (Upstash console → Box)");

function die(msg) { process.stderr.write(`box: ${msg}\n`); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "X-Box-Api-Key": KEY, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) die(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/** One shell command in the box. Returns { exit_code, output, error }. */
const exec = (id, command) => api("POST", `/v2/box/${id}/exec`, { command: ["sh", "-c", command] });

/** The install is minutes long and the exec API is not a place to hold a
 *  connection open for that, so it runs detached against a log and this polls
 *  the log — the same shape as watching a build, and it survives a dropped
 *  laptop. */
async function run(id, script, label) {
  const log = `${WORK}/browse-install.log`;
  // Probe first, synchronously: a detached run that cannot even create its log
  // (an unwritable dir, a box that is not up) would otherwise look exactly like
  // a slow install, and this would poll a file that is never going to exist.
  const probe = await exec(id, `rm -f ${log} && touch ${log} && echo ok`);
  if (probe.exit_code !== 0) die(`cannot write ${log} on ${id}: ${(probe.error || probe.output || "").trim().slice(0, 200)}`);
  // base64, not a quoted heredoc: the script goes across as one argument to
  // `sh -c`, and a multi-line one loses its newlines on the way (they arrive as
  // a literal \n and the whole thing collapses onto one line, where the first
  // `then` is a syntax error).
  const payload = Buffer.from(`${script}\necho __DONE__ $?\n`).toString("base64");
  await exec(id, `nohup setsid sh -c "echo ${payload} | base64 -d | sh" > ${log} 2>&1 </dev/null &`);
  let seen = 0;
  for (let i = 0; i < 240; i++) {
    await sleep(5000);
    const { output = "" } = await exec(id, `cat ${log} 2>/dev/null || true`);
    const fresh = output.slice(seen);
    seen = output.length;
    for (const line of fresh.split("\n").filter(Boolean)) {
      if (!line.startsWith("__DONE__")) process.stdout.write(`  ${line}\n`);
    }
    const done = /__DONE__ (\d+)/.exec(output);
    if (done) {
      if (done[1] !== "0") die(`${label} failed on the box — full log: ${log}`);
      return;
    }
  }
  die(`${label} did not finish in 20 minutes — check ${log} on the box`);
}

// Everything browse needs that a bare box does not have. `browse setup` pulls
// Playwright + Chromium itself (and, being root-capable here, Chromium's system
// libraries too); this only has to provide the things setup assumes: ffmpeg for
// the mp4 finalize, fonts so headless Chromium renders text instead of boxes,
// and browse itself on PATH.
const INSTALL = `set -e
sudo apt-get update -qq
echo "installing ffmpeg + fonts…"
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg fonts-liberation fonts-noto-color-emoji git
echo "fetching browse…"
if [ -d ${WORK}/browse/.git ]; then (cd ${WORK}/browse && git pull -q); else git clone -q --depth 1 ${REPO} ${WORK}/browse; fi
chmod +x ${WORK}/browse/bin/browse
# A wrapper, not a symlink: BROWSE_HOME and the browser cache must land on
# /workspace (the volume that survives a restart) rather than in ~/.cache, and a
# non-interactive ssh command reads no shell profile that could set them.
printf '#!/bin/sh\\nexport BROWSE_HOME=\${BROWSE_HOME:-${WORK}/.browse}\\nexport PLAYWRIGHT_BROWSERS_PATH=\${PLAYWRIGHT_BROWSERS_PATH:-${WORK}/.browse/ms-playwright}\\nexec ${WORK}/browse/bin/browse "$@"\\n' | sudo tee /usr/local/bin/browse > /dev/null
sudo chmod +x /usr/local/bin/browse
echo "installing playwright + chromium (~1GB, a few minutes)…"
browse setup`;

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? fallback : rest[i + 1];
};

if (cmd === "create") {
  const size = flag("size", "medium");
  const box = await api("POST", "/v2/box", {
    name: flag("name", "browse-box"), size, runtime: "node", keep_alive: true, labels: ["browse"],
  });
  process.stdout.write(`created ${box.id} (${size}, keep-alive)\n`);
  for (let i = 0; i < 60 && box.status === "creating"; i++) {
    await sleep(2000);
    Object.assign(box, await api("GET", `/v2/box/${box.id}`));
  }
  await run(box.id, INSTALL, "install");
  ready(box.id);
} else if (cmd === "install") {
  const id = rest[0] || die("install needs a box id: node scripts/box.mjs install <box-id>");
  await run(id, INSTALL, "install");
  ready(id);
} else if (cmd === "snapshot") {
  const id = rest[0] || die("snapshot needs a box id");
  const snap = await api("POST", `/v2/box/${id}/snapshot`, { name: `browse-${Date.now()}` });
  process.stdout.write(`snapshot ${snap.id || JSON.stringify(snap)}\n`);
} else {
  process.stdout.write(`usage:
  node scripts/box.mjs create [--size small|medium|large] [--name <name>]
  node scripts/box.mjs install <box-id>
  node scripts/box.mjs snapshot <box-id>
`);
  process.exit(cmd ? 1 : 0);
}

function ready(id) {
  const host = `${id}@${new URL(BASE).host}`;
  process.stdout.write(
    `\nready. Drive it with:\n` +
    `  browse --remote ${host} open https://example.com\n` +
    `  export BROWSE_REMOTE=${host}   # or, so every command goes there\n\n` +
    `Its dev server is what 'browse open' means by 127.0.0.1 — run the app on the box too,\n` +
    `or lend it this machine's with: ssh -R 3000:127.0.0.1:3000 ${host}\n`);
}
