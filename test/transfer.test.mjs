#!/usr/bin/env node
// Exercise the real remote client through a fake tunnel and localhost service.
// No remote account, credentials or browsers are required.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STORE = mkdtempSync(join(tmpdir(), 'browse-transfer-'));
const RUN = join(STORE, 'run');
const fixture = join(ROOT, 'test', 'transfer-fixture.mjs');
mkdirSync(RUN);
const quote = (s) => "'" + s.replace(/'/g, "'\"'\"'") + "'";
writeFileSync(join(STORE, 'ssh'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} ssh "$@"\n`, { mode: 0o700 });
const server = spawn(process.execPath, [fixture], { stdio: ['ignore', 'pipe', 'inherit'] });
const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('fixture startup timeout')), 10000);
  server.stdout.on('data', d => { const m = /PORT (\d+)/.exec(String(d)); if (m) { clearTimeout(timer); resolve(Number(m[1])); } });
});
const runFile = join(RUN, 'fixture~transfer.json');
const mirror = join(STORE, 'sessions', 'session-fixture');
writeFileSync(runFile, JSON.stringify({ port, remotePort: port }));
writeFileSync(join(RUN, 'fixture~transfer.ctl'), 'fixture');
const env = { ...process.env, PATH: STORE + ':' + process.env.PATH, BROWSE_HOME: STORE,
  BROWSE_SESSION: 'transfer', BROWSE_REMOTE: 'fixture', BROWSE_REMOTE_BIN: 'browse',
  BROWSE_SSH_PASSWORD: '', UPSTASH_BOX_API_KEY: '', BROWSE_REMOTE_SPAWN: '', BROWSE_PROFILE: '' };
const run = (...args) => {
  const r = spawnSync(process.execPath, [join(ROOT, 'browse.mjs'), ...args], { env, encoding: 'utf8', timeout: 20000 });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
};
let checks = 0, failures = 0;
const check = (name, ok, detail = '') => { checks++; if (!ok) failures++; console.log(`${ok ? 'ok' : 'FAIL'} ${name}${ok ? '' : '\n' + detail}`); };
const mode = async (v) => fetch(`http://127.0.0.1:${port}/__mode?value=${v}`);
const status = async () => (await fetch(`http://127.0.0.1:${port}/__status`)).json();
try {
  let r = run('net', '--json');
  check('live network mirror succeeds and returns actual evidence', r.code === 0 && /fixture.test\/api/.test(r.out), r.out + r.err);
  const good = readFileSync(join(mirror, 'network.jsonl'), 'utf8');
  for (const failure of ['missing', 'torn']) {
    await mode(failure);
    r = run('net');
    check(`${failure} transfer fails without false zero`, r.code === 1 && !/0 logged/.test(r.out), r.out + r.err);
    check(`${failure} transfer preserves last good copy and removes temporary file`, readFileSync(join(mirror, 'network.jsonl'), 'utf8') === good && !readdirSync(mirror).some(f => f.endsWith('.part')));
  }
  r = run('close');
  check('failed close reports recoverable artifact failure', r.code === 1 && /artifact download incomplete/.test(r.err) && /retry/.test(r.err), r.out + r.err);
  check('failed close retains remote endpoint and run file', (await status()).byes === 0 && existsSync(runFile));
  await mode('busy');
  r = run('sessions');
  check('unavailable health during close remains explicitly unconfirmed', r.code === 0 && /completion unconfirmed/.test(r.out) && existsSync(runFile), r.out + r.err);
  await mode('ok');
  r = run('close');
  check('retry close succeeds and downloads previous artifacts', r.code === 0 && existsSync(join(mirror, 'earlier.png')) && existsSync(join(mirror, 'console.jsonl')), r.out + r.err);
  check('successful close releases endpoint and run file', (await status()).byes === 1 && !existsSync(runFile));
  const at = Date.now();
  r = run('open', 'about:blank');
  check('missing noninteractive executable fails before long polling', r.code === 1 && Date.now() - at < 10000 && /BROWSE_REMOTE_BIN/.test(r.err) && /command not found/.test(r.err), r.err);
} finally { server.kill(); rmSync(STORE, { recursive: true, force: true }); }
console.log(`\n${checks - failures}/${checks} passed`);
process.exitCode = failures ? 1 : 0;
