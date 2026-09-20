#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = mkdtempSync(join(tmpdir(), 'browse-density-'));
const session = `density-${process.pid}`;
const env = { ...process.env, BROWSE_OUT: out, BROWSE_ENGINE: 'chromium', BROWSE_HEADFUL: '0' };
delete env.BROWSE_DEVICE_SCALE;
const run = (args, extra = {}) => spawnSync(join(root, 'bin/browse'), ['-s', session, ...args], {
  env: { ...env, ...extra }, encoding: 'utf8', timeout: 60000,
});
const ok = (args, extra) => {
  const r = run(args, extra);
  assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
};
const fails = (args, pattern, extra) => {
  const r = run(args, extra);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, pattern);
};
const dimensions = name => {
  const b = readFileSync(join(out, name));
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};
const page = join(out, 'fixture.html');
writeFileSync(page, '<style>html,body{margin:0}#card{margin:20px;width:100px;height:80px;background:cyan}#corner{position:fixed;right:0;bottom:0;width:24px;height:24px;background:red}</style><div id="card">Budget: $360</div><div id="corner"></div>');
try {
  for (const value of ['0', '-1', '4', 'NaN', '2px'])
    fails(['--device-scale', value, 'open', 'about:blank'], /device-scale wants/);
  fails(['open', 'about:blank'], /BROWSE_DEVICE_SCALE wants/, { BROWSE_DEVICE_SCALE: 'NaN' });
  fails(['--camoufox', '--device-scale', '2', 'open', 'about:blank'], /requires --chromium/);
  fails(['--cdp', 'http://localhost:1', '--no-video', '--device-scale', '2', 'open'], /borrows the existing browser settings/);
  assert.match(ok(['whoami']), /not running/);
  ok(['--chromium', '--device-scale', '2', '--viewport', '360x240', 'open', `file://${page}`]);
  assert.deepEqual(JSON.parse(ok(['eval', 'JSON.stringify([innerWidth,innerHeight,devicePixelRatio])'])), [360,240,2]);
  ok(['screenshot', 'page.png']); assert.deepEqual(dimensions('page.png'), [720,480]);
  ok(['screenshot', 'card.png', '--sel', '#card']); assert.deepEqual(dimensions('card.png'), [200,160]);
  ok(['screenshot', 'padded.png', '--sel', '#card', '--pad', '10']); assert.deepEqual(dimensions('padded.png'), [240,200]);
  ok(['screenshot', 'full.png', '--full']); assert.deepEqual(dimensions('full.png'), [720,480]);
  fails(['--device-scale', '1', 'screenshot', 'bad.png'], /already live/i);
  ok(['close', '--keep-raw']);
  const probe = spawnSync('ffprobe', ['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','json',join(out,'recording.mp4')], { encoding:'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout).streams.map(s=>[s.width,s.height]), [[360,240]]);
  const corner = spawnSync('ffmpeg', ['-v','error','-sseof','-0.1','-i',join(out,'recording.mp4'),'-vf','crop=8:8:348:228','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
  assert.equal(corner.status, 0, corner.stderr.toString());
  assert.ok(corner.stdout.length >= 3);
  assert.ok(corner.stdout[0] > 150 && corner.stdout[1] < 80 && corner.stdout[2] < 80, 'Bottom-right marker survives video downscaling');
  ok(['--no-video', '--viewport', '360x240', 'open', `file://${page}`]);
  assert.equal(ok(['eval', 'devicePixelRatio']), '1');
  ok(['close']);
  ok(['--no-video', '--viewport', '360x240', 'open', `file://${page}`], { BROWSE_DEVICE_SCALE:'1.5' });
  assert.equal(ok(['eval', 'devicePixelRatio']), '1.5');
  ok(['close']);
  ok(['--chromium', '--device-scale', '2', '-p', session, '--no-video', '--viewport', '360x240', 'open', `file://${page}`]);
  assert.equal(ok(['eval', 'devicePixelRatio']), '2');
  ok(['screenshot', 'persistent.png']); assert.deepEqual(dimensions('persistent.png'), [720,480]);
  ok(['close']);
  rmSync(join(process.env.BROWSE_HOME || join(homedir(), '.browse'), 'profiles', session), { recursive:true, force:true });
  console.log('Device scale: invalid settings rejected; page, element, padded, full screenshots and video dimensions pass; default and fractional densities pass.');
} finally {
  run(['close']);
  writeFileSync(join(out, 'feedback.md'), 'Integration capture: native device density and CSS-sized video verified; invalid density and unsupported engines refused.');
  console.log(`Artifacts: ${out}`);
}
