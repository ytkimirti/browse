#!/usr/bin/env node
// Output shape and session-start regressions from real agent sessions:
// notices on stderr (stdout is only the result), matching launch flags on a
// live session, a refused first command leaving no session, screenshot paths,
// fast read failures, suggestions, frame scopes, and 1x captures.
//
//   node test/output.test.mjs                       # chromium
//   BROWSE_ENGINE=camoufox node test/output.test.mjs
//
// Isolated BROWSE_HOME (the installed deps are symlinked in), its own page
// server, unique session names. Every check reads stdout, stderr and the exit.
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENGINE = process.env.BROWSE_ENGINE || 'chromium';
const HOME = mkdtempSync(join(tmpdir(), 'browse-output-'));
for (const f of ['node_modules', 'package.json', 'camoufox-pw']) symlinkSync(join(homedir(), '.browse', f), join(HOME, f));
const CWD = join(HOME, 'cwd');
mkdirSync(CWD);
const BASE_ENV = { ...process.env, BROWSE_HOME: HOME, BROWSE_ENGINE: ENGINE, BROWSE_HEADFUL: '0',
  BROWSE_IDLE_MS: '180000', BROWSE_TYPE_DELAY: '0', BROWSE_REMOTE: '', BROWSE_PROFILE: '' };
delete BASE_ENV.BROWSE_OUT; delete BASE_ENV.BROWSE_DEVICE_SCALE; delete BASE_ENV.BROWSE_SESSION;

let failures = 0, checks = 0;
const check = (name, ok, detail = '') => {
  checks++; if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : `\n       ${String(detail).slice(0, 1500).split('\n').join('\n       ')}`}`);
};
const sessions = [];
const run = (session, args, env = {}) => {
  if (!sessions.includes(session)) sessions.push(session);
  const started = Date.now();
  const r = spawnSync(join(ROOT, 'bin', 'browse'), ['-s', session, ...args], {
    cwd: CWD, env: { ...BASE_ENV, ...env }, encoding: 'utf8', timeout: 180000,
  });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), ms: Date.now() - started };
};
const show = (r) => `exit ${r.code}\nstdout: ${r.out}\nstderr: ${r.err}`;
const png = (file) => { const b = readFileSync(file); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
const sessionDirs = (session) => { try { return readdirSync(join(HOME, 'sessions')).filter((d) => d.endsWith(`-${session}`)); } catch { return []; } };

const PAGES = {
  '/tall': '<title>Tall</title><h1>Tall</h1><div style="height:4000px">long</div><button id=boom onclick="setTimeout(()=>{throw new Error(\'kaboom\')})">Boom</button>',
  '/plain': '<title>Plain</title><p>No landmarks here.</p><div id=app><p>app</p></div>',
  '/navs': '<title>Navs</title><nav><a href="#a">A</a></nav><main><p>body</p></main><nav><a href="#b">B</a></nav>',
  '/frames': '<title>Frames</title><h1>top</h1><iframe id=outer src="/outer" width=400 height=160></iframe>'
    + '<iframe id=sib title="sibling" src="/sib" width=200 height=80></iframe><iframe title="other" src="/sib" width=200 height=80></iframe>'
    + '<button id=pop onclick="const w=window.open(\'/sib\',\'_blank\');setTimeout(()=>w.close(),800)">pop</button>'
    + '<button id=rm onclick="document.getElementById(\'sib\').remove()">rm</button>',
  '/outer': '<h2>outer</h2><iframe id=inner src="/inner" width=300 height=80></iframe>',
  '/inner': '<button id=b onclick="this.textContent=\'hit\'">Inner</button>',
  '/sib': '<button id=s onclick="this.textContent=\'sibhit\'">Sib</button>',
};
// Its own process: every browse call below is a spawnSync, which would block an
// in-process server for exactly the moments the browser needs it.
const server = spawn(process.execPath, ['-e', `
  const pages = JSON.parse(process.env.PAGES);
  const s = require('node:http').createServer((req, res) => {
    const body = pages[req.url.split('?')[0]];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' }).end(body ? '<!doctype html><meta charset=utf-8>' + body : 'nope');
  });
  s.listen(0, '127.0.0.1', () => console.log('PORT ' + s.address().port));
