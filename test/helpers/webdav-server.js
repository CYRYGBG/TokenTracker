// Shared in-memory WebDAV test server (used by webdav-client.test.js and the
// two-device sync integration tests). Implements the standard methods the
// client uses, with injectable faults.

const http = require("node:http");

function createWebDavTestServer() {
  const state = {
    collections: new Set(["/"]),
    files: new Map(), // path -> string content
    requests: [],
    faults: {}, // method -> { status, retryAfter?, corruptGet?, dropMove? }
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const p = decodeURIComponent(url.pathname);
    state.requests.push({ method: req.method, path: p });
    const fault = state.faults[req.method];
    if (fault && fault.status) {
      if (fault.retryAfter) res.setHeader("Retry-After", fault.retryAfter);
      res.writeHead(fault.status);
      res.end();
      return;
    }

    const auth = req.headers.authorization || "";
    if (auth !== `Basic ${Buffer.from("user:app-password").toString("base64")}`) {
      res.writeHead(401);
      res.end();
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(200, {
        DAV: "1, 2",
        Allow: "OPTIONS, GET, PUT, PROPFIND, MKCOL, MOVE, DELETE",
      });
      res.end();
      return;
    }

    if (req.method === "PROPFIND") {
      if (!state.collections.has(p) && !state.files.has(p)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const depth = req.headers.depth === "0";
      const directChildren = new Set();
      for (const entry of [...state.collections, ...state.files.keys()]) {
        if (entry === p || !entry.startsWith(p === "/" ? "/" : `${p}/`)) continue;
        const rest = entry.slice(p === "/" ? 1 : p.length + 1);
        const first = rest.split("/")[0];
        if (first) directChildren.add(`${p === "/" ? "" : p}/${first}`);
      }
      const items = depth ? [] : [...directChildren];
      const rows = [p, ...items].map((href) => {
        const isCollection = state.collections.has(href);
        const file = state.files.get(href);
        const encoded = href.split("/").map(encodeURIComponent).join("/");
        return (
          `<D:response>` +
          `<D:href>${encoded}${isCollection ? "/" : ""}</D:href>` +
          `<D:propstat><D:prop>` +
          (isCollection ? `<D:resourcetype><D:collection/></D:resourcetype>` : `<D:resourcetype/>`) +
          (file != null ? `<D:getcontentlength>${Buffer.byteLength(file)}</D:getcontentlength>` : "") +
          `<D:getlastmodified>Mon, 26 Oct 2026 00:00:00 GMT</D:getlastmodified>` +
          `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>` +
          `</D:response>`
        );
      });
      res.writeHead(207, { "Content-Type": "application/xml" });
      res.end(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${rows.join("")}</D:multistatus>`);
      return;
    }

    if (req.method === "MKCOL") {
      if (state.collections.has(p) || state.files.has(p)) {
        res.writeHead(405);
        res.end();
        return;
      }
      state.collections.add(p);
      res.writeHead(201);
      res.end();
      return;
    }

    if (req.method === "PUT") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        state.files.set(p, body);
        res.writeHead(201);
        res.end();
      });
      return;
    }

    if (req.method === "GET") {
      const file = state.files.get(p);
      if (file == null) {
        res.writeHead(404);
        res.end();
        return;
      }
      const payload = fault && fault.corruptGet ? file.slice(0, Math.floor(file.length / 2)) : file;
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(payload);
      return;
    }

    if (req.method === "MOVE") {
      if (fault && fault.dropMove) {
        res.writeHead(405);
        res.end();
        return;
      }
      const destinationHeader = req.headers.destination || "";
      const destination = decodeURIComponent(new URL(destinationHeader).pathname);
      if (!state.files.has(p) && !state.collections.has(p)) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (state.files.has(destination)) {
        res.writeHead(412);
        res.end();
        return;
      }
      if (state.files.has(p)) state.files.set(destination, state.files.get(p));
      else state.collections.add(destination);
      state.files.delete(p);
      state.collections.delete(p);
      res.writeHead(201);
      res.end();
      return;
    }

    if (req.method === "DELETE") {
      state.files.delete(p);
      state.collections.delete(p);
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(405);
    res.end();
  });

  return {
    server,
    state,
    listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)),
    close: () => new Promise((resolve) => server.close(resolve)),
    baseUrl: () => `http://127.0.0.1:${server.address().port}`,
  };
}

module.exports = { createWebDavTestServer };
