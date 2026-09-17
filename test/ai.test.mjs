import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiConfig } from '../scripts/ai.mjs';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STORE = mkdtempSync(join(tmpdir(), 'browse-ai-'));
symlinkSync(join(homedir(), '.browse/camoufox-pw'), join(STORE, 'camoufox-pw'));
const ENV = { ...process.env, BROWSE_HOME: STORE, BROWSE_OUT: join(STORE, 'out'), BROWSE_SESSION: 'ai-test',
  BROWSE_PW_BASE: join(homedir(), '.browse/package.json'), BROWSE_REMOTE: '', BROWSE_PROFILE: '',
  BROWSE_ENGINE: process.env.BROWSE_ENGINE || 'chromium', BROWSE_VIDEO: '0', BROWSE_HEADFUL: '0', BROWSE_CURSOR: '0', BROWSE_KEYLOG: '0',
  TYPESAFE_API_KEY: 'test-secret-key', TYPESAFE_ENV_FILE: join(STORE, 'absent') };
let checks = 0, failures = 0;
const check = (name, ok, detail = '') => { checks++; if (!ok) failures++; console.log(`${ok ? 'ok' : 'FAIL'} ${name}${ok ? '' : '\n' + detail}`); };
const b = (...args) => {
  const r = spawnSync(process.execPath, [join(ROOT, 'browse.mjs'), ...args], { cwd: STORE, env: ENV, encoding: 'utf8', timeout: 45000 });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
};
const fixture = spawn(process.execPath, [join(ROOT, 'test/ai-fixture.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('fixture timeout')), 10000);
  fixture.stdout.on('data', d => { const m = /PORT (\d+)/.exec(String(d)); if (m) { clearTimeout(timer); resolve(Number(m[1])); } });
});
const base = `http://127.0.0.1:${port}`;
ENV.TYPESAFE_API_URL = base + '/api';
const mode = m => fetch(base + '/mode/' + m);
try {
  writeFileSync(join(STORE, '.env'), 'UNRELATED=$(touch bad)\nTYPESAFE_API_KEY="dotenv-secret"\n');
  check('reads only dotenv key without shell evaluation', aiConfig({}, STORE).key === 'dotenv-secret' && !existsSync(join(STORE, 'bad')));
  check('explicit environment wins over dotenv', aiConfig({ TYPESAFE_API_KEY: 'env-key' }, STORE).key === 'env-key');
  for (const args of [['ai'], ['ai', 'click'], ['ai', 'fill', 'email'], ['ai','click','settings','--timeout','0'], ['snapshot','body','extra']]) {
    const r = b(...args); check(`invalid args fail before launch: ${args.join(' ')}`, r.code === 1 && !existsSync(ENV.BROWSE_OUT), r.err);
  }
  let r = b('ai', 'click', 'settings'); check('AI requires an existing browser', r.code === 1 && /open a page/.test(r.err), r.err);
  r = b('open', base); check('fixture opens', r.code === 0, r.err);
  r = b('snapshot', '#blob'); check('scoped snapshot excludes other regions', r.code === 0 && /Blob storage/.test(r.out) && !/Redis cache/.test(r.out), r.out + r.err);
  r = b('snapshot', 'section'); check('ambiguous snapshot scope fails', r.code === 1, r.err);
  r = b('ai', 'click', 'Settings for Blob storage'); check('semantic click selects correct duplicate label', r.code === 0 && /input_tokens=500/.test(r.out) && b('text','#result').out.includes('Blob settings'), r.out + r.err);
  check('AI action gets a step screenshot', readdirSync(join(ENV.BROWSE_OUT, 'shots')).some(n => n.includes('ai-click')));
  b('eval', "document.querySelector('#result').textContent='Ready'");
  r = b('ai', 'click', 'Settings for Blob storage', '--dry-run'); check('dry run does not click', r.code === 0 && /preview/.test(r.out) && b('text','#result').out.trim() === 'Ready', r.out + r.err);
  r = b('ai', 'hover', 'Settings for Blob storage'); check('hover succeeds without click', r.code === 0 && b('text','#result').out.trim() === 'Ready', r.out + r.err);
  r = b('ai','fill','Contact email','private-filled-value'); check('fill uses selected handle', r.code === 0 && b('eval', "document.querySelector('#email').value").out.trim() === 'private-filled-value', r.out + r.err + b('eval', "document.querySelector('#email').value").out);
  const beforeLiteralFill = readdirSync(join(ENV.BROWSE_OUT, 'shots')).length;
  r = b('ai','fill','Contact email','--dry-run');
  check('literal flag fill value still records an action', r.code === 0 && readdirSync(join(ENV.BROWSE_OUT,'shots')).length === beforeLiteralFill + 1, r.out+r.err);
  r = b('ai','click','Shadow action'); check('open shadow DOM is supported', r.code === 0 && b('text','#result').out.includes('Shadow clicked'), r.out + r.err);
  r = b('ai','assert','Page is ready'); check('assertion reports probability', r.code === 0 && /p=0.980/.test(r.out), r.out + r.err);
  for (const m of ['low','none','unknown','nan','error','invalid-json']) {
    await mode(m); b('eval', "document.querySelector('#result').textContent='Ready'");
    r = b('ai','click','Settings for Blob storage'); check(`${m} response fails without mutation`, r.code === 1 && b('text','#result').out.trim() === 'Ready' && !r.err.includes('sensitive provider body'), r.out + r.err);
  }
  await mode('low'); r = b('ai','assert','Page ready'); check('uncertain assertion fails', r.code === 1 && /not established/.test(r.err), r.err);
  await mode('slow'); r = b('ai','click','Settings for Blob storage','--timeout','50'); check('API timeout fails without retry', r.code === 1 && /timed out/.test(r.err), r.err);
  b('eval', "setTimeout(()=>document.querySelector('#blob-settings').textContent='Delete all',400);'scheduled'");
  r = b('ai','click','Settings for Blob storage'); check('changed target rejected after inference', r.code === 1 && /target changed/.test(r.err), r.out + r.err);
  b('eval', "document.querySelector('#blob-settings').textContent='Settings';setTimeout(()=>document.querySelector('#blob-settings').remove(),400);'scheduled'");
  r = b('ai','click','Settings for Blob storage'); check('detached target cannot redirect to another element', r.code === 1 && /target changed/.test(r.err), r.out + r.err);
  await mode('ok');
  r = b('ai','click','anything','--scope','section'); check('ambiguous scope fails', r.code === 1 && /exactly one/.test(r.err), r.err);
  b('eval', "document.body.innerHTML='<section>'+Array.from({length:201},(_,i)=>'<button>Button '+i+'</button>').join('')+'</section>'; 'ready'");
  const count = (await (await fetch(base+'/calls')).json()).length;
  r = b('ai','click','Button 1'); check('candidate overflow fails without API call', r.code === 1 && /200 candidates/.test(r.err) && (await (await fetch(base+'/calls')).json()).length === count, r.err);
  r = b('ai','click','anything','--scope','#absent'); check('missing scope fails promptly', r.code === 1 && /exactly one/.test(r.err), r.err);
  b('eval', "document.body.innerHTML='<section>'+('context '.repeat(80))+Array.from({length:50},()=>'<button>Settings</button>').join('')+'</section>'; 'ready'");
  r = b('ai','click','Settings'); check('request byte budget fails before API call', r.code === 1 && /24000 bytes/.test(r.err) && (await (await fetch(base+'/calls')).json()).length === count, r.err);
  b('eval', "document.body.innerHTML='<p>'+('visible text '.repeat(1200))+'</p>'; 'ready'");
  r = b('ai','assert','lots of text'); check('assertion overflow is explicit', r.code === 1 && /12000 characters/.test(r.err), r.err);
  const calls = JSON.stringify(await (await fetch(base+'/calls')).json());
  check('disabled and hidden controls are excluded from choices', JSON.parse(calls).filter(c => c.questions.decision.type === 'choice').every(c => Object.entries(c.questions.decision.criteria).filter(([k])=>k !== 'none').every(([,v])=>!['Delete bucket','Hidden action'].includes(JSON.parse(v).name))));
  check('model never sees input values or API credentials in state', !['private-value@example.invalid','do-not-send-password','private-filled-value','test-secret-key'].some(s=>calls.includes(s)));
  r = b('close'); check('close succeeds', r.code === 0, r.err);
  const transcript = readFileSync(join(ENV.BROWSE_OUT,'transcript.md'),'utf8');
  check('AI transcript redacts fill payload', !transcript.includes('ai fill Contact email private-filled-value') && transcript.includes('ai fill "Contact email" <value>'));
  check('credentials absent from artifact text', ['transcript.md','browsed.log','network.jsonl'].every(f => !readFileSync(join(ENV.BROWSE_OUT,f),'utf8').includes('test-secret-key')));
} finally { b('close'); fixture.kill(); rmSync(STORE,{recursive:true,force:true}); }
console.log(`${checks-failures}/${checks} passed`); process.exitCode = failures ? 1 : 0;
