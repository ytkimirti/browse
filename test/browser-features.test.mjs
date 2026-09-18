#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
let out = mkdtempSync(join(tmpdir(), 'browse-features-'));
let session = `features-${process.pid}`;
const engine = process.env.BROWSE_ENGINE || 'chromium';
let failures = 0, checks = 0;
function check(name, ok, detail = '') { checks++; console.log(`${ok ? 'ok' : 'FAIL'} ${name}${!ok ? `: ${detail}` : ''}`); if (!ok) failures++; }
function browse(...args) {
  const r = spawnSync(join(root, 'bin/browse'), ['-s', session, ...args], { encoding: 'utf8', timeout: 180000,
    env: { ...process.env, BROWSE_ENGINE: engine, BROWSE_OUT: out, BROWSE_IDLE_MS: '120000', BROWSE_TYPE_DELAY: '0', BROWSE_IDLE_MODE: 'keep' } });
  return { code: r.status, text: `${r.stdout || ''}${r.stderr || ''}` };
}
const doc = (body) => `data:text/html,${encodeURIComponent(body)}`;
const red = doc('<title>Red</title><body style="background:rgb(255,0,0)"><h1>Outside</h1><section id="region"><h2>Region</h2><p>Long prose</p><button onclick="this.textContent=\'Clicked\'">Action</button><input aria-label="Email"></section><iframe id="frame" srcdoc="<button>Frame button</button>"></iframe>');
const blue = doc('<title>Blue</title><body style="background:rgb(0,0,255)"><h1>Second tab</h1>');
let r;
try {
  r = browse('open', red); check('open', r.code === 0, r.text);
  r = browse('snapshot', '#region'); check('scoped snapshot excludes outside heading', r.code === 0 && /Region/.test(r.text) && !/heading \"Outside\"/.test(r.text), r.text);
  r = browse('snapshot', '#region', '--compact', '--refs'); check('compact retains controls, drops prose', r.code === 0 && /Action/.test(r.text) && !/Long prose/.test(r.text), r.text);
  let ref = /button "Action"[^\n]*\[(@e\d+)\]/.exec(r.text)?.[1];
  check('button reference emitted', !!ref, r.text);
  if (ref) { r = browse('click', ref); check('reference clicks actual element', r.code === 0, r.text); r = browse('text', '#region'); check('click changed text', /Clicked/.test(r.text), r.text); }
  r = browse('snapshot', '--refs'); ref = /button "Clicked"[^\n]*\[(@e\d+)\]/.exec(r.text)?.[1];
  check('reference exists before removal', !!ref, r.text);
  browse('eval', "document.querySelector('button').outerHTML='<button>Replacement</button>'");
  if (ref) { r = browse('click', ref, '--timeout', '300'); check('removed reference fails instead of clicking replacement', r.code === 1, r.text); }
  r = browse('snapshot', '--refs'); ref = /button "Replacement"[^\n]*\[(@e\d+)\]/.exec(r.text)?.[1];
  check('reference exists before scope or navigation change', !!ref, r.text);
  browse('snapshot', '#region');
  if (ref) { r = browse('click', ref); check('new snapshot invalidates previous aliases', r.code === 1 && /stale/.test(r.text), r.text); }
  r = browse('snapshot', '#missing', '--timeout', '150'); check('missing scope exits one', r.code === 1 && /missing/.test(r.text), r.text);
  r = browse('snapshot', '--bogus'); check('unknown snapshot flag fails', r.code === 1 && /unknown flag/.test(r.text), r.text);
  r = browse('snapshot', '--timeout', '0'); check('invalid snapshot timeout fails', r.code === 1 && /positive/.test(r.text), r.text);
  r = browse('snapshot', '#region', 'extra'); check('snapshot stray argument fails', r.code === 1 && /unexpected/.test(r.text), r.text);
  browse('target', '#frame'); r = browse('snapshot', '--refs'); ref = /button "Frame button"[^\n]*\[(@e\d+)\]/.exec(r.text)?.[1];
  check('iframe snapshot references', !!ref, r.text);
  browse('target', 'top'); if (ref) { r = browse('click', ref); check('iframe reference fails in top scope', r.code === 1 && /scope/.test(r.text), r.text); }
  browse('eval', "document.querySelector('#frame').outerHTML='<iframe id=frame srcdoc=\"<button>Replacement frame</button>\"></iframe>'");
  browse('target', '#frame'); if (ref) { r = browse('click', ref); check('replaced iframe invalidates references', r.code === 1 && /stale/.test(r.text), r.text); }
  browse('target', 'top');
  r = browse('snapshot', '--refs'); ref = /button "Replacement"[^\n]*\[(@e\d+)\]/.exec(r.text)?.[1];
  check('reference exists before scope or navigation change', !!ref, r.text);
  r = browse('target', 'new', blue); check('deliberate secondary tab recorded', r.code === 0 && /recorded while active/.test(r.text), r.text);
  if (ref) { r = browse('click', ref); check('tab reference scope protected', r.code === 1 && /scope/.test(r.text), r.text); }
  browse('wait', '600');
  r = browse('target', 'record', 'off'); check('exclude active tab', r.code === 0 && /cut/.test(r.text), r.text);
  browse('wait', '200');
  r = browse('target', 'record', 'on'); check('include active tab', r.code === 0 && /included/.test(r.text), r.text);
  r = browse('target', 'record', 'maybe'); check('record invalid argument fails', r.code === 1 && /on or off/.test(r.text), r.text);
  browse('wait', '600');
  r = browse('target', 'close'); check('close secondary preserves session', r.code === 0 && /tab 0/.test(r.text), r.text);
  browse('wait', '600');
  r = browse('reload'); check('reload primary', r.code === 0, r.text);
  if (ref) { r = browse('click', ref); check('navigation invalidates references', r.code === 1 && /stale/.test(r.text), r.text); }
  r = browse('close', '--keep-raw'); check('multi-tab recording finalized', r.code === 0 && /mp4:/.test(r.text) && existsSync(join(out, 'recording.mp4')), r.text);
  check('raw composition retained', existsSync(join(out, 'video/composed.mp4')));
  const ff = spawnSync('ffmpeg', ['-v', 'error', '-i', join(out, 'recording.mp4'), '-vf', 'fps=4,scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { timeout: 30000 });
  if (!ff.error) {
    const pixels = ff.stdout || Buffer.alloc(0); let hasRed = false, hasBlue = false, backToRed = false;
    for (let i = 0; i < pixels.length; i += 3) { if (pixels[i] > 150 && pixels[i + 2] < 100) { hasRed = true; if (hasBlue) backToRed = true; } if (pixels[i + 2] > 150 && pixels[i] < 100) hasBlue = true; }
    check('final footage contains red then blue then red', ff.status === 0 && hasRed && hasBlue && backToRed, `${ff.status}: ${hasRed}/${hasBlue}/${backToRed}`);
  } else check('ffmpeg available for visual verification', false, ff.error.message);
  const firstOut = out;
  out = join(firstOut, 'excluded'); session += '-excluded';
  r = browse('target', 'record', 'off'); check('exclude before navigation', r.code === 0, r.text);
  browse('goto', blue); browse('wait', '600'); r = browse('close', '--keep-raw');
  check('first-command opt-out excludes startup and flushed tail on this engine', r.code === 0 && !existsSync(join(out, 'recording.mp4')) && /no shareable recording/.test(r.text), r.text);
  check('excluded raw is explicitly identified as containing excluded footage', /raw sources contain excluded footage/.test(r.text), r.text);
  out = firstOut;
} finally {
  browse('close');
  if (failures || process.env.BROWSE_TEST_KEEP) console.log(`artifacts: ${out}`); else rmSync(out, { recursive: true, force: true });
}
console.log(`${checks - failures}/${checks} checks passed (${engine})`);
process.exitCode = failures ? 1 : 0;
