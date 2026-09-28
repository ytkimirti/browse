#!/usr/bin/env node
// Packs and installs only this checkout. Never publishes or runs setup.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tmp = mkdtempSync(join(tmpdir(), 'browse-package-'));
let checks = 0, failures = 0;
function check(name, ok, detail='') { checks++; if (!ok) failures++; console.log(`${ok ? 'ok' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`); }
function run(cmd, args, env={}) { return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } }); }
try {
  const packed = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', tmp]);
  check('npm pack succeeds', packed.status === 0, packed.stderr);
  if (packed.status !== 0) throw new Error('packing failed');
  const pkg = JSON.parse(packed.stdout)[0]; const files = pkg.files.map((f) => f.path);
  for (const path of ['browse.mjs','bin/browse','scripts/box.mjs','SKILL.md','skill/recording.md','package.json','README.md']) check(`package includes ${path}`, files.includes(path));
  check('package excludes secrets, tests and worktrees', !files.some((path) => /(^|\/)\.env|\.claude|node_modules|^test\//.test(path)), files.join('\n'));
  const prefix = join(tmp, 'install');
  const installed = run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix, join(tmp, pkg.filename)]);
  check('fresh offline package install succeeds', installed.status === 0, installed.stderr);
  const bin = join(prefix, 'node_modules/.bin/browse');
  const env = { BROWSE_HOME: join(tmp, 'empty-home'), BROWSE_ENGINE: 'chromium' };
  let r = run(bin, ['help'], env); check('installed help works without dependencies', r.status === 0 && /--refs/.test(r.stdout) && /--cdp/.test(r.stdout), r.stderr);
  r = run(bin, ['version'], env); check('installed version resolves package manifest', r.status === 0 && /browse 0\.1\.0 \(build [0-9a-f]{8}\)/.test(r.stdout), r.stdout + r.stderr);
  r = run(bin, ['box', 'help'], env); check('packaged Box helper works', r.status === 0 && /browse box/.test(r.stdout), r.stderr);
  r = run(bin, ['wait', '--help'], env); check('installed <command> --help works without dependencies', r.status === 0 && /browse wait <selector\|ms>/.test(r.stdout), r.stderr);
  check('help/version do not install dependencies', !existsSync(join(env.BROWSE_HOME, 'node_modules')));
  r = run(bin, ['--cdp', 'not-an-endpoint', '--no-video', 'open'], env); check('packaged invalid endpoint fails without browser', r.status === 1 && /--cdp wants/.test(r.stderr) && !existsSync(join(env.BROWSE_HOME, 'node_modules')), r.stderr);
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log(`${checks - failures}/${checks} checks passed`); process.exitCode = failures ? 1 : 0;
