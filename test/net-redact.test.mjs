#!/usr/bin/env node
// Integration coverage for network.jsonl redaction: secret-named headers (not
// just a fixed list), query params, JSON/form/HTML body fields and credential
// shapes (JWT, bearer) are hashed by default; harmless neighbours survive; and
// BROWSE_NET_SECRETS=1 still keeps everything verbatim.
//
//   node test/net-redact.test.mjs                       # chromium
//   BROWSE_ENGINE=camoufox node test/net-redact.test.mjs
//
// Drives the REAL binary against test/secrets-fixture.mjs and reads the log the
// browser actually wrote.

import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, "bin", "browse");
const ENGINE = process.env.BROWSE_ENGINE || "chromium";
const SESSION = `redact-${process.pid}`;
const OUT = mkdtempSync(join(tmpdir(), "browse-redact-"));
const OUT_RAW = mkdtempSync(join(tmpdir(), "browse-redact-raw-"));
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJKV1RTRUNSRVQifQ.c2lnbmF0dXJlU0VDUkVU";

let failures = 0, checks = 0;
function check(name, ok, detail = "") {
  checks++;
  if (ok) { console.log(`  ok   ${name}`); return true; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n       ${String(detail).split("\n").join("\n       ")}` : ""}`);
  return false;
}

function run(session, out, extraEnv, ...args) {
  const r = spawnSync(BIN, ["-s", session, ...args], {
    encoding: "utf8",
    env: { ...process.env, BROWSE_ENGINE: ENGINE, BROWSE_OUT: out, BROWSE_HEADFUL: "0", BROWSE_IDLE_MS: "120000", ...extraEnv },
    timeout: 180000,
  });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
const browse = (...args) => run(SESSION, OUT, {}, ...args);
/** Entries land as each request FINISHES, after the page already moved on. */
function logged(out, n) {
  const file = join(out, "network.jsonl");
  for (let i = 0; i < 100; i++) {
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { /* not yet */ }
    if (text.split("\n").filter(Boolean).length >= n) return text;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return readFileSync(file, "utf8");
}
const raw = (...args) => run(`${SESSION}-raw`, OUT_RAW, { BROWSE_NET_SECRETS: "1" }, ...args);

let fixture = null, cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  try { browse("close"); } catch { /* best effort */ }
  try { raw("close"); } catch { /* best effort */ }
  try { fixture?.kill(); } catch { /* already gone */ }
  for (const d of [OUT, OUT_RAW]) try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(1); });

