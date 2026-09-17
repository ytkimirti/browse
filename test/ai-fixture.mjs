import http from 'node:http';
const html = `<!doctype html><title>Browser AI fixture</title><style>body{font:18px sans-serif;padding:40px}section{border:1px solid #ccc;padding:20px;margin:12px}button,input{padding:12px;margin:8px}</style>
<h1>Resource dashboard</h1>
<section id="redis"><h2>Redis cache</h2><button onclick="document.querySelector('#result').textContent='Redis settings opened'">Settings</button></section>
<section id="blob"><h2>Blob storage</h2><button id="blob-settings" onclick="document.querySelector('#result').textContent='Blob settings opened'">Settings</button><button disabled>Delete bucket</button></section>
<section id="profile"><h2>Profile</h2><label>Contact email <input id="email" type="email" value="private-value@example.invalid"></label><label>Password <input type="password" value="do-not-send-password"></label><button id="save" onclick="document.querySelector('#result').textContent='Profile saved'">Save profile</button><button style="display:none">Hidden action</button></section>
<div id="result" role="status">Ready</div><script>const h=document.createElement('div');h.id='shadow';document.body.append(h);h.attachShadow({mode:'open'}).innerHTML='<button id="shadow-button">Shadow action</button>';h.shadowRoot.querySelector('button').onclick=()=>document.querySelector('#result').textContent='Shadow clicked';</script>`;
let mode = 'ok', calls = [];
http.createServer(async (req, res) => {
  const send = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (req.url === '/') { res.end(html); return; }
  if (req.url === '/calls') return send(200, calls);
  if (req.url.startsWith('/mode/')) { mode = req.url.slice(6); return send(200, { mode }); }
  if (req.method !== 'POST' || req.url !== '/api') { res.writeHead(404); res.end(); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); calls.push(body);
  if (mode === 'error') return send(429, { error: 'sensitive provider body' });
  if (mode === 'slow') await new Promise(r => setTimeout(r, 1000));
  if (mode === 'invalid-json') { res.end('not json'); return; }
  const q = body.questions.decision;
  if (q.type === 'noul') return send(200, { answers: { decision: { type: 'noul', noul: mode === 'low' ? .4 : .98 } }, usage: { input_tokens: 150 } });
  const want = /Shadow/.test(q.instructions) ? 'Shadow action' : /email/.test(q.instructions) ? 'Contact email' : 'Settings';
  const chosen = Object.entries(q.criteria).find(([k, v]) => k !== 'none' && JSON.parse(v).name === want && (want !== 'Settings' || JSON.parse(v).context.includes('Blob storage')))?.[0] || 'none';
  const keys = Object.keys(q.criteria);
  let probabilities = Object.fromEntries(keys.map(k => [k, k === chosen ? .98 : .02 / (keys.length - 1)]));
  if (mode === 'low') probabilities = Object.fromEntries(keys.map(k => [k, 1 / keys.length]));
  if (mode === 'nan') probabilities[chosen] = '0.99';
  if (mode === 'unknown') probabilities = { surprise: 1 };
  if (mode === 'none') probabilities = Object.fromEntries(keys.map(k => [k, k === 'none' ? 1 : 0]));
  send(200, { model: 'jev-latest', answers: { decision: { type: 'choice', choice: mode === 'unknown' ? 'surprise' : mode === 'none' ? 'none' : chosen, probabilities, confidence: .9 } }, usage: { input_tokens: 500 } });
}).listen(0, '0.0.0.0', function () { console.log(`PORT ${this.address().port}`); });
