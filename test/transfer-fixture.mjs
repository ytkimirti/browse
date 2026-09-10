// Fake remote daemon and ssh executable for client transfer failure tests.
import http from 'node:http';
import { writeFileSync } from 'node:fs';
if (process.argv[2] === 'ssh') {
  const args = process.argv.slice(3);
  if (args.includes('-M')) writeFileSync(args[args.indexOf('-S') + 1], 'fixture');
  if (args.at(-1)?.endsWith(' version')) {
    process.stderr.write('browse: command not found\n');
    process.exit(127);
  }
  process.exit(0);
}
let mode = 'ok', byes = 0;
const record = JSON.stringify({ i: 1, t: 0, method: 'GET', url: 'http://fixture.test/api', type: 'fetch', status: 200, ms: 12 }) + '\n';
const files = { 'network.jsonl': record, 'console.jsonl': '', 'transcript.md': '# fixture\n', 'earlier.png': 'image fixture bytes' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (value) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
  if (url.pathname === '/__mode') { mode = url.searchParams.get('value'); return json({ ok: true }); }
  if (url.pathname === '/__status') return json({ byes });
  if (url.pathname === '/health') {
    if (mode === 'busy') return res.writeHead(503).end();
    return json({ ok: true, session: 'transfer', out: '/remote/session', home: '/remote', build: 'fixture' });
  }
  if (url.pathname === '/manifest') return json({ files: Object.keys(files) });
  if (url.pathname === '/bye') { byes++; return json({ ok: true }); }
  if (url.pathname === '/file') {
    const file = url.searchParams.get('p');
    if (!(file in files) || mode === 'missing' && file === 'network.jsonl') return res.writeHead(404).end();
    if (mode === 'torn' && file === 'network.jsonl') {
      res.writeHead(200, { 'content-length': 10000 });
      res.write('partial');
      return setTimeout(() => res.destroy(), 20);
    }
    return res.writeHead(200, { 'content-length': Buffer.byteLength(files[file]) }).end(files[file]);
  }
  if (req.method === 'POST') {
    let raw = ''; for await (const c of req) raw += c;
    const cmd = JSON.parse(raw).cmd;
    if (cmd === 'close') return json({ ok: true, result: 'closed - dir: /remote/session' });
    return json({ ok: false, error: 'fixture only handles close' });
  }
  res.writeHead(404).end();
}).listen(0, '127.0.0.1', function () { console.log(`PORT ${this.address().port}`); });
