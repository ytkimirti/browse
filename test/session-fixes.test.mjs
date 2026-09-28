#!/usr/bin/env node
// Session-history regressions. Isolated profiles and artifacts, installed browser
// dependencies only. No application credentials or external services are used.
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STORE = mkdtempSync(join(tmpdir(), 'browse-session-fixes-'));
const OUT = join(STORE, 'out');
const SESSION = `history-${process.pid}`;
const ENGINE = process.env.BROWSE_ENGINE || 'chromium';
symlinkSync(join(homedir(), '.browse', 'camoufox-pw'), join(STORE, 'camoufox-pw'));
const ENV = { ...process.env, BROWSE_HOME: STORE, BROWSE_OUT: OUT, BROWSE_SESSION: SESSION,
  BROWSE_PW_BASE: join(homedir(), '.browse', 'package.json'), BROWSE_ENGINE: ENGINE,
  BROWSE_REMOTE: '', BROWSE_PROFILE: '', BROWSE_VIDEO: '0', BROWSE_HEADFUL: '0',
  BROWSE_CURSOR: '0', BROWSE_KEYLOG: '0', BROWSE_IDLE_MS: '180000' };
let failures = 0, checks = 0;
const check = (name, ok, detail = '') => {
  checks++; if (!ok) failures++;
  console.log(`${ok ? 'ok' : 'FAIL'} ${name}${ok ? '' : '\n' + String(detail).slice(0, 1500)}`);
};
const run = (args, env = {}) => {
  const r = spawnSync(process.execPath, [join(ROOT, 'browse.mjs'), ...args], {
    env: { ...ENV, ...env }, encoding: 'utf8', timeout: 90000,
  });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const b = (...args) => run(args);
const parsed = (r) => { try { return JSON.parse(r.out); } catch { return null; } };
let port;
const fixture = spawn(process.execPath, [join(ROOT, 'test', 'fixture-server.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
const fixturePort = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('fixture startup timed out')), 10000);
  fixture.stdout.on('data', (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) { clearTimeout(timer); resolve(Number(m[1])); } });
});
try {
  let r = b('console');
  check('console with no live session fails without starting a browser', r.code === 1 && /--dir/.test(r.err) && !existsSync(OUT), r.err);
  const html = `<style>body{margin:0}#surface{position:absolute;left:30px;top:40px;width:200px;height:100px;background:blue}#cover{position:absolute;left:30px;top:40px;width:200px;height:100px;background:red;z-index:10}</style><div id="surface" role="button"></div><div id="cover"></div><script>document.querySelector('#surface').onpointermove=e=>e.currentTarget.dataset.hover=JSON.stringify([e.offsetX,e.offsetY]);document.querySelector('#surface').onclick=e=>e.currentTarget.dataset.point=JSON.stringify([e.offsetX,e.offsetY]);document.querySelector('#surface').oncontextmenu=e=>{e.preventDefault();e.currentTarget.dataset.right=JSON.stringify([e.offsetX,e.offsetY])}</script>`;
  r = b('open', 'data:text/html,' + encodeURIComponent(html));
  check('fixture opens on requested engine', r.code === 0, r.err);
  port = JSON.parse(readFileSync(join(STORE, 'run', SESSION + '.json'))).port;
  r = b('rect', '#surface');
  const g = parsed(r);
  check('rect reports actual geometry and covering element', r.code === 0 && g?.box.x === 30 && g.box.width === 200 && g.center.covered && g.center.hit === 'div#cover', r.out + r.err);
  r = b('rect', '#missing');
  check('missing geometry fails', r.code === 1 && /no element/.test(r.err), r.err);
  r = b('rect', '#surface', '--bogus');
  check('rect rejects extra arguments', r.code === 1, r.err);
  r = b('screenshot', 'covered', '--sel', '#surface');
  check('element screenshot calls out overlap', r.code === 0 && /covered by div#cover/.test(r.err), r.out + r.err);
  r = b('screenshot', 'uncovered', '--sel', '#surface', '--hide', '#cover');
  check('screenshot hiding is disclosed', r.code === 0 && /hidden for this screenshot: #cover/.test(r.err), r.out + r.err);
  // Read the saved image through the browser's PNG decoder. It must contain the
  // blue target pixels, and the real page must still have its red overlay.
  const png = readFileSync(join(OUT, 'uncovered.png')).toString('base64');
  r = b('eval', `(async()=>{const i=new Image();i.src='data:image/png;base64,${png}';await i.decode();const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const x=c.getContext('2d');x.drawImage(i,0,0);return {pixel:[...x.getImageData(50,50,1,1).data],cover:getComputedStyle(document.querySelector('#cover')).visibility}})()`);
  const image = parsed(r);
  check('saved pixels hide overlay and page styling is restored', r.code === 0 && image?.pixel.join(',') === '0,0,255,255' && image.cover === 'visible', r.out + r.err);
  r = b('screenshot', 'bad-hide', '--hide', 'text=cover');
  check('non-CSS hide selector fails without artifact', r.code === 1 && !existsSync(join(OUT, 'bad-hide.png')), r.err);
  b('eval', `document.querySelector('#cover').remove(); 'ready'`);
  r = b('click', '#surface', '--position', '25,30');
  check('relative click succeeds at requested point', r.code === 0 && parsed(b('eval', `JSON.parse(document.querySelector('#surface').dataset.point || 'null')`))?.join(',') === '25,30', r.out + r.err + ' point=' + b('eval', `JSON.parse(document.querySelector('#surface').dataset.point || 'null')`).out);
  r = b('hover', '#surface', '--position', '70,60');
  check('relative hover lands at requested point', r.code === 0 && parsed(b('eval', `JSON.parse(document.querySelector('#surface').dataset.hover || 'null')`))?.join(',') === '70,60', r.out + r.err + ' point=' + b('eval', `JSON.parse(document.querySelector('#surface').dataset.hover || 'null')`).out);
  r = b('rightclick', '#surface', '--position', '10,20', '--timeout', '1000');
  check('relative rightclick works with timeout', r.code === 0 && parsed(b('eval', `JSON.parse(document.querySelector('#surface').dataset.right || 'null')`))?.join(',') === '10,20', r.out + r.err + ' point=' + b('eval', `JSON.parse(document.querySelector('#surface').dataset.right || 'null')`).out);
  for (const pos of ['200,2', '-1,2', '1', 'Infinity,2']) {
    r = b('click', '#surface', '--position', pos, '--timeout', '300');
    check(`invalid position ${pos} fails`, r.code === 1 && /position/.test(r.err), r.err);
  }
  b('eval', `document.body.insertAdjacentHTML('beforeend','<svg width="160" height="80" style="position:absolute;top:160px"><rect id="bucket" width="160" height="80" fill="green"/></svg>');document.querySelector('#bucket').addEventListener('click',e=>e.target.dataset.hit='yes');'ready'`);
  r = b('click', '#bucket', '--position', '20,20', '--timeout', '2000');
  check('relative positioning supports SVG chart elements', r.code === 0 && b('eval', `document.querySelector('#bucket').dataset.hit`).out === 'yes', r.out + r.err);
  b('eval', `setTimeout(()=>{const e=document.createElement('div');e.id='toast-test';e.textContent='Upload complete';document.body.append(e)},1800); 'scheduled'`);
  r = b('screenshot', 'toast', '--after', '#toast-test', '--text', 'complete', '--timeout', '5000');
  check('one command waits then saves capture', r.code === 0 && existsSync(join(OUT, 'toast.png')), r.out + r.err);
  for (const args of [ ['--after', '#absent', '--timeout', '100'], ['--after', '#toast-test', '--text', 'wrong', '--timeout', '100'], ['--text', 'complete'], ['--after'], ['--timeout', '0'], ['extra', 'stray'] ]) {
    r = b('screenshot', 'no-shot', ...args);
    check(`invalid or unmet capture condition fails: ${args.join(' ')}`, r.code === 1 && !existsSync(join(OUT, 'no-shot.png')), r.out + r.err);
  }
  b('eval', `for(let i=0;i<220;i++)console.error('same HMR error');console.log({nested:{evidence:'stored'}});'logged'`);
  r = b('errors', '--grep', 'same HMR');
  check('duplicate errors collapse with count', r.code === 0 && /repeats/.test(r.out) && r.out.length < 600, r.out);
  const latest = parsed(b('console', '--json', '--last', '1'))?.[0]?.i;
  b('eval', `console.error('late error after ring capacity');'logged'`);
  r = b('errors', '--since', String(latest));
  check('fresh errors survive capacity and use console baseline', r.code === 0 && /late error/.test(r.out) && !/same HMR/.test(r.out), r.out + r.err);
  r = b('errors', '--since', 'bad');
  check('invalid error baseline fails', r.code === 1, r.err);
  b('eval', `console.log('L'.repeat(6000)); 'logged'`);
  r = b('console', '--json', '--last', '1');
  check('JSON retrieves a complete long console record', r.code === 0 && parsed(r)?.[0]?.text.length === 6000, r.out.slice(0, 200) + r.err);
  // Repeated main-frame navigations without a live service or an unbounded loop.
  b('goto', `http://127.0.0.1:${fixturePort}/auth-cycle`);
  b('wait', '#cycle-done', '--timeout', '10000');
  r = b('console', '--grep', 'Repeated main-frame navigation');
  check('navigation loop diagnostic is persisted', r.code === 0 && /at least 8 navigations/.test(r.out), r.out + r.err);
  const post = async () => (await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify({ cmd: 'close', args: [], hold: true }) })).json();
  const first = await post();
  const second = await post();
  check('held close is repeatable and preserves finalization result', first.ok && second.ok && first.result === second.result, JSON.stringify(second));
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  check('health reports finalized while artifacts are held', health.phase === 'finalized', JSON.stringify(health));
  const manifest = await (await fetch(`http://127.0.0.1:${port}/manifest`)).json();
  check('artifact manifest includes console and earlier screenshots', manifest.files.includes('console.jsonl') && manifest.files.includes('toast.png'), JSON.stringify(manifest));
  await fetch(`http://127.0.0.1:${port}/bye`, { method: 'POST' });
  port = null;
  r = b('console', '--dir', OUT, '--json', '--all');
  const entries = parsed(r);
  check('console archive after close includes resolved objects without duplicate revisions', r.code === 0 && entries.some(e => e.text.includes('"evidence":"stored"')) && entries.length === new Set(entries.map(e=>e.i)).size, r.err);
  r = b('errors', '--dir', OUT, '--since', String(latest));
  check('archived errors preserve filters', r.code === 0 && /late error/.test(r.out) && !/same HMR/.test(r.out), r.out + r.err);
  r = b('console', '--dir', join(STORE, 'missing'));
  check('missing archive fails instead of reporting zero', r.code === 1 && /cannot read console archive/.test(r.err), r.err);
  r = b('console', '--dir');
  check('archive directory argument is required', r.code === 1 && /needs a session directory/.test(r.err), r.err);
  const fakePython = join(STORE, 'fake-python');
  writeFileSync(fakePython, '#!/bin/sh\nprintf \'%s\\n\' \'{"executable_path":"/usr/bin/false"}\'\n', { mode: 0o700 });
  const at = Date.now();
  r = run(['-s', 'bad-engine', '-p', 'isolated', '--camoufox', 'open', 'about:blank'], { BROWSE_CAMOUFOX_PYTHON: fakePython, BROWSE_OUT: join(STORE, 'failed-launch') });
  check('explicit engine failure is prompt and never creates Chromium profile', r.code === 1 && Date.now() - at < 20000 && !existsSync(join(STORE, 'profiles', 'isolated')), r.out + r.err);
} finally {
  if (port) await fetch(`http://127.0.0.1:${port}/bye`, { method: 'POST' }).catch(()=>{});
  else b('close');
  fixture.kill();
  rmSync(STORE, { recursive: true, force: true });
}
console.log(`\n${checks - failures}/${checks} passed (${ENGINE})`);
process.exitCode = failures ? 1 : 0;
