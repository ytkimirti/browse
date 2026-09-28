#!/usr/bin/env node
// A fake `ssh` for test/remote-spawn.test.mjs: the "remote" is this machine,
// under its own HOME, so the real --remote client, the real launcher and the
// real daemon all run with no sshd and no account.
//
//   ssh -M ... -L h:lp:h:rp host   start a TCP forward lp -> rp, pid in the -S file
//   ssh -O check|exit host         that forward's liveness / teardown
//   ssh [opts] host '<cmd>'        run <cmd> with sh, as a fresh remote login would:
//                                  HOME=$FAKE_REMOTE_HOME and no BROWSE_* from the caller
//
// `node ssh-fixture.mjs forward <lp> <rp>` is the forwarder process itself.
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const [mode, ...rest] = process.argv.slice(2);

if (mode === "forward") {
  const [lp, rp] = rest.map(Number);
  net.createServer((c) => {
    const up = net.connect(rp, "127.0.0.1");
    c.pipe(up).pipe(c);
    c.on("error", () => up.destroy());
    up.on("error", () => c.destroy());
  }).listen(lp, "127.0.0.1", () => process.stdout.write("ok\n"));
} else if (mode === "ssh") {
  const args = rest;
  const ctl = args.includes("-S") ? args[args.indexOf("-S") + 1] : null;
  const pidOf = () => { try { return Number(readFileSync(ctl, "utf8")); } catch { return 0; } };
  const alive = (pid) => { try { return pid > 0 && process.kill(pid, 0); } catch { return false; } };
  if (args.includes("-O")) {
    const op = args[args.indexOf("-O") + 1];
    if (op === "check") process.exit(ctl && existsSync(ctl) && alive(pidOf()) ? 0 : 255);
    if (alive(pidOf())) process.kill(pidOf());
    if (ctl) rmSync(ctl, { force: true });
    process.exit(0);
  }
  if (args.includes("-M")) {
    const [, lp, , rp] = args[args.indexOf("-L") + 1].split(":");
    const fwd = spawn(process.execPath, [SELF, "forward", lp, rp], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    fwd.stdout.once("data", () => {
      writeFileSync(ctl, String(fwd.pid));
      fwd.stdout.destroy();
      fwd.unref();
      process.exit(0);
    });
    fwd.on("exit", () => process.exit(255));
  } else {
    const env = { PATH: process.env.FAKE_REMOTE_PATH, HOME: process.env.FAKE_REMOTE_HOME,
      PLAYWRIGHT_BROWSERS_PATH: process.env.FAKE_REMOTE_BROWSERS };
    const r = spawnSync("sh", ["-c", args.at(-1)], { env, cwd: process.env.FAKE_REMOTE_HOME, stdio: "inherit" });
    process.exit(r.status ?? 255);
  }
}
