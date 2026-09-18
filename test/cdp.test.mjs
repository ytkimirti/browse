#!/usr/bin/env node
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(process.env.BROWSE_PW_BASE || join(process.env.BROWSE_HOME || join(homedir(), '.browse'), 'package.json'));
const { chromium } = require('playwright');
const tmp = mkdtempSync(join(tmpdir(), 'browse-cdp-'));
const server = net.createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise((r) => server.close(r));
const context = await chromium.launchPersistentContext(join(tmp, 'owner'), { headless: true, viewport: { width: 777, height: 555 }, args: [`--remote-debugging-port=${port}`, '--no-sandbox'] });
const page = context.pages()[0];
await page.goto('data:text/html,<title>Owner</title><button onclick="this.textContent=\'Driven\'">Drive</button>');
const other = await context.newPage(); await other.goto('data:text/html,<title>Other</title>');
let failures = 0, checks = 0;
const session = `cdp-${process.pid}`;
const driverHome = join(tmp, 'driver-home'), mockBin = join(tmp, 'mock-bin');
mkdirSync(driverHome); mkdirSync(mockBin);
symlinkSync(dirname(dirname(require.resolve('playwright/package.json'))), join(driverHome, 'node_modules'), 'dir');
writeFileSync(join(driverHome, 'package.json'), '{"private":true}');
for (const installer of ['bun', 'npm', 'pnpx', 'npx']) {
  const path = join(mockBin, installer);
  writeFileSync(path, '#!/bin/sh\nprintf "unexpected browser bootstrap\\n" >&2\nexit 99\n'); chmodSync(path, 0o755);
}
function check(name, ok, detail='') { checks++; if (!ok) failures++; console.log(`${ok ? 'ok' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`); }
function browse(args, suffix='') {
  const env = { ...process.env, BROWSE_HOME: driverHome, PLAYWRIGHT_BROWSERS_PATH: join(tmp, 'no-browser-cache'), PATH: `${mockBin}:${process.env.PATH}`, BROWSE_OUT: join(tmp, 'artifacts'), BROWSE_IDLE_MS: '120000' };
  for (const key of ['BROWSE_ENGINE','BROWSE_HEADFUL','BROWSE_VIEWPORT','BROWSE_VIDEO','BROWSE_CDP','BROWSE_PROFILE','BROWSE_CURSOR','BROWSE_KEYLOG','BROWSE_POPUPS']) delete env[key];
  const r = spawnSync(join(root, 'bin/browse'), ['-s', session + suffix, ...args], { encoding: 'utf8', timeout: 90000, env });
  return { code: r.status, text: `${r.stdout || ''}${r.stderr || ''}` };
}
const endpoint = `http://127.0.0.1:${port}`;
try {
  let r = browse(['--cdp', endpoint, 'open'], '-guard'); check('CDP refuses implicit recording', r.code === 1 && /requires explicit --no-video/.test(r.text), r.text);
  r = browse(['--cdp', endpoint, '--no-video', '--camoufox', 'open'], '-engine'); check('CDP rejects Camoufox', r.code === 1 && /requires Chromium/.test(r.text), r.text);
  r = browse(['--cdp', endpoint, '--no-video', '-p', 'test-cdp', 'open'], '-profile'); check('CDP rejects local profile', r.code === 1 && /persistent profile/.test(r.text), r.text);
  r = browse(['--cdp', endpoint, '--no-video', 'open']); check('attach preserves current page', r.code === 0 && /(?:Owner|Other)/.test(r.text) && /attached/.test(r.text), r.text);
  r = browse(['eval', '`${innerWidth}x${innerHeight}`']); check('attachment preserves viewport', r.code === 0 && /777x555/.test(r.text), r.text);
  r = browse(['target']); check('existing tabs listed', r.code === 0 && /Other/.test(r.text) && /Owner/.test(r.text), r.text);
  const ownerIndex = /^.*?(\d+)  Owner/m.exec(r.text)?.[1]; if (ownerIndex) browse(['target', ownerIndex]);
  r = browse(['click', 'button']); check('drive borrowed page', r.code === 0, r.text);
  r = browse(['text', 'button']); check('borrowed action happened', r.code === 0 && /Driven/.test(r.text), r.text);
  for (const cmd of ['init','middleware','emulate']) { r = browse([cmd]); check(`${cmd} refuses persistent borrowed mutation`, r.code === 1 && /borrowed/.test(r.text), r.text); }
  r = browse(['state', '--load', 'nonexistent.json']); check('state load refused', r.code === 1 && /borrowed/.test(r.text), r.text);
  r = browse(['target', 'record', 'on']); check('recording selection refused without video', r.code === 1 && /video is off/.test(r.text), r.text);
  r = browse(['screenshot', 'borrowed']); check('borrowed screenshot works', r.code === 0 && existsSync(join(tmp, 'artifacts', 'borrowed.png')), r.text);
  r = browse(['--cdp', `${endpoint}?token=never-print-me`, '--no-video', 'url']); check('live launch error hides endpoint credentials', r.code === 1 && !/never-print-me/.test(r.text), r.text);
  r = browse(['open', '--cdp', `${endpoint}?token=never-print-me`]); check('misplaced endpoint hides credentials', r.code === 1 && !/never-print-me/.test(r.text), r.text);
  r = browse(['close']); check('close disconnects', r.code === 0 && /video was off/.test(r.text), r.text);
  check('CDP lifecycle never installed a local browser', !existsSync(join(tmp, 'no-browser-cache')));
  check('owner pages retained', !page.isClosed() && !other.isClosed());
  check('owner browser usable after disconnect', await page.evaluate('document.title') === 'Owner');
  await page.reload(); check('no browse scripts survive', await page.evaluate('!document.querySelector("[id*=browse]")'));
  r = browse(['--cdp', 'http://127.0.0.1:1?token=never-print-me', '--no-video', 'open'], '-bad'); check('connection failure hides credentials', r.code === 1 && !/never-print-me/.test(r.text) && /CDP connection failed/.test(r.text), r.text);
  const logs = join(tmp, 'artifacts', 'browsed.log'); check('daemon logs hide endpoint credentials', !existsSync(logs) || !readFileSync(logs, 'utf8').includes('never-print-me'));
} finally {
  browse(['close']); await context.close();
  if (failures) console.log(`artifacts: ${tmp}`); else rmSync(tmp, { recursive: true, force: true });
}
console.log(`${checks - failures}/${checks} checks passed`); process.exitCode = failures ? 1 : 0;
