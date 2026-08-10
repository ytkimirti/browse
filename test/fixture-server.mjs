#!/usr/bin/env node
// Test origin for the `browse middleware` integration test. Runs as its OWN
// process: the test driver blocks in spawnSync while it waits on the CLI, so an
// in-process server would never answer a single request.
//
// Prints "PORT <n>" on stdout once listening. Serves:
//   /            page that fetches the three APIs + the image and records what
//                the browser actually received into window.__r / window.__picFailed
//   /api/user, /api/config, /api/other, /pixel.png
//   /__hits      how many times each of the above reached this ORIGIN — the only
//                way to tell "mocked" from "fetched and then rewritten"
//   /ui          interaction fixture for the regression test: a draggable source,
//                a click counter, a target=_blank link, an iframe, a long page
//   /frame       the iframe's document (its own location + marker text)

import http from "node:http";

// #done is appended only after every fetch AND the image have settled, so the
// test can `browse wait "#done"` instead of sleeping a guessed number of ms.
// A fixed sleep here would be a race on a cold browser (and this machine runs
// many agents at once), and it would fail as a WRONG VALUE rather than a timeout.
const PAGE = `<!doctype html><meta charset=utf8><title>mw</title>
<pre id=out>pending</pre>
<img id=pic src="/pixel.png" onerror="window.__pic='failed';settle()" onload="window.__pic='loaded';settle()">
<script>
window.__pic = null;
let picDone = null;
const picSettled = new Promise((r) => { picDone = r; });
function settle() { picDone(); }
(async () => {
  const get = async (p) => { try { return await (await fetch(p)).json(); } catch (e) { return {fetchError: String(e)}; } };
  window.__r = {
    user: await get('/api/user'),
    config: await get('/api/config'),
    other: await get('/api/other'),
  };
  document.getElementById('out').textContent = JSON.stringify(window.__r);
  await picSettled;
  const d = document.createElement('div');
  d.id = 'done';
  d.textContent = 'done';
  document.body.appendChild(d);
})();
</script>`;

// Interaction fixture. Every counter is read back with `browse eval`, so a
// command that REPORTS success without reaching the page fails the assertion
// rather than passing quietly — that is the whole point of the drag test.
const UI = `<!doctype html><meta charset=utf8><title>ui</title>
<style>#src{width:90px;height:40px;background:#8cf}#drop{width:90px;height:40px;background:#fc8}
button{display:block;margin:8px 0}</style>
<div id=src draggable="true">drag me</div>
<div id=drop>drop here</div>
<button id=btn>click me</button>
<a id=blank href="/ui?popup=1" target="_blank">open a tab</a>
<iframe id=frame src="/frame" width=200 height=80></iframe>
<div id=clicks>0</div>
<div id=dropped>no</div>
<div id=long></div>
<script>
let n = 0;
document.getElementById('btn').addEventListener('click', () => {
  document.getElementById('clicks').textContent = String(++n);
});
const drop = document.getElementById('drop');
drop.addEventListener('dragover', (e) => e.preventDefault());
drop.addEventListener('drop', (e) => { e.preventDefault(); document.getElementById('dropped').textContent = 'yes'; });
// 400 lines: enough that a read command has to truncate, so the truncation
// NOTICE is what the test asserts on.
document.getElementById('long').textContent =
  Array.from({length: 400}, (_, i) => 'line ' + i + ' ' + 'x'.repeat(60)).join('\\n');
</script>`;

const FRAME = `<!doctype html><meta charset=utf8><title>frame</title>
<div id=fs>inside-the-frame</div>`;

// 1x1 transparent png
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

const hits = { user: 0, config: 0, other: 0, pixel: 0 };
const json = (res, o) => {
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(o));
};

http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/__hits") return json(res, hits);
  if (url === "/__reset") { for (const k of Object.keys(hits)) hits[k] = 0; return json(res, hits); }
  if (url === "/api/user") { hits.user++; return json(res, { id: 99, name: "real-user" }); }
  if (url === "/api/config") { hits.config++; return json(res, { env: "prod", debug: false }); }
  if (url === "/api/other") { hits.other++; return json(res, { from: "server" }); }
  if (url === "/ui" || url === "/frame") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(url === "/ui" ? UI : FRAME);
  }
  if (url === "/pixel.png") {
    hits.pixel++;
    res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
    return res.end(PNG);
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(PAGE);
}).listen(0, "127.0.0.1", function () {
  process.stdout.write(`PORT ${this.address().port}\n`);
});
