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

import http from "node:http";

const PAGE = `<!doctype html><meta charset=utf8><title>mw</title>
<pre id=out>pending</pre>
<img id=pic src="/pixel.png" onerror="window.__picFailed=1" onload="window.__picFailed=0">
<script>
window.__picFailed = -1;
(async () => {
  const get = async (p) => { try { return await (await fetch(p)).json(); } catch (e) { return {fetchError: String(e)}; } };
  window.__r = {
    user: await get('/api/user'),
    config: await get('/api/config'),
    other: await get('/api/other'),
  };
  document.getElementById('out').textContent = JSON.stringify(window.__r);
  window.__ready = 1;
})();
</script>`;

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
