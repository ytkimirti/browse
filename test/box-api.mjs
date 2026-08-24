#!/usr/bin/env node
// A fake Upstash Box API for test/box.test.mjs. Its OWN process, like
// fixture-server.mjs and for the same reason: the test blocks in spawnSync while
// the CLI runs, so a server in that process would never answer a request.
//
// Prints "PORT <n>" once listening. Serves the four endpoints `browse box` uses,
// plus two control routes for the test:
//   POST /__reset   { boxes: [...] }   wipe the account and the recorded calls
//   GET  /__log     { boxes, created, deleted }
//
// It refuses a duplicate box name with the same 409 the real API answers, which
// is the collision two agents at once used to hit.

import http from "node:http";

const KEY = "box_faketestkey";
let boxes = [], created = [], deleted = [], execs = [], uploads = [], seq = 0;

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const body = async () => {
    let s = ""; for await (const c of req) s += c;
    return s ? JSON.parse(s) : {};
  };

  if (url === "/__reset") {
    const b = await body();
    boxes = b.boxes || []; created = []; deleted = []; execs = []; uploads = []; seq = 0;
    return send(200, { ok: true });
  }
  if (url === "/__log") return send(200, { boxes, created, deleted, execs, uploads });

  if (req.headers["x-box-api-key"] !== KEY) return send(401, { error: "bad key" });

  if (req.method === "GET" && url === "/v2/box") return send(200, boxes);
  if (req.method === "GET" && url === "/v2/box/snapshots") {
    return send(200, { snapshots: [{ id: "snap-1", status: "ready", name: "browse-test", created_at: 1, size_bytes: 6e8 }] });
  }
  if (req.method === "POST" && url === "/v2/box/from-snapshot") {
    const want = await body();
    if (boxes.some((b) => b.name === want.name)) {
      return send(409, { error: `Box name "${want.name}" is already in use` });
    }
    const box = { id: `fakebox-${++seq}`, status: "running", name: want.name, labels: want.labels, size: want.size };
    created.push(want);
    boxes.push(box);
    return send(200, box);
  }
  const exec = /^\/v2\/box\/([^/]+)\/exec$/.exec(url);
  if (req.method === "POST" && exec) {
    if (!boxes.some((b) => b.id === exec[1])) return send(404, { error: "Box has been deleted" });
    execs.push(String(((await body()).command || []).join(" ")));
    // What `up`'s readiness probe asks for: a version line, then a `df -Pm` line
    // — MEGABYTES, which is what the -m asks for and what the CLI divides down.
    // The build in the version line is deliberately NOT this checkout's: an image
    // carrying older code is the case `up` has to notice out loud.
    return send(200, { exit_code: 0, output: "browse 0.1.0 (build deadbeef)\noverlay 10240 979 9261 10% /\n" });
  }
  // Uploads: record the destination paths, which is what the push cases assert
  // on (which files were sent, and that an oversized one never got here at all).
  const upload = /^\/v2\/box\/([^/]+)\/files\/upload$/.exec(url);
  if (req.method === "POST" && upload) {
    if (!boxes.some((b) => b.id === upload[1])) return send(404, { error: "Box has been deleted" });
    let raw = "", n = 0;
    for await (const c of req) { n += c.length; raw += c.toString("latin1"); }
    // The destination of each part, out of the multipart body: one `paths` field
    // per file, in order, each its own part with an empty header block.
    const paths = [...raw.matchAll(/name="paths"\r\n\r\n([^\r]*)\r\n/g)].map((m) => m[1]);
    uploads.push({ box: upload[1], bytes: n, paths });
    return send(200, { ok: true });
  }
  const one = /^\/v2\/box\/([^/]+)$/.exec(url);
  if (req.method === "DELETE" && one) {
    deleted.push(one[1]);
    if (!boxes.some((b) => b.id === one[1])) return send(404, { error: "Box has been deleted" });
    boxes = boxes.filter((b) => b.id !== one[1]);
    return send(200, {});
  }
  send(404, { error: `no route ${req.method} ${url}` });
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`PORT ${server.address().port}\n`);
});
