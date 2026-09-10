#!/usr/bin/env node
// Headed Camoufox must let its native window own the viewport. Forcing a
// Playwright viewport against Camoufox's spoofed geometry creates a 1280x800
// page surface in the top-left of a monitor-sized dark-grey window.
// This test intentionally opens a visible browser window for a few seconds.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, "browse.mjs");
const HOME = mkdtempSync(join(tmpdir(), "browse-headful-"));
symlinkSync(join(homedir(), ".browse", "camoufox-pw"), join(HOME, "camoufox-pw"));
const SESSION = `headful-${process.pid}`;
const run = (...args) => {
  const r = spawnSync(process.execPath, [BIN, "-s", SESSION, ...args], {
    encoding: "utf8", timeout: 180000,
    env: { ...process.env, BROWSE_HOME: HOME, BROWSE_PW_BASE: join(homedir(), ".browse", "package.json"), BROWSE_ENGINE: "camoufox", BROWSE_HEADFUL: "1", BROWSE_VIDEO: "0" },
  });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
};
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` - ${detail}`}`);
  if (!ok) failed++;
};
try {
  console.log("headful Camoufox native-window fit");
  let r = run("open", "data:text/html,<title>headful-fit</title><h1>fit</h1>");
  check("open succeeds, exit 0", r.code === 0, `${r.code} ${r.err}`);
  r = run("eval", "JSON.stringify({inner:[innerWidth,innerHeight],outer:[outerWidth,outerHeight]})");
  let g = null;
  try { g = JSON.parse(r.out); } catch { /* assertion below names output */ }
  check("headed window has browser chrome instead of a fake full-height viewport",
    r.code === 0 && g?.outer?.[0] === 1280 && g?.outer?.[1] === 800 &&
    g?.inner?.[0] === 1280 && g?.inner?.[1] < g?.outer?.[1], r.out || r.err);
  r = run("close");
  check("close succeeds, exit 0", r.code === 0, `${r.code} ${r.err}`);
} finally {
  run("close");
  rmSync(HOME, { recursive: true, force: true });
}
console.log(`\n${3 - failed}/3 passed`);
process.exit(failed ? 1 : 0);
