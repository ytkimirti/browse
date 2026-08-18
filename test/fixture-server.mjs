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
<input id=in>
<input id=file type=file>
<select id=sel><option value="a">a</option><option value="--">-- pick one --</option></select>
<iframe id=frame src="/frame" width=200 height=80></iframe>
<!-- A closed dialog left mounted, EARLIER in the DOM than the open one, with the
     same roles inside it. This is what Ant Design and Radix forceMount leave
     behind, and it is what makes [role=dialog] input resolve to nothing a user
     can see. -->
<div class=ghost role=dialog style="display:none"><input class=confirm><button class=go>Go</button></div>
<div class=live role=dialog><input class=confirm><button class=go>Go</button></div>
<div class=allhidden style="display:none"><button class=nope>Nope</button><button class=nope>Nope</button></div>
<div id=clicks>0</div>
<div id=dropped>no</div>
<div id=long></div>
<script>
let n = 0;
document.getElementById('btn').addEventListener('click', () => {
  document.getElementById('clicks').textContent = String(++n);
});
window.__go = 0;
for (const b of document.querySelectorAll('.go')) b.addEventListener('click', () => { window.__go++; });
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

// One page for the observation commands: a status that FLIPS on a timer (so
// `wait --text` has something to hold for that a `wait <selector>` cannot),
// console output at three levels including one logged during page load (which
// an eval-installed hook can never see), a slot printed from a global that only
// an init script can have set, and a set of same-named static assets next to one
// real api call (so `net lab` has bundle noise to hide).
const LAB = `<!doctype html><meta charset=utf8><title>lab</title>
<link rel=stylesheet href="/lab-styles.css">
<div id=status>Working</div>
<div id=seed></div>
<img src="/lab-pixel.png">
<script src="/lab-chunk.js"></script>
<script>
console.log('lab log one');
console.warn('lab warn two');
console.error('lab error three');
document.getElementById('seed').textContent = String(window.__seeded === undefined ? 'none' : window.__seeded);
fetch('/api/lab');
setTimeout(() => { document.getElementById('status').textContent = 'Complete'; }, 1200);
</script>`;

// Body is EMPTY until a timer fills it: an observe command run right after the
// navigation reads nothing, which is the false "the page is blank" this suite
// pins down. #alwaysempty stays empty forever, for the other half of the case.
const LATE = `<!doctype html><meta charset=utf8><title>late</title>
<div id=alwaysempty></div>
<script>setTimeout(() => { document.body.insertAdjacentHTML('beforeend', '<p>late content arrived</p>'); }, 900);</script>`;

const SIGNIN = `<!doctype html><meta charset=utf8><title>sign in</title><h1>Sign in to continue</h1>`;

// The page whose 'load' event never arrives inside a settle budget: an image the
// server never answers. #box is filled at t=600ms, so a read right after the
// navigation is empty, the content IS there well before the budget runs out, and
// only a settle that re-reads AFTER waiting for load can see it.
const STALLED = `<!doctype html><meta charset=utf8><title>stalled</title>
<div id=box></div>
<img src="/never-answers.png">
<script>setTimeout(() => { document.getElementById('box').textContent = 'arrived while loading'; }, 600);</script>`;

// Fills the viewport with one colour and pins a different one to the far
// corner, so a single pixel of a recorded frame says whether the video really
// covers the viewport or only its magnified top-left corner.
const CORNER = `<!doctype html><meta charset=utf8><title>corner</title>
<style>html,body{margin:0;height:100%;background:#00ff00}
#br{position:fixed;right:0;bottom:0;width:120px;height:120px;background:#0000ff}</style>
<div id=br></div>`;

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
  if (url === "/ui" || url === "/frame" || url === "/corner" || url === "/lab" || url === "/late" || url === "/stalled" || url === "/auth/sign-in") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    const body = { "/ui": UI, "/frame": FRAME, "/corner": CORNER, "/lab": LAB, "/late": LATE, "/stalled": STALLED, "/auth/sign-in": SIGNIN }[url];
    return res.end(body);
  }
  // Answers nothing, ever: holds the page's 'load' event open.
  if (url === "/never-answers.png") { res.writeHead(200, { "content-type": "image/png" }); return; }
  if (url === "/lab-styles.css") {
    res.writeHead(200, { "content-type": "text/css", "cache-control": "no-store" });
    return res.end("body{font-family:system-ui}");
  }
  if (url === "/lab-chunk.js") {
    res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
    return res.end("window.__labChunk = 1;");
  }
  if (url === "/lab-pixel.png") {
    res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
    return res.end(PNG);
  }
  if (url === "/api/lab") return json(res, { lab: true });
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
