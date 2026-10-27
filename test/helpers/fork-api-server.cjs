const http = require("node:http");
const path = require("node:path");
const { createLocalApiHandler } = require("../../src/lib/local-api");
const handler = createLocalApiHandler({
  queuePath: path.join(
    process.env.HOME,
    ".tokentracker",
    "tracker",
    "queue.jsonl",
  ),
  syncContext: { home: process.env.HOME },
  credentialPlatform: "linux",
});
const server = http.createServer(async (req, res) => {
  try {
    if (!(await handler(req, res, new URL(req.url, "http://127.0.0.1")))) {
      if (process.env.TT_UI_ASSETS) {
        const fs = require("node:fs");
        let requested = path.resolve(
          process.env.TT_UI_ASSETS,
          "." + new URL(req.url, "http://127.0.0.1").pathname,
        );
        if (
          !requested.startsWith(
            path.resolve(process.env.TT_UI_ASSETS) + path.sep,
          ) ||
          !fs.existsSync(requested) ||
          fs.statSync(requested).isDirectory()
        )
          requested = path.join(process.env.TT_UI_ASSETS, "index.html");
        const ext = path.extname(requested);
        res.setHeader(
          "Content-Type",
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".woff2": "font/woff2",
          }[ext] || "application/octet-stream",
        );
        fs.createReadStream(requested).pipe(res);
      } else {
        res.writeHead(404);
        res.end("{}");
      }
    }
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.code || e.message }));
  }
});
server.listen(0, "127.0.0.1", () =>
  process.send({ port: server.address().port }),
);
process.on("message", (m) => {
  if (m === "close") server.close(() => process.exit(0));
});
