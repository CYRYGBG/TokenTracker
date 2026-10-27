const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  http = require("node:http"),
  { spawn } = require("node:child_process"),
  { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
test("personal CLI starts without official config, isolates storage and leaves an existing official profile intact", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-personal-profile-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const official = path.join(home, ".tokentracker", "tracker");
  await fs.mkdir(official, { recursive: true });
  const sentinel = JSON.stringify({
    machineId: "official-machine",
    doNotChange: true,
  });
  await fs.writeFile(path.join(official, "config.json"), sentinel);
  const server = http.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const preload = path.join(home, "deny-external.cjs");
  await fs.writeFile(
    preload,
    "const f=global.fetch;global.fetch=(u,o)=>{if(!['localhost','127.0.0.1'].includes(new URL(u).hostname))throw Error('fixture offline');return f(u,o);};",
  );
  const child = spawn(
    process.execPath,
    [
      "--require",
      preload,
      path.join(__dirname, "../bin/personal.js"),
      "serve",
      "--no-sync",
      "--no-open",
      "--port",
      String(port),
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        CODEX_HOME: path.join(home, ".codex"),
        CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
        DSH_HOME: path.join(home, ".dsh"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/local-auth`);
        if (r.ok) {
          ready = true;
          break;
        }
      } catch {}
      await delay(50);
    }
    assert.ok(ready, output);
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(html, /<div id="root"/);
    assert.equal(
      await fs.readFile(path.join(official, "config.json"), "utf8"),
      sentinel,
    );
    assert.ok(
      !(await fs.readdir(home)).includes(".codex"),
      "serve does not install or rewrite tool hooks",
    );
    assert.ok((await fs.readdir(home)).includes(".tokentracker-personal"));
  } finally {
    child.kill("SIGTERM");
    const [code] = await once(child, "exit");
    assert.equal(code, 0, output);
  }
});
