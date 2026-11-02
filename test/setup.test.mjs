#!/usr/bin/env node
// `browse setup` and the camoufox version browse needs (0.5.9+).
//
//   node test/setup.test.mjs
//
// Runs setup against a throwaway HOME and BROWSE_HOME whose camoufox pythons
// are stubs, and writes nothing outside them. Playwright and its Chromium are
// linked in from the real install, which must already be in place (run
// `browse setup` once): otherwise setup would download them into the temp dir.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const tmp = mkdtempSync(join(tmpdir(), "browse-setup-"));
let checks = 0, failures = 0;
const check = (name, ok, detail = "") => {
  checks++; if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n       ${String(detail).split("\n").join("\n       ")}`}`);
};
const stub = (path, code) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nexit ${code}\n`);
  chmodSync(path, 0o755);
};

// A HOME with camoufox installed the uv way, and a python3 on PATH that has no
// camoufox at all, so the uv python decides.
const home = join(tmp, "home"), bin = join(tmp, "bin"), browseHome = join(tmp, "browse-home");
// The real Playwright install, linked so setup finds it installed, and a
// camoufox-pw copy that reads as pinned and patched so setup installs nothing.
const realHome = process.env.BROWSE_HOME || join(homedir(), ".browse");
const pin = (name) => new RegExp(`^${name}="([^"]+)"`, "m").exec(readFileSync(join(ROOT, "bin/browse"), "utf8"))[1];
mkdirSync(join(browseHome, "camoufox-pw/node_modules/playwright-core"), { recursive: true });
symlinkSync(join(realHome, "node_modules"), join(browseHome, "node_modules"));
writeFileSync(join(browseHome, "camoufox-pw/node_modules/playwright-core/package.json"), JSON.stringify({ version: pin("CAMOU_PW_VERSION") }));
writeFileSync(join(browseHome, "camoufox-pw/.patched"), `${pin("CAMOU_PW_VERSION")} ${pin("CAMOU_PATCH_TAG")}\n`);
const uvPython = join(home, ".local/share/uv/tools/camoufox/bin/python");
stub(join(bin, "python3"), 1);
const setup = (env = {}) => spawnSync(join(ROOT, "bin/browse"), ["setup"], {
  encoding: "utf8", timeout: 120000,
  env: {
    ...process.env,
    HOME: home,
    BROWSE_HOME: browseHome,
    // Playwright's own default for the real HOME, which the fake one would move.
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || (process.platform === "darwin"
      ? join(homedir(), "Library/Caches/ms-playwright")
      : join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ms-playwright")),
    PATH: `${bin}:${process.env.PATH}`,
    BROWSE_CAMOUFOX_PYTHON: "",
    ...env,
  },
});

console.log("browse setup — camoufox version check");
try {
  // A camoufox that imports but has no camoufox.fingerprints.Screen: older than
  // 0.5.9 (it drew fingerprints with browserforge), so browse cannot start it.
  const old = (path) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `#!/bin/sh\ncase "$2" in *fingerprints*) exit 1;; esac\nexit 0\n`);
    chmodSync(path, 0o755);
  };
  old(uvPython);
  let r = setup();
  check("setup still finishes", r.status === 0, `exit ${r.status} ${r.stdout}${r.stderr}`);
  check("an old camoufox is called out by its python, with the upgrade and the fetch",
    r.stdout.includes(`camoufox in ${uvPython} is older than 0.5.9`) && /uv tool install -U camoufox/.test(r.stdout) &&
    r.stdout.includes(`${uvPython} -m camoufox fetch`) && /re-run 'browse setup'/.test(r.stdout), r.stdout);
  check("...and is not reported ready", !/camoufox stealth engine ready/.test(r.stdout), r.stdout);

  // BROWSE_CAMOUFOX_PYTHON is the first python browse launches through, so a
  // 0.5.9 one there is enough even with the old uv install still present.
  const good = join(tmp, "good-python");
  stub(good, 0);
  r = setup({ BROWSE_CAMOUFOX_PYTHON: good });
  check("a 0.5.9 python in BROWSE_CAMOUFOX_PYTHON is ready",
    r.status === 0 && !/older than 0\.5\.9/.test(r.stdout) && /camoufox stealth engine ready/.test(r.stdout), `exit ${r.status} ${r.stdout}${r.stderr}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${checks - failures}/${checks} passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exitCode = failures ? 1 : 0;
