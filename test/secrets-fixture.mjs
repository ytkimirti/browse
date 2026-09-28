#!/usr/bin/env node
// Origin for test/net-redact.test.mjs. Its own process for the same reason as
// fixture-server.mjs: the driver blocks in spawnSync while the CLI runs.
//
// Every credential it sends or receives carries a SECRET marker, so the test can
// assert that no marker reaches network.jsonl, and every harmless neighbour a
// KEEP marker, so it can assert redaction did not eat the rest.

import http from "node:http";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJKV1RTRUNSRVQifQ.c2lnbmF0dXJlU0VDUkVU";

const PAGE = `<!doctype html><meta charset=utf8><title>secrets</title>
<script>
// Assembled at runtime so the page SOURCE (logged as a body too) holds no marker.
const S = 'SECRET-';
(async () => {
  // Each body is READ: Chromium never finishes (so never logs) an unread fetch body.
  await (await fetch('/api/login?access_token=Q' + S + 'query&page=KEEP-page&key=Q' + S + 'key', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-vercel-protection-bypass': 'H' + S + 'bypass',
      'x-app-session-id': 'H' + S + 'session',
      'authorization': 'Bearer H' + S + 'bearer-0123456789',
      'x-request-id': 'KEEP-reqid',
    },
    body: JSON.stringify({ username: 'KEEP-alice', password: 'B' + S + 'pw', clientSecret: 'B' + S + 'cs',
      apiKey: 'B' + S + 'ak', nested: { refresh_token: 'B' + S + 'rt', token_type: 'KEEP-bearer' }, maxTokens: 500 }),
  })).text();
  await (await fetch('/api/form', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'user=KEEP-bob&password=F' + S + 'pw&remember=1' })).text();
  document.body.insertAdjacentHTML('beforeend', '<div id=done>done</div>');
})();
</script>`;

http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/api/login") {
    req.resume();
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "set-cookie": "sid=RSECRET-cookie; Path=/; HttpOnly",
      "x-upstream-signature": "RSECRET-sig",
      "x-trace": "KEEP-trace",
      // A bare path with a query, the shape of HTTP/2's :path pseudo-header.
      "content-location": "/api/login?page=KEEP-path&access_token=RSECRET-path",
      "x-forwarded-token-note": `id ${JWT}`,
    });
    return res.end(JSON.stringify({ token: "RSECRET-token", user: { name: "KEEP-alice" }, note: JWT,
      next: "https://example.test/cb?page=KEEP-next&access_token=RSECRET-url" }));
  }
  if (url === "/api/form") {
    req.resume();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end('<meta name="csrf-token" content="RSECRET-csrf"><input name="q" value="KEEP-q">');
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(PAGE);
}).listen(0, "127.0.0.1", function () {
  process.stdout.write(`PORT ${this.address().port}\n`);
});
