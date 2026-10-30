const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const root = path.resolve(__dirname, "..");
const embedded = path.join(root, "TokenTrackerBar/EmbeddedServer");
const bundle = path.join(embedded, "tokentracker");
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
async function tree(dir) {
  const rows = [];
  async function visit(relative = "") {
    for (const e of (
      await fs.readdir(path.join(dir, relative), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, e.name);
      if (e.isDirectory()) await visit(name);
      else if (e.isFile())
        rows.push([name, sha(await fs.readFile(path.join(dir, name)))]);
      else throw new Error("Unexpected non-file: " + name);
    }
  }
  await visit();
  return { files: rows.length, sha256: sha(JSON.stringify(rows)) };
}
(async () => {
  const comparisons = {};
  for (const relative of ["src", "bin", "dashboard/dist"]) {
    const workspace = await tree(path.join(root, relative));
    const packaged = await tree(path.join(bundle, relative));
    assert.deepEqual(packaged, workspace, relative + " differs in bundle");
    comparisons[relative] = { ...packaged, matchesWorkspace: true };
  }
  for (const file of ["package.json", "package-lock.json"]) {
    const digest = sha(await fs.readFile(path.join(bundle, file)));
    assert.equal(digest, sha(await fs.readFile(path.join(root, file))));
    comparisons[file] = { sha256: digest, matchesWorkspace: true };
  }
  const node = path.join(embedded, "node");
  const version = execFileSync(node, ["-p", "process.versions.node"], {
    encoding: "utf8",
  }).trim();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-embedded-smoke-"));
  let child;
  try {
    const official = path.join(home, ".tokentracker/tracker");
    await fs.mkdir(official, { recursive: true });
    await fs.writeFile(
      path.join(official, "config.json"),
      '{"sentinel":"preserve"}',
    );
    const preload = path.join(home, "offline.cjs");
    await fs.writeFile(
      preload,
      "const f=global.fetch;global.fetch=(u,o)=>{if(!['localhost','127.0.0.1'].includes(new URL(u).hostname))throw Error('fixture offline');return f(u,o);};",
    );
    const listener = http.createServer();
    await new Promise((r) => listener.listen(0, "127.0.0.1", r));
    const port = listener.address().port;
    await new Promise((r) => listener.close(r));
    child = spawn(
      node,
      [
        "--require",
        preload,
        path.join(bundle, "bin/personal.js"),
        "serve",
        "--no-sync",
        "--no-open",
        "--port",
        String(port),
      ],
      {
        cwd: bundle,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CODEX_HOME: path.join(home, ".codex"),
          CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
          DSH_HOME: path.join(home, ".dsh"),
          XDG_CONFIG_HOME: path.join(home, ".config"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    let ready = false;
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null) throw Error(output);
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/local-auth`)).ok) {
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
      '{"sentinel":"preserve"}',
    );
    assert.ok((await fs.readdir(home)).includes(".tokentracker-personal"));
    child.kill("SIGTERM");
    const [code] = await once(child, "exit");
    assert.equal(code, 0, output);
    child = null;
    const report = {
      checkedAt: new Date().toISOString(),
      version: require("../package.json").version,
      upstream: execFileSync('git', ['rev-parse', 'upstream/main'], {cwd: root, encoding: 'utf8'}).trim(),
      dashboard: "dashboard/dist",
      embeddedServer: "TokenTrackerBar/EmbeddedServer",
      architecture: "darwin-arm64",
      nodeVersion: version,
      nodeSha256: sha(await fs.readFile(node)),
      comparisons,
      packagedCliSmoke: {
        passed: true,
        isolatedHome: true,
        offline: true,
        productionHtml: true,
        officialProfileUntouched: true,
        normalExit: true,
      },
      macOSAppBuilt: false,
      windowsAppBuilt: false,
      installedOrPublished: false,
    };
    const delivery = path.join(root, "dist/reviewed");
    try {
      const nativeBuild = JSON.parse(await fs.readFile(path.join(delivery, "macos-build.json"), "utf8"));
      for (const [file, digest] of Object.entries(nativeBuild.nativeSources))
        assert.equal(sha(await fs.readFile(path.join(root, file))), digest, `native source changed: ${file}`);
      const nativeApp = path.join(root, nativeBuild.appPath || "dist/reviewed/TokenTrackerPersonal.app");
      for (const relative of ["src", "bin", "dashboard/dist"])
        assert.deepEqual(await tree(path.join(nativeApp, "Contents/Resources/EmbeddedServer/tokentracker", relative)), await tree(path.join(root, relative)));
      execFileSync("codesign", ["--verify", "--deep", "--strict", nativeApp]);
      report.macOSAppBuilt = true;
      report.nativeApp = { path: path.relative(root, nativeApp), sourceHashesVerified: true, signature: "ad-hoc", notarized: false };
      report.installers = {};
      for (const file of ["TokenTrackerPersonal-macOS-arm64.dmg", "TokenTrackerPersonal-Windows-x64-Setup.exe"]) {
        const bytes = await fs.readFile(path.join(delivery, file));
        report.installers[file] = { bytes: bytes.length, sha256: sha(bytes) };
      }
      for (const relative of ["src", "bin", "dashboard/dist"])
        assert.deepEqual(await tree(path.join(root, "TokenTrackerWin/publish/EmbeddedServer/tokentracker", relative)), await tree(path.join(root, relative)));
      report.windowsAppBuilt = true;
      report.windowsRealMachineVerified = false;
    } catch (e) { if (e.code !== "ENOENT") throw e; }
    await fs.writeFile(
      path.join(root, "docs/fork/evidence/artifacts.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    await fs.rm(home, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
