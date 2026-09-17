#!/usr/bin/env node
// Live integration/measurement. Uses two disposable boxes supplied by the caller.
// Explicit flags are required because this spends API credits and deletes boxes.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, statSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { aiConfig } from '../scripts/ai.mjs';
const taskMode = process.argv.includes('--task');
const args = process.argv.slice(2).filter(a => a !== '--task');
if (args.length !== 4 || args[0] !== '--live-boxes' || args[1] !== '--delete-boxes') {
  console.log('Usage: TYPESAFE_ENV_FILE=/path/to/.env node test/ai-boxes.mjs --live-boxes --delete-boxes [--task] <box-host-a> <box-host-b>\nUploads this checkout, calls real TypeSafe, records both Boxes, retrieves artifacts, then deletes the supplied disposable Boxes.');
  process.exit(0);
}
if (args[2] === args[3] || !args.slice(2).every(h => /^[\w-]+@(?:[\w-]+\.)?box\.upstash\.com$/.test(h))) throw new Error('Supply two distinct disposable Box SSH hosts');
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin/browse');
const exec = promisify(execFile);
const results = [];
const scratch = mkdtempSync(join(tmpdir(), 'browse-ai-live-'));
const keyFile = join(scratch, 'typesafe.env');
writeFileSync(keyFile, 'TYPESAFE_API_KEY=' + aiConfig().key + '\n', {mode:0o600});
const quote = value => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const localVersion = (await exec(BIN,['version'],{cwd:ROOT})).stdout.trim();
const box = async (...args) => (await exec(BIN, ['box', ...args], { cwd: ROOT, timeout: 180000, maxBuffer: 2e6 })).stdout.trim();
async function test(host, index) {
  const record = { host, cases: [], artifacts: null, deleted: false };
  results.push(record);
  const remote = '/workspace/home/browse-ai';
  const fixtureName = taskMode ? 'ai-task-fixture.mjs' : 'ai-fixture.mjs';
  const browse = async (...args) => {
    const start = performance.now();
    try {
      const command = `env TYPESAFE_ENV_FILE=${remote}/typesafe.env BROWSE_SESSION=typesafe-${index} ${remote}/bin/browse ${args.map(quote).join(' ')}`;
      const r = await exec(BIN, ['box','exec',host,command], { cwd: ROOT, timeout: 180000, maxBuffer: 2e6 });
      return { code: 0, ms: Math.round(performance.now()-start), out: r.stdout.trim(), err: r.stderr.trim() };
    } catch (e) { return { code: e.code, ms: Math.round(performance.now()-start), out: e.stdout || '', err: e.stderr || e.message }; }
  };
  const expect = (name, r, valid) => {
    const passed = valid(r); record.cases.push({ name, passed, ...r });
    console.log(`${host.split('@')[0]} ${passed ? 'PASS' : 'FAIL'} ${name}: ${r.ms}ms ${r.out.split('\n')[0] || r.err.split('\n')[0]}`);
    if (!passed) throw new Error(`${name}: ${r.out} ${r.err}`);
  };
  const assertText = async (name, text) => expect(name, await browse('text','#result'), r=>r.code === 0 && r.out.includes(text));
  try {
    // Upload only this checkout and a private file containing this provider's key.
    // This HTTPS-only test path works when the provider SSH gateway is unavailable.
    await box('push', host, 'browse.mjs', 'package.json', 'scripts', 'bin', 'test/ai-fixture.mjs', 'test/ai-task-fixture.mjs', '--to', '/workspace/home/browse-ai');
    await box('push', host, keyFile, '--to', remote);
    await box('exec', host, `chmod 600 /workspace/home/browse-ai/typesafe.env && chmod +x /workspace/home/browse-ai/bin/browse && setsid nohup node /workspace/home/browse-ai/${fixtureName} >/tmp/browse-ai-fixture.log 2>&1 </dev/null &`);
    const port = await box('exec', host, "for i in 1 2 3 4 5; do if test -s /tmp/browse-ai-fixture.log; then cat /tmp/browse-ai-fixture.log; exit 0; fi; sleep 1; done; exit 1");
    const match = /PORT (\d+)/.exec(port); if (!match) throw new Error('fixture did not start');
    expect('open fixture', await browse('--chromium','--viewport','1280x800','open',`http://127.0.0.1:${match[1]}`), r=>r.code === 0);
    expect('matching runtime build', await browse('version'), r=>r.code === 0 && r.out.includes(localVersion));
    if (taskMode) {
      const goal = 'Open the catalog, open Desk lamp details, choose Express delivery, enter the supplied email, then submit the request.';
      expect('five-action task', await browse('ai','task',goal,'--value','email=buyer@example.invalid'), r=>r.code===0 && /completed; actions=5, queries=6/.test(r.out));
      expect('real task outcome', await browse('text','#confirmed'), r=>r.code===0 && r.out.includes('Request confirmed'));
      expect('submitted exactly once', await browse('eval','document.documentElement.dataset.sends'), r=>r.code===0 && r.out==='1');
      expect('reset fixture', await browse('reload'), r=>r.code===0);
      expect('task with completion selector', await browse('ai','task',goal,'--value','email=buyer@example.invalid','--until','#confirmed'), r=>r.code===0 && /completed \(.*until visible\); actions=5, queries=5/.test(r.out));
      expect('reset for limit', await browse('reload'), r=>r.code===0);
      expect('task step limit', await browse('ai','task',goal,'--value','email=buyer@example.invalid','--max-steps','1'), r=>r.code===1 && /step limit reached/.test(r.err) && /actions=1/.test(r.err));
      expect('public page', await browse('goto','https://example.com'), r=>r.code===0);
      expect('public navigation task', await browse('ai','task','Click Learn more and stop once the Example Domains page is loaded.'), r=>r.code===0 && /completed; actions=1/.test(r.out));
      expect('public navigation outcome', await browse('title'), r=>r.code===0 && /Example Domains/.test(r.out));
    } else {
    expect('scoped snapshot', await browse('snapshot','#blob'), r=>r.code === 0 && /Blob storage/.test(r.out) && !/Redis cache/.test(r.out));
    for (let i=0;i<3;i++) {
      expect(`AI duplicate-label click ${i+1}`, await browse('ai','click','Settings for Blob storage'), r=>r.code === 0);
      await assertText(`AI click outcome ${i+1}`, 'Blob settings opened');
      expect(`direct selector baseline ${i+1}`, await browse('click','#blob-settings'), r=>r.code === 0);
    }
    expect('AI fill', await browse('ai','fill','Contact email','box-test@example.invalid'), r=>r.code === 0);
    expect('fill outcome',await browse('eval',"document.querySelector('#email').value"),r=>r.code === 0 && r.out==='box-test@example.invalid');
    expect('AI hover', await browse('ai','hover','Save profile'), r=>r.code === 0);
    expect('AI state assertion', await browse('ai','assert','The Blob settings were opened','--scope','#result'), r=>r.code === 0);
    expect('AI missing target',await browse('ai','click','Launch the Mars mission'),r=>r.code === 1 && /no confident target/.test(r.err));
    expect('state unchanged after refusal',await browse('text','#result'),r=>r.code === 0 && r.out.includes('Blob settings opened'));
    expect('AI false assertion',await browse('ai','assert','The payment was successfully refunded','--scope','#result'),r=>r.code === 1);
    expect('public page',await browse('goto','https://example.com'),r=>r.code === 0);
    expect('public page assertion',await browse('ai','assert','This domain is intended for documentation examples'),r=>r.code === 0);
    expect('public link preview',await browse('ai','click','Learn more','--dry-run'),r=>r.code === 0 && /preview: \"Learn more\"/.test(r.out));
    }
  } catch (e) { record.error = e.message; console.error(`${host}: ${e.message}`); }
  finally {
    try {
    const closed = await browse('close'); record.close = closed;
    const match = /(?:dir:\s+)([^\n]+?)(?: \(|$)/m.exec(closed.out);
    if (match) {
      const remoteHome = await box('exec',host,'printenv HOME');
      const source = match[1].trim().replace(/^~/, remoteHome.trim());
      const path = join(homedir(), '.browse/deliveries', `typesafe-${host.split('@')[0]}`);
      mkdirSync(path,{recursive:true});
      await box('exec',host,`tar -C ${quote(source)} -czf /tmp/browse-ai-artifacts.tgz .`);
      const archive=join(scratch,`artifacts-${index}.tgz`);
      await box('pull',host,'/tmp/browse-ai-artifacts.tgz',archive);
      await exec('tar',['-xzf',archive,'-C',path]);
      record.artifacts = path;
      const files = readdirSync(path);
      record.artifactsVerified = ['recording.mp4','transcript.md','network.jsonl','shots'].every(f=>files.includes(f)) && statSync(join(path,'recording.mp4')).size>1000;
      const transcript = readFileSync(join(path,'transcript.md'),'utf8');
      record.transcriptHasAI = transcript.includes(taskMode ? 'ai task' : 'ai click');
      console.log(`${host.split('@')[0]} artifacts: ${path} verified=${record.artifactsVerified}`);
    }
    } catch (e) { record.artifactError=e.message; }
    try { await box('exec',host,'rm -f /workspace/home/browse-ai/typesafe.env'); } catch {}
    try {
      if (record.close?.code === 0 && (/no active browser/.test(record.close.out) || record.artifactsVerified)) {
        await box('down', host); record.deleted = true;
      } else record.cleanupError = 'Box retained until recordings can be retrieved; expires at its TTL';
    } catch (e) { record.cleanupError = e.message; }
  }
}
// Independent machines can be exercised concurrently; each retains its session.
const settled = await Promise.allSettled(args.slice(2).map(test));
for (const r of settled) if (r.status === 'rejected') console.error(r.reason);
rmSync(scratch,{recursive:true,force:true});
writeFileSync(taskMode ? '/tmp/browse-task-box-results.json' : '/tmp/browse-ai-box-results.json',JSON.stringify(results,null,2)+'\n');
const failed=results.some(r=>r.error || !r.artifactsVerified || !r.deleted) || settled.some(r=>r.status==='rejected');
console.log(`Results: ${taskMode ? '/tmp/browse-task-box-results.json' : '/tmp/browse-ai-box-results.json'}; ${failed ? 'FAILED' : 'PASSED'}`);
process.exitCode=failed ? 1:0;
