#!/usr/bin/env node
// Integration coverage for `browse box`, against a FAKE Box API — the whole
// point of these cases is what the CLI does when several boxes are up at once,
// and provisioning several real ones to find out is slow, billable, and would
// leave boxes behind on a failure.
//
//   node test/box.test.mjs
//
// The bug this suite exists for: `~/.browse/box.json` is ONE file shared by every
// process on the machine, so a second agent's `up` overwrote the note the first
// one left, and the first agent's argument-less `down` then deleted the SECOND
// agent's box — mid-recording, reporting the id it had deleted as its own. There
// is no recovering from that: the video is on the box.
//
// Asserts stdout, stderr AND exit status, and — since the failure being fixed is
// a delete that should never have happened — the cases also assert which boxes
// the API was actually asked to delete.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, openSync, ftruncateSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BOX = join(ROOT, "scripts", "box.mjs");
const HOME = mkdtempSync(join(tmpdir(), "browse-box-"));

let failures = 0, checks = 0;
function check(name, ok, detail = "") {
  checks++;
  if (ok) { console.log(`  ok   ${name}`); return true; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n       ${String(detail).split("\n").join("\n       ")}` : ""}`);
  return false;
}

/* ── the fake account ─────────────────────────────────────────────────────── */

// Its own process (see test/box-api.mjs), because spawnSync blocks THIS one
// while the CLI runs. Between commands nothing is blocking, so the account is
// set up and read back over http.
const api = spawn(process.execPath, [join(ROOT, "test", "box-api.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
const BASE = await new Promise((resolve, reject) => {
  let buf = "";
  const t = setTimeout(() => reject(new Error("fake box api never came up")), 10000);
  api.stdout.on("data", (c) => {
    buf += c;
    const m = /PORT (\d+)/.exec(buf);
    if (m) { clearTimeout(t); resolve(`http://127.0.0.1:${m[1]}`); }
  });
});
/** What the API was asked for, since when: { boxes, created, deleted }. */
const log = async () => (await fetch(`${BASE}/__log`)).json();
const deletedIds = async () => (await log()).deleted.join(",");

/* ── the CLI under test ───────────────────────────────────────────────────── */

mkdirSync(HOME, { recursive: true });
const STATE = join(HOME, "box.json");
const readState = () => JSON.parse(readFileSync(STATE, "utf8"));

function box(args, env = {}) {
  const r = spawnSync(process.execPath, [BOX, ...args], {
    encoding: "utf8",
    // UPSTASH_BOX_API_KEY empty on purpose: the key must come from the state
    // file, which is where `browse box key` puts it and what `down` also reads.
    env: { ...process.env, BROWSE_HOME: HOME, UPSTASH_BOX_URL: BASE, UPSTASH_BOX_API_KEY: "", ...env },
    timeout: 60000,
  });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
/** Fresh account AND fresh local note before each case: a case inheriting the
 *  previous one's state file is the very confusion under test. */
async function reset(state = {}, boxes = []) {
  await fetch(`${BASE}/__reset`, { method: "POST", body: JSON.stringify({ boxes }) });
  writeFileSync(STATE, JSON.stringify({ apiKey: "box_faketestkey", snapshot: "snap-1", ...state }));
}

console.log(`browse box — fake API at ${BASE}\n`);
try {
  /* ------------------------------------------------------------------- up */
  console.log("up");
  await reset();
  const up1 = box(["up"]);
  check("up exits 0", up1.code === 0, `exit ${up1.code} · ${up1.err}`);
  check("...and prints ONLY the ssh host on stdout", /^fakebox-1@127\.0\.0\.1:\d+$/.test(up1.out), up1.out);
  check("...and reports the free disk", /9\.0GB disk free/.test(up1.err), up1.err);
  check("...and names the box in the teardown line", /browse box down fakebox-1/.test(up1.err), up1.err);
  check("...and noted it locally", readState().box === "fakebox-1", JSON.stringify(readState()));
  let made = (await log()).created;
  check("...and asked for a medium box (small's 5GB does not fit an app)", made[0].size === "medium",
    JSON.stringify(made[0]));

  const up2 = box(["up"]);
  check("a SECOND up while the first is alive still works", up2.code === 0, `exit ${up2.code} · ${up2.err}`);
  made = (await log()).created;
  check("...because the two names differ", made[0].name !== made[1].name, `${made[0].name} vs ${made[1].name}`);
  check("...and both are labelled browse", made.every((c) => c.labels.includes("browse")), JSON.stringify(made));

  await reset();
  const named = box(["up", "--name", "my-own-box"]);
  const small = box(["up", "--size", "small", "--name", "b2"]);
  made = (await log()).created;
  check("--name is honoured", named.code === 0 && made[0].name === "my-own-box", JSON.stringify(made[0]));
  check("--size is honoured", small.code === 0 && made[1].size === "small", JSON.stringify(made[1]));

  const dup = box(["up", "--name", "my-own-box"]);
  check("a name that IS taken fails loudly, not silently", dup.code === 1 && /already in use/.test(dup.err),
    `exit ${dup.code} · ${dup.err}`);

  /* ----------------------------------------------------------------- down */
  console.log("\ndown, when it is obvious");
  await reset();
  box(["up"]);
  const d1 = box(["down"]);
  check("the only browse box goes down with no argument", d1.code === 0, `exit ${d1.code} · ${d1.err}`);
  check("...and says why it picked that one", /the only browse box up/.test(d1.err), d1.err);
  check("...and deleted exactly it", (await deletedIds()) === "fakebox-1", await deletedIds());
  check("...and cleared the local note", readState().box === null, JSON.stringify(readState()));

  await reset();
  box(["up"]); box(["up"]);
  const d2 = box(["down", "fakebox-1"]);
  check("an explicit box is deleted even with two up",
    d2.code === 0 && (await deletedIds()) === "fakebox-1",
    `exit ${d2.code} · deleted ${await deletedIds()} · ${d2.err}`);

  /* ------------------------------------------------------ the actual bug */
  console.log("\ndown does not delete another agent's box");
  await reset();
  const mine = box(["up"]);                       // this agent's box
  box(["up"]);                                    // another agent's, which overwrote box.json
  check("box.json now names the OTHER box", readState().box === "fakebox-2", JSON.stringify(readState()));
  const d3 = box(["down"], { BROWSE_REMOTE: mine.out });
  check("down follows $BROWSE_REMOTE, not the shared note",
    d3.code === 0 && (await deletedIds()) === "fakebox-1",
    `exit ${d3.code} · deleted ${await deletedIds()} · ${d3.err}`);
  check("...and says where it got it", /from \$BROWSE_REMOTE/.test(d3.err), d3.err);

  await reset();
  box(["up"]); box(["up"]);
  const d4 = box(["down"]);
  check("with two up and no BROWSE_REMOTE it REFUSES", d4.code === 1, `exit ${d4.code} · ${d4.err}`);
  check("...and deleted nothing at all", (await deletedIds()) === "", await deletedIds());
  check("...and lists both, with how to name one",
    /fakebox-1/.test(d4.err) && /fakebox-2/.test(d4.err) && /browse box down <box>/.test(d4.err), d4.err);

  // A stale note is the same hazard by another route: the box it names is gone,
  // someone else's is up, and "the box I noted" must not become "that one".
  await reset({ box: "fakebox-9" }, [{ id: "fakebox-1", status: "running", name: "browse-someone-else", labels: ["browse"] }]);
  const d5 = box(["down"]);
  check("a stale note never falls through to someone else's box",
    d5.code === 1 && (await deletedIds()) === "",
    `exit ${d5.code} · deleted ${await deletedIds()} · ${d5.err}`);
  check("...and says which half is wrong", /fakebox-9\) is gone/.test(d5.err) && /not made by this shell/.test(d5.err),
    d5.err);

  // The note is cleared by the `down` that used it, so a second bare `down` has
  // nothing local saying which box is this session's. Adopting whatever single
  // box is up would be the original bug arriving one box later.
  await reset();
  box(["up"]);
  box(["down"]);                                   // clears the note
  await fetch(`${BASE}/__reset`, { method: "POST", body: JSON.stringify({ boxes: [{ id: "fakebox-7", status: "running", name: "browse-someone-else", labels: ["browse"] }] }) });
  const d5b = box(["down"]);
  check("a second bare down does not adopt whatever is up",
    d5b.code === 1 && (await deletedIds()) === "", `exit ${d5b.code} · deleted ${await deletedIds()} · ${d5b.err}`);
  check("...and says nothing here names a box", /nothing here says which box is yours/.test(d5b.err), d5b.err);

  // A box the account still lists after it ended must not count as a rival:
  // otherwise the first expired box jams the argument-less `down` for good.
  await reset({ box: "fakebox-1" }, [
    { id: "fakebox-1", status: "running", name: "browse-mine", labels: ["browse"] },
    { id: "fakebox-0", status: "expired", name: "browse-old", labels: ["browse"] },
  ]);
  const d5c = box(["down"]);
  check("a box in a terminal state is not a rival",
    d5c.code === 0 && (await deletedIds()) === "fakebox-1",
    `exit ${d5c.code} · deleted ${await deletedIds()} · ${d5c.err}`);

  /* ------------------------------------------------- nothing to delete */
  console.log("\ndown when there is nothing to delete");
  await reset({ box: "fakebox-9" });
  const d6 = box(["down"]);
  check("an expired box is not an error at teardown", d6.code === 0, `exit ${d6.code} · ${d6.err}`);
  check("...and it says so", /already gone/.test(d6.err), d6.err);
  check("...and deleted nothing", (await deletedIds()) === "", await deletedIds());
  check("...and cleared the note", readState().box === null, JSON.stringify(readState()));

  await reset();
  const d7 = box(["down"]);
  check("no box at all is not an error either", d7.code === 0 && /no browse box is up/.test(d7.err),
    `exit ${d7.code} · ${d7.err}`);

  // The TTL is a backstop, so a session that outlived it ends with a DELETE for a
  // box that is already gone. That is teardown arriving at what it wanted.
  await reset({ box: "fakebox-1" }, [{ id: "fakebox-1", status: "running", name: "browse-mine", labels: ["browse"] }]);
  const d7b = box(["down", "fakebox-404"]);
  check("deleting a box that expired is not a failure", d7b.code === 0, `exit ${d7b.code} · ${d7b.err}`);
  check("...and says it was already gone", /was already gone/.test(d7b.err), d7b.err);
  const d7c = box(["down"], { BROWSE_REMOTE: `fakebox-404@127.0.0.1:${new URL(BASE).port}` });
  check("...same through $BROWSE_REMOTE, which is the documented ending",
    d7c.code === 0 && /was already gone/.test(d7c.err), `exit ${d7c.code} · ${d7c.err}`);

  /* ---------------------------------------------------- other people's boxes */
  console.log("\nboxes that are not ours");
  await reset({}, [{ id: "someones-box", status: "running", name: "yusuf-mybox", labels: [] }]);
  const d8 = box(["down"]);
  check("an unlabelled box is never a candidate",
    d8.code === 0 && (await deletedIds()) === "",
    `exit ${d8.code} · deleted ${await deletedIds()} · ${d8.err}`);
  const d9 = box(["down"], { BROWSE_REMOTE: "nerd" });
  check("a BROWSE_REMOTE that is not a box host is ignored",
    d9.code === 0 && (await deletedIds()) === "",
    `exit ${d9.code} · deleted ${await deletedIds()} · ${d9.err}`);

  /* ------------------------------------------------------------------ push */
  // An image is as old as the day it was taken, and a box restored from one runs
  // that code while the CLIENT here parses today's flags, which is how a session
  // spent an afternoon re-reporting bugs that were already fixed. `up` refreshes
  // the checkout and says so when the two builds still differ.
  console.log("\nup keeps the box's browse current");
  await reset();
  const fresh = box(["up"]);
  const execLog = (await log()).execs.join("\n");
  check("up pulls the box's browse up to date before reporting a version",
    /git -C \/workspace\/home\/browse fetch/.test(execLog) && /reset -q --hard FETCH_HEAD/.test(execLog), execLog);
  check("...and says so when the build still differs from this checkout",
    /build deadbeef, this checkout is \w{8}/.test(fresh.err), fresh.err);

  console.log("\npush");
  await reset();
  box(["up"]);
  const SRC = mkdtempSync(join(tmpdir(), "browse-push-"));
  mkdirSync(join(SRC, "src"), { recursive: true });
  mkdirSync(join(SRC, ".next", "cache"), { recursive: true });
  writeFileSync(join(SRC, "src", "app.ts"), "export const a = 1\n");
  writeFileSync(join(SRC, ".next", "cache", "junk.bin"), "x".repeat(1024));
  const dir = box(["push", "fakebox-1", SRC]);
  check("a directory push works", dir.code === 0 && /pushed 1 file/.test(dir.err), `exit ${dir.code} · ${dir.err}`);
  const sent = (await log()).uploads[0];
  check("...carrying the source", sent.paths.some((p) => p.endsWith("/src/app.ts")), JSON.stringify(sent.paths));
  check("...and NOT the build output that made one push a 400", !sent.paths.some((p) => p.includes(".next")),
    JSON.stringify(sent.paths));

  // 101MB, sparse: nothing is written and nothing is read, because the refusal
  // has to happen off the file SIZE, before the tree is pulled into memory.
  const BIG = join(SRC, "huge.bin");
  const fd = openSync(BIG, "w");
  ftruncateSync(fd, 101 * 1024 * 1024);
  closeSync(fd);
  await reset();
  box(["up"]);
  const tooBig = box(["push", "fakebox-1", BIG]);
  check("a file over the API's cap is refused here, exit 1", tooBig.code === 1 && /caps one file at 100.0MB/.test(tooBig.err),
    `exit ${tooBig.code} · ${tooBig.err}`);
  check("...with the tar-and-unpack recipe, not just the limit",
    /tar --exclude=node_modules.*\n.*browse box push fakebox-1 \/tmp\/push.tgz/.test(tooBig.err), tooBig.err);
  check("...and nothing was uploaded at all", (await log()).uploads.length === 0,
    JSON.stringify((await log()).uploads));
  rmSync(SRC, { recursive: true, force: true });

  /* ---------------------------------------------------------------- errors */
  console.log("\nerrors");
  await reset();
  const noKeyHome = mkdtempSync(join(tmpdir(), "browse-nokey-"));
  const noKey = box(["up"], { BROWSE_HOME: noKeyHome });
  check("no API key fails, and says where to get one", noKey.code === 1 && /browse box key/.test(noKey.err),
    `exit ${noKey.code} · ${noKey.err}`);
  rmSync(noKeyHome, { recursive: true, force: true });
  const badTtl = box(["up", "--ttl", "8h"]);
  check("a non-numeric --ttl fails", badTtl.code === 1 && /whole seconds/.test(badTtl.err),
    `exit ${badTtl.code} · ${badTtl.err}`);
  const typo = box(["dwon"]);
  check("a typo prints help on stderr, exit 1", typo.code === 1 && /browse box —/.test(typo.err),
    `exit ${typo.code} · ${typo.err.split("\n")[0]}`);
  const help = box(["help"]);
  check("help prints on stdout, exit 0", help.code === 0 && /browse box —/.test(help.out), `exit ${help.code}`);
} finally {
  api.kill();
  rmSync(HOME, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