const PORT = await new Promise((resolve, reject) => {
  fixture = spawn(process.execPath, [join(ROOT, "test", "secrets-fixture.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
  fixture.stdout.setEncoding("utf8");
  fixture.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(d); if (m) resolve(Number(m[1])); });
  fixture.on("exit", (c) => reject(new Error(`fixture exited (${c})`)));
  setTimeout(() => reject(new Error("fixture never printed PORT")), 15000);
});
const BASE = `http://127.0.0.1:${PORT}`;

console.log(`\nbrowse net redaction (engine ${ENGINE}, port ${PORT})\n`);

try {
  console.log("default: secrets hashed");
  let r = browse("--no-video", "open", `${BASE}/`);
  check("open, exit 0", r.code === 0, `${r.code} ${r.err}`);
  r = browse("wait", "#done");
  check("the page finished its requests", r.code === 0, `${r.code} ${r.err}`);

  const log = logged(OUT, 5);
  const leaks = log.match(/[QHBFR]SECRET-[\w-]+/g) || [];
  check("no secret marker reaches network.jsonl", leaks.length === 0, [...new Set(leaks)].join(", "));
  check("no JWT reaches network.jsonl", !log.includes(JWT), "JWT found verbatim");
  const keeps = ["KEEP-matrix", "KEEP-carol", "KEEP-php", "KEEP-go", "KEEP-step", "KEEP-lib", "KEEP-page", "KEEP-reqid", "KEEP-alice", "KEEP-bearer", "KEEP-bob", "KEEP-trace", "KEEP-next", "KEEP-q"];
  const lost = keeps.filter((k) => !log.includes(k));
  check("harmless values survive", lost.length === 0, `lost: ${lost.join(", ")}`);
  check("a harmless number named like a secret survives", log.includes('\\"maxTokens\\":500'), "maxTokens missing");

  r = browse("net", "api/login", "--json");
  check("net --json, exit 0", r.code === 0, `${r.code} ${r.err}`);
  const e = JSON.parse(r.out.split("\n")[0] || "{}");
  check("x-vercel-protection-bypass is hashed", /^<sha256:[0-9a-f]{12} len:14>$/.test(e.reqHeaders?.["x-vercel-protection-bypass"] || ""),
    e.reqHeaders?.["x-vercel-protection-bypass"]);
  check("a *session* header is hashed", /^<sha256:/.test(e.reqHeaders?.["x-app-session-id"] || ""), e.reqHeaders?.["x-app-session-id"]);
  check("authorization keeps its scheme", /^Bearer <sha256:/.test(e.reqHeaders?.authorization || ""), e.reqHeaders?.authorization);
  check("query secrets keep their name, lose their value",
    /access_token=<sha256:[0-9a-f]{12} len:\d+>&page=KEEP-page&key=<sha256:/.test(e.url || ""), e.url);
  check("set-cookie keeps its attributes", /^sid=<sha256:[0-9a-f]{12} len:14>; Path=\/; HttpOnly$/.test(e.resHeaders?.["set-cookie"] || ""),
    e.resHeaders?.["set-cookie"]);
  check("a bare path keeps its harmless params, loses its secret ones",
    /^\/api\/login\?page=KEEP-path&access_token=<sha256:[0-9a-f]{12} len:12>$/.test(e.resHeaders?.["content-location"] || ""),
    e.resHeaders?.["content-location"]);
  check("a *signature* response header is hashed", /^<sha256:/.test(e.resHeaders?.["x-upstream-signature"] || ""), e.resHeaders?.["x-upstream-signature"]);
  check("a JWT inside a harmless header is hashed in place", /^id <sha256:[0-9a-f]{12} len:\d+>$/.test(e.resHeaders?.["x-forwarded-token-note"] || ""),
    e.resHeaders?.["x-forwarded-token-note"]);
  const reqBody = JSON.parse(e.reqBody || "{}");
  check("JSON request body fields are hashed, the JSON still parses",
    ["password", "clientSecret", "apiKey"].every((k) => /^<sha256:/.test(reqBody[k])) && /^<sha256:/.test(reqBody.nested?.refresh_token),
    e.reqBody);
  check("…and a field ABOUT the token is kept", reqBody.nested?.token_type === "KEEP-bearer", e.reqBody);
  const resBody = JSON.parse(e.resBody || "{}");
  check("JSON response token and JWT are hashed", /^<sha256:/.test(resBody.token) && /^<sha256:/.test(resBody.note), e.resBody);
  check("a url inside a body loses only its secret param", /page=KEEP-next&access_token=<sha256:/.test(resBody.next || ""), resBody.next);

  r = browse("net", "api/profile", "--json");
  const p = JSON.parse(r.out.split("\n")[0] || "{}");
  let profile = null;
  try { profile = JSON.parse(p.resBody); } catch { /* checked below */ }
  check("compact JSON holding an '=' still parses, harmless url intact",
    profile?.session?.user === "KEEP-carol" && profile?.session?.avatar === "https://cdn.test/a.png?s=64", p.resBody);
  check("a decimal next to a secret-looking name stays valid JSON", profile?.pin === 12.5, p.resBody);
  check("a PHP-escaped url loses its token", /^https:\/\/x\.test\/cb\?a=KEEP-php&token=<sha256:/.test(profile?.php || ""), profile?.php);
  check("a Go-escaped url loses its token", /^https:\/\/x\.test\/cb\?a=KEEP-go&token=<sha256:/.test(profile?.go || ""), profile?.go);

  r = browse("net", "lib.js", "--json");
  const lib = JSON.parse(r.out.split("\n")[0] || "{}");
  check("a script that starts with a slash is logged unchanged",
    lib.resBody === "/*! lib v1 */\n!function(){var a={};a.sessionId=1;if(a&&a.token==2)a.password=3;window.__lib='KEEP-lib'}();", lib.resBody);

  r = browse("net", "api/form", "--full");
  check("net --full, exit 0", r.code === 0, `${r.code} ${r.err}`);
  check("form body password is hashed, other fields kept", /user=KEEP-bob&password=<sha256:[0-9a-f]{12} len:10>&remember=1/.test(r.out), r.out);
  check("a secret name after a harmless id is still hashed", /name="api_key" value="<sha256:/.test(r.out), r.out);
  check("a relative link loses its token, keeps its other params", /href="\/reset-password\?token=<sha256:[0-9a-f]{12} len:12>&amp;step=KEEP-step"/.test(r.out), r.out);
  check("an HTML csrf meta tag is hashed, other inputs kept", /name="csrf-token" content="<sha256:/.test(r.out) && r.out.includes('value="KEEP-q"'), r.out);

  r = browse("net", "--grep", "HSECRET");
  check("grepping for a secret finds nothing, exit 0", r.code === 0 && !/HSECRET/.test(r.out) && /no matching|0 /i.test(r.out), `${r.code} ${r.out}`);
  r = browse("net", "--grep");
  check("net --grep with no value still fails, exit 1", r.code === 1 && /needs a value/.test(r.err), `${r.code} ${r.err}`);

  console.log("\nBROWSE_NET_SECRETS=1: verbatim");
  r = raw("--no-video", "open", `${BASE}/`);
  check("open with secrets kept, exit 0", r.code === 0, `${r.code} ${r.err}`);
  r = raw("wait", "#done");
  check("the page finished its requests", r.code === 0, `${r.code} ${r.err}`);
  const rawLog = logged(OUT_RAW, 5);
  const want = ["HSECRET-bypass", "HSECRET-bearer-0123456789", "QSECRET-query", "BSECRET-pw", "FSECRET-pw", "RSECRET-token", "RSECRET-cookie", "RSECRET-csrf", "RSECRET-php", "RSECRET-go", "RSECRET-href", "RSECRET-input", "RSECRET-mixed", "RSECRET-matrix", "RSECRET-minio", JWT];
  const missing = want.filter((k) => !rawLog.includes(k));
  check("every secret is kept verbatim", missing.length === 0, `missing: ${missing.join(", ")}`);
  check("…and nothing is hashed", !rawLog.includes("<sha256:"), "found a hash");
} finally {
  cleanup();
}

console.log(`\n${checks - failures}/${checks} passed${failures ? ` - ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