`], { env: { ...process.env, PAGES: JSON.stringify(PAGES) }, stdio: ['ignore', 'pipe', 'inherit'] });
const port = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('page server never came up')), 10000);
  server.stdout.on('data', (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) { clearTimeout(t); resolve(m[1]); } });
});
const BASE = `http://127.0.0.1:${port}`;

console.log(`browse output - engine ${ENGINE}`);
try {
  /* ---------------------------------------------- I: refused first command */
  console.log('\na refused first command leaves no session');
  const s1 = `out-first-${process.pid}`;
  let r = run(s1, ['open', `${BASE}/tall`, '--no-record']);
  check('a stray flag after the command fails with a launch-flag suggestion',
    r.code === 1 && /unknown flag '--no-record'/.test(r.err) && /did you mean --no-video\? It is a launch flag/.test(r.err), show(r));
  check('...and says the browser it started is gone', /no session was left running/.test(r.err) && !/started session/.test(r.err), show(r));
  r = run(s1, ['whoami']);
  check('...so the session is not running', r.code === 0 && /not running/.test(r.out), show(r));
  check('...and its artifacts dir was removed', sessionDirs(s1).length === 0, sessionDirs(s1).join(', '));
  r = run(s1, ['screenshot']);
  check('a screenshot on the fresh blank tab says it is about:blank', r.code === 0 && /^saved /.test(r.out) && /about:blank - nothing has been opened/.test(r.err), show(r));
  r = run(s1, ['text']);
  check('...and so does text', r.code === 0 && r.out === '' && /about:blank/.test(r.err), show(r));
  run(s1, ['close']);
  // A reused BROWSE_OUT: a discarded start must not take an earlier run's files.
  const reused = join(HOME, 'reused');
  mkdirSync(reused);
  writeFileSync(join(reused, 'transcript.md'), 'earlier run');
  r = run(`${s1}-b`, ['text', 'main'], { BROWSE_OUT: reused });
  check('a discarded start in a reused BROWSE_OUT keeps the earlier files',
    r.code === 1 && /no session was left running/.test(r.err) && readFileSync(join(reused, 'transcript.md'), 'utf8').startsWith('earlier run')
      && !existsSync(join(reused, 'shots')), `${show(r)}\n${readdirSync(reused).join(',')}`);

  /* --------------------------------------------- D, K2, H: output + steps */
  console.log('\nstdout is only the result');
  const s2 = `out-main-${process.pid}`;
  r = run(s2, ['--viewport', '640x400', 'open', `${BASE}/tall`]);
  check('open succeeds with the result as the only stdout line', r.code === 0 && /^opened Tall/.test(r.out) && !r.out.includes('\n'), show(r));
  check('...the start line names engine and profile on stderr', new RegExp(`started session '${s2}': ${ENGINE}, no profile`).test(r.err), show(r));
  check('...and the step shot is on stderr', /\[shots\/step-01-open/.test(r.err), show(r));
  r = run(s2, ['eval', 'location.href']);
  check('eval prints only its value on stdout', r.code === 0 && r.out === `${BASE}/tall`, show(r));
  r = run(s2, ['screenshot', '--full']);
  check('screenshot --full: stdout is the saved path, the tip is on stderr',
    r.code === 0 && /^saved \S+\.png$/.test(r.out) && /tip: run 'browse scroll bottom'/.test(r.err), show(r));
  r = run(s2, ['screenshot', '--full']);
  check('...and the tip is not repeated', r.code === 0 && /^saved /.test(r.out) && !/tip:/.test(r.err), show(r));
  r = run(s2, ['click', '#boom']);
  const r2 = run(s2, ['url']);
  const errs = r.err + r2.err;
  check('new page errors go to stderr, stdout keeps the result',
    r.code === 0 && /^ok - /.test(r.out) && r2.out === `${BASE}/tall` && /new page errors/.test(errs) && /kaboom/.test(errs), `${show(r)}\n${show(r2)}`);
  r = run(s2, ['text', '#missing-thing']);
  check('a failed command is exit 1 on stderr', r.code === 1 && r.out === '', show(r));
  const dir = run(s2, ['dir']).out;
  const steps = [...readFileSync(join(dir, 'transcript.md'), 'utf8').matchAll(/^### (\d+) /gm)].map((m) => Number(m[1]));
  check('transcript step numbers are unique and increasing',
    steps.length >= 7 && steps.every((n, i) => i === 0 || n > steps[i - 1]), steps.join(','));

  /* ------------------------------------------- C: launch flags on a live session */
  console.log('\nlaunch flags on a live session');
  r = run(s2, [`--${ENGINE}`, '--headless', '--viewport', '640x400', 'url']);
  check('flags that match the live session are accepted', r.code === 0 && r.out === `${BASE}/tall`, show(r));
  r = run(s2, ['--headful', '--viewport', '390x844', 'url']);
  check('a mismatch is refused naming each differing value',
    r.code === 1 && r.out === '' && /--headful \(it runs --headless\)/.test(r.err) && /--viewport 390x844 \(it runs --viewport 640x400\)/.test(r.err), show(r));
  r = run(s2, ['-p', 'someone', 'url']);
  check('a different profile is refused too', r.code === 1 && /-p someone \(it runs without a profile\)/.test(r.err), show(r));

  /* ------------------------------------------------------------ E: paths */
  console.log('\nscreenshot paths');
  const abs = join(HOME, 'abs', 'shot.png');
  r = run(s2, ['screenshot', abs]);
  check('an absolute path is written there and printed', r.code === 0 && r.out === `saved ${abs}` && existsSync(abs), show(r));
  r = run(s2, ['screenshot', 'rel/two']);
  const rel = join(CWD, 'rel', 'two.png');
  check('a relative path resolves against the caller cwd', r.code === 0 && existsSync(rel) && r.out.endsWith('/rel/two.png'), show(r));
  mkdirSync(join(HOME, 'into'));
  r = run(s2, ['screenshot', join(HOME, 'into'), '--sel', 'h1']);
  check('a directory gets a generated name inside it', r.code === 0 && readdirSync(join(HOME, 'into')).length === 1 && r.out.includes(join(HOME, 'into')), show(r));
  r = run(s2, ['screenshot', 'label']);
  check('a bare name stays in the session dir', r.code === 0 && r.out === `saved ${dir}/label.png`, show(r));

  /* ------------------------------------------------ K1: fast read failures */
  console.log('\nreads on a missing selector fail fast');
  run(s2, ['goto', `${BASE}/plain`]);
  r = run(s2, ['text', 'main']);
  check('text main fails fast, listing what is there, no call log',
    r.code === 1 && r.ms < 6000 && /nothing matches 'main'/.test(r.err) && /#app/.test(r.err) && !/Call log/.test(r.err), `${r.ms}ms ${show(r)}`);
  r = run(s2, ['snapshot', 'nav']);
  check('snapshot nav fails fast too', r.code === 1 && r.ms < 6000 && /nothing matches 'nav'/.test(r.err) && !/Call log/.test(r.err), `${r.ms}ms ${show(r)}`);
  run(s2, ['goto', `${BASE}/navs`]);
  r = run(s2, ['text', 'main']);
  check('an existing landmark still reads', r.code === 0 && r.out === 'body', show(r));
  r = run(s2, ['snapshot', 'nav']);
  check('snapshot of several matches reads the first and says so', r.code === 0 && /link "A"/.test(r.out) && !/link "B"/.test(r.out) && /matched 2/.test(r.err), show(r));
  r = run(s2, ['snapshot', '--refs']);
  const mainRef = /- main[^\n]*\[(@e\d+)\]/.exec(r.out)?.[1];
  r = run(s2, ['snapshot', mainRef || '@e0']);
  check('a reference from the last snapshot still works as the scope', !!mainRef && r.code === 0 && /body/.test(r.out), `${mainRef} ${show(r)}`);

  /* ------------------------------------------------------ K3: suggestions */
  console.log('\nsuggestions');
  r = run(s2, ['ls']);
  check('ls points at sessions and target', r.code === 1 && /did you mean 'sessions'.*'target'/.test(r.err), show(r));
  r = run(s2, ['--no-record', 'url']);
  check('a leading unknown flag gets its nearest launch flag', r.code === 1 && /unknown flag --no-record - did you mean --no-video\?/.test(r.err), show(r));
  r = run(s2, ['snapshot', '--compakt']);
  check('a per-command typo gets that command\'s flag', r.code === 1 && /did you mean --compact\?/.test(r.err), show(r));
  run(s2, ['close']);

  /* ---------------------------------------------------- K4: frame scopes */
  console.log('\nframe scopes');
  const s3 = `out-frames-${process.pid}`;
  r = run(s3, ['--popups', 'open', `${BASE}/frames`]);
  check('frames page opens', r.code === 0, show(r));
  r = run(s3, ['target', 'iframe']);
  check('a selector matching several iframes is refused with each one named',
    r.code === 1 && /matches 3 iframes/.test(r.err) && /iframe#outer/.test(r.err) && /iframe\[title="other"\]/.test(r.err), show(r));
  run(s3, ['target', '#outer']);
  r = run(s3, ['target', '#inner']);
  check('target inside a scope nests', r.code === 0 && /scoped into #outer >> #inner/.test(r.out), show(r));
  r = run(s3, ['click', '#b']);
  check('...and the nested scope holds for the next commands', r.code === 0 && run(s3, ['text', '#b']).out === 'hit', show(r));
  r = run(s3, ['target', '#sib']);
  check('a sibling frame is reachable without target top', r.code === 0 && /scoped into #sib -/.test(r.out), show(r));
  r = run(s3, ['eval', 'window.top.document.getElementById("pop").click(), 1']);
  const back = run(s3, ['wait', '2000']);
  r = run(s3, ['target']);
  check('a popup opening and closing does not drop the scope', r.code === 0 && /frame scope: #sib/.test(r.out) && /back in its frame scope #sib/.test(back.err + r.err), `${show(back)}\n${show(r)}`);
  r = run(s3, ['click', '#s']);
  check('...and commands still resolve inside it', r.code === 0 && run(s3, ['text', '#s']).out === 'sibhit', show(r));
  run(s3, ['eval', 'window.top.document.getElementById("rm").click(), 1']);
  r = run(s3, ['click', '#s']);
  check('a frame that is gone fails and says the scope is dropped', r.code === 1 && /frame scope '#sib' is gone/.test(r.err), show(r));
  r = run(s3, ['target']);
  check('...and the scope really is dropped', r.code === 0 && !/frame scope/.test(r.out), show(r));
  run(s3, ['close']);

  /* ------------------------------------------------- K5: 1x captures */
  console.log('\n1x captures');
  const s4 = `out-scale-${process.pid}`;
  r = run(s4, ['--viewport', '360x240', 'open', `${BASE}/plain`]);
  const sdir = run(s4, ['dir']).out;
  const shot = /\[(shots\/[^\]]+)\]/.exec(r.err)?.[1];
  check('step shots are 1x', !!shot && png(join(sdir, shot)).join('x') === '360x240', shot && png(join(sdir, shot)).join('x'));
  r = run(s4, ['screenshot', 'dev.png']);
  const want = ENGINE === 'chromium' ? '720x480' : '360x240';
  check(`a deliverable screenshot keeps device density (${want})`, r.code === 0 && png(join(sdir, 'dev.png')).join('x') === want, show(r));
  r = run(s4, ['screenshot', 'css.png', '--scale', 'css']);
  check('--scale css saves 1x', r.code === 0 && png(join(sdir, 'css.png')).join('x') === '360x240', show(r));
  r = run(s4, ['screenshot', 'x.png', '--scale', '2x']);
  check('--scale rejects anything but css|device', r.code === 1 && /--scale wants css or device/.test(r.err), show(r));
  run(s4, ['close']);

  /* ------------------------------------- D: close carries queued notes on stderr */
  console.log('\nclose');
  const s6 = `out-close-${process.pid}`;
  run(s6, ['open', `${BASE}/plain`]);
  run(s6, ['eval', 'setTimeout(() => alert("hey"), 100); 1']);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  r = run(s6, ['close']);
  check('a dialog answered after the last command is said by close, on stderr',
    r.code === 0 && /dialog\(alert\): "hey"/.test(r.err) && !/dialog/.test(r.out) && /^closed/.test(r.out), show(r));

  /* --------------------------------- concurrent starts and a user BROWSE_OUT */
  console.log('\ntwo clients starting one session');
  const runBg = (session, args) => new Promise((resolve) => {
    if (!sessions.includes(session)) sessions.push(session);
    const c = spawn(join(ROOT, 'bin', 'browse'), ['-s', session, ...args], { cwd: CWD, env: BASE_ENV });
    let out = '', err = '';
    c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
  const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const s7 = `out-race-${process.pid}`;
  let first = runBg(s7, ['--viewport', '800x600', 'open', `${BASE}/plain`]);
  pause(300);
  r = run(s7, ['eval', 'throw new Error("x")']);
  let a = await first;
  check('a second client failing during start-up does not discard the first client\'s browser',
    a.code === 0 && r.code === 1 && !/no session was left running/.test(r.err), `A: ${show(a)}\nB: ${show(r)}`);
  run(s7, ['close']);
  const s8 = `out-race2-${process.pid}`;
  first = runBg(s8, ['--viewport', '800x600', 'open', `${BASE}/plain`]);
  pause(300);
  r = run(s8, ['--viewport', '1024x768', 'url']);
  a = await first;
  check('a client that attaches to a browser another client started refuses differing launch flags',
    a.code === 0 && /started session/.test(a.err) && r.code === 1 && /different launch settings: --viewport/.test(r.err) && !/started session/.test(r.err),
    `A: ${show(a)}\nB: ${show(r)}`);
  run(s8, ['close']);
  const userOut = join(HOME, 'user-out');
  mkdirSync(userOut);
  r = run(`out-uo-${process.pid}`, ['text', 'h1'], { BROWSE_OUT: userOut });
  check('a discarded start keeps an empty BROWSE_OUT the user made', r.code === 1 && /no session was left running/.test(r.err) && existsSync(userOut), show(r));

  /* ------------------------------------- H: profile engine + profiles text */
  console.log('\nprofiles');
  const prof = `p${process.pid}`;
  mkdirSync(join(HOME, 'profiles', prof), { recursive: true });
  writeFileSync(join(HOME, 'profiles', prof, 'Local State'), '{}');
  const s5 = `out-prof-${process.pid}`;
  const noEngine = { BROWSE_ENGINE: '' };
  r = run(s5, ['-p', prof, 'open', `${BASE}/plain`], noEngine);
  check('-p with no engine flag starts on the engine the profile was last used with',
    r.code === 0 && new RegExp(`started session '${s5}': chromium, profile '${prof}' \\(its last-used engine\\)`).test(r.err), show(r));
  r = run(s5, ['-p', prof, '--chromium', 'url'], noEngine);
  check('...and later commands with the same -p and engine are accepted', r.code === 0 && r.out === `${BASE}/plain`, show(r));
  run(s5, ['close']);
  r = run(s5, ['profiles']);
  check('profiles does not present cookies as logins', r.code === 0 && /not which are signed in/.test(r.out) && !/login under/.test(r.out), show(r));
} finally {
  for (const s of sessions) spawnSync(join(ROOT, 'bin', 'browse'), ['-s', s, 'close'], { env: BASE_ENV, timeout: 120000 });
  server.kill();
  rmSync(HOME, { recursive: true, force: true });
}
console.log(`\n${checks - failures}/${checks} passed (${ENGINE})`);
process.exit(failures ? 1 : 0);
