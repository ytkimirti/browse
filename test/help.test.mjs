#!/usr/bin/env node
// Integration coverage for the help surface: the compact index, per-command
// help (`browse help <cmd>` and `browse <cmd> --help`), `help --all`, the
// unknown-topic error, and that every documented entry is reachable by name.
// Needs no browser and installs nothing.
//
//   node test/help.test.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, "bin", "browse");
const HOME = mkdtempSync(join(tmpdir(), "browse-help-"));

let failures = 0, checks = 0;
function check(name, ok, detail = "") {
  checks++;
  if (ok) { console.log(`  ok   ${name}`); return true; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n       ${String(detail).slice(0, 600).split("\n").join("\n       ")}` : ""}`);
  return false;
}
function browse(...args) {
  const r = spawnSync(BIN, args, { encoding: "utf8", env: { ...process.env, BROWSE_HOME: join(HOME, "home") }, timeout: 30000 });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

let r0;
try {
  console.log("index");
  const all = browse("help", "--all");
  check("help --all, exit 0", all.code === 0 && all.err === "", `${all.code} ${all.err}`);
  const index = browse("help");
  check("help, exit 0", index.code === 0 && index.err === "", `${index.code} ${index.err}`);
  check("the index is a small fraction of the full help", index.out.length < 5000 && all.out.length > 5 * index.out.length,
    `index ${index.out.length} bytes, all ${all.out.length}`);
  check("the index says how to get one command, everything and the env",
    /browse help <command\|topic>/.test(index.out) && /browse <command> --help/.test(index.out) &&
    /browse help --all/.test(index.out) && /browse help --env/.test(index.out), index.out);
  check("the index stays within 100 columns", index.out.split("\n").every((l) => [...l].length <= 100),
    index.out.split("\n").filter((l) => [...l].length > 100).join("\n"));
  check("the index lists usages, not descriptions",
    /wait <selector\|ms> \[--gone\]/.test(index.out) && !/hold until an element appears/.test(index.out), index.out);
  check("-h and --help print the index too", browse("-h").out === index.out && browse("--help").out === index.out);
  check("help --env still prints the env vars", /BROWSE_NET_SECRETS/.test(browse("help", "--env").out));

  console.log("\nper command");
  const wait = browse("help", "wait");
  check("help wait, exit 0", wait.code === 0 && wait.err === "", `${wait.code} ${wait.err}`);
  check("…prints wait with its section header and notes",
    /^Navigate \/ act/.test(wait.out) && /browse wait <selector\|ms>/.test(wait.out) && /takes --timeout <ms>/.test(wait.out), wait.out);
  check("…and no other command", !/browse (click|fill|net|snapshot) /.test(wait.out), wait.out);
  check("wait --help is the same text", browse("wait", "--help").out === wait.out);
  const vp = browse("help", "--viewport");
  check("help --viewport prints the launch flags, exit 0", vp.code === 0 && /--viewport/.test(vp.out) && vp.out === browse("help", "viewport").out, `${vp.code} ${vp.err}`);
  const prof = browse("help", "-p");
  check("help -p prints the profile section, exit 0", prof.code === 0 && /browse -p <name>/.test(prof.out), `${prof.code} ${prof.err}`);
  // Straight to browse.mjs: through bin/browse a non-help command would install deps first.
  r0 = spawnSync(process.execPath, [join(ROOT, "browse.mjs"), "net", "--all", "--help"],
    { encoding: "utf8", env: { ...process.env, BROWSE_HOME: join(HOME, "direct") } });
  r0 = { code: r0.status, out: r0.stdout, err: r0.stderr };
  check("--help later in the line is not help: net refuses it as a flag, exit 1",
    r0.code === 1 && r0.out === "" && /unknown flag '--help'/.test(r0.err), `${r0.code} ${r0.err} ${r0.out.slice(0, 100)}`);
  const net = browse("help", "net");
  check("help net prints the whole network section", /--since <#>/.test(net.out) && /Secret VALUES are hashed/.test(net.out), net.out);
  check("…including the --json record fields",
    /i \(the #\), t \(s into recording\), at, ms, method, url, type, reqHeaders,\s+reqBody, status, ok, resHeaders, mime, size, resBody, error, mock, mockVia/.test(net.out), net.out);
  check("net --help matches help net", browse("net", "--help").out === net.out);
  const task = browse("ai", "task", "--help");
  check("ai task --help prints the AI section", task.code === 0 && /--max-steps/.test(task.out) && task.out === browse("help", "ai", "task").out, task.out);
  check("a command whose rules live in a neighbouring entry gets them too",
    /default 20000/.test(browse("help", "reload").out) && /default 20000/.test(browse("help", "open").out));
  check("help help is the index", browse("help", "help").out === index.out);
  check("a flag-shaped topic works where the flag is not a launch flag", /^Run code BEFORE/.test(browse("help", "--stub").out));
  check("topics are case-insensitive", /browse reload \| goBack \| goForward/.test(browse("help", "goback").out));
  check("launch flags answer by name", /--viewport <WxH>/.test(browse("help", "viewport").out) && /^Launch flags/.test(browse("help", "viewport").out));
  check("a section answers by topic", /^Launch flags/.test(browse("help", "launch").out) && /^Artifacts/.test(browse("help", "artifacts").out));

  // Every entry `help --all` documents must be reachable by its own name.
  const unreachable = [];
  for (const line of all.out.split("\n")) {
    const m = /^  browse ([a-zA-Z]+)\b/.exec(line);
    if (!m) continue;
    const r = browse("help", m[1]);
    if (r.code !== 0 || !r.out.includes(line)) unreachable.push(`${m[1]}: ${line.trim()}`);
  }
  check("every documented command is reachable by name", unreachable.length === 0, unreachable.join("\n"));
  for (const row of index.out.split("\n")) {
    const m = /^([a-z]+) {2,}/.exec(row) || /^([a-z]{10,}) \S/.exec(row);
    if (!m) continue;
    const r = browse("help", m[1]);
    check(`index topic '${m[1]}' resolves`, r.code === 0 && r.out.length > 0, `${r.code} ${r.err}`);
  }

  console.log("\nunknown topics");
  let r = browse("help", "waitt");
  check("a typo fails, exit 1", r.code === 1 && r.out === "", `${r.code} ${r.out}`);
  check("…and suggests the command", /no command or topic 'waitt'\. Did you mean 'wait'\?/.test(r.err) && !/'ai'/.test(r.err), r.err);
  r = browse("help", "shot");
  check("an ambiguous fragment names both candidates", r.code === 1 && /'snapshot'/.test(r.err) && /'screenshot'/.test(r.err), r.err);
  r = browse("help", "zzzz");
  check("nothing close: no suggestion, still the index pointer",
    r.code === 1 && /no command or topic 'zzzz'\. Run 'browse help' for the index\./.test(r.err) && !/Did you mean/.test(r.err), r.err);
  r = browse("frobnicate", "--help");
  check("<unknown> --help fails the same way", r.code === 1 && /no command or topic 'frobnicate'/.test(r.err), `${r.code} ${r.err}`);

  check("no help lookup installed anything or started a browser", !existsSync(join(HOME, "home")), join(HOME, "home"));
} finally {
  rmSync(HOME, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} passed${failures ? ` - ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
