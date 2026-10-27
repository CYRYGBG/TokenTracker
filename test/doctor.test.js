const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { buildDoctorReport } = require("../src/lib/doctor");
const { cmdDoctor } = require("../src/commands/doctor");
const { withHome } = require("./helpers/with-home");

test("doctor marks invalid config.json as critical", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-doctor-"));
  const trackerDir = path.join(tmp, ".tokentracker", "tracker");
  await fs.mkdir(trackerDir, { recursive: true });
  const configPath = path.join(trackerDir, "config.json");
  await fs.writeFile(configPath, "{bad", "utf8");

  const report = await buildDoctorReport({
    runtime: { baseUrl: "https://example" },
    fetch: async () => ({ status: 200 }),
    paths: { trackerDir, configPath },
  });
  const configCheck = report.checks.find((c) => c.id === "fs.config_json");

  assert.equal(configCheck.status, "fail");
  assert.equal(configCheck.critical, true);
});

test("doctor --out writes json to file and stdout", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-doctor-"));
  let restoreHome = () => {};
  const prevCwd = process.cwd();
  const prevFetch = globalThis.fetch;
  const prevWrite = process.stdout.write;
  const prevErr = process.stderr.write;
  const prevExit = process.exitCode;

  try {
    restoreHome = withHome(tmp);
    process.chdir(tmp);
    globalThis.fetch = async () => ({ status: 204 });
    const outCapture = createWriteCapture();
    const errCapture = createWriteCapture();
    process.stdout.write = outCapture.write;
    process.stderr.write = errCapture.write;
    process.exitCode = undefined;

    await cmdDoctor(["--out", "doctor.json"]);

    const out = outCapture.read();
    assert.ok(out.trim().startsWith("{"));
    const payload = JSON.parse(out);
    assert.equal(payload.version, 1);

    const filePayload = JSON.parse(await fs.readFile(path.join(tmp, "doctor.json"), "utf8"));
    assert.equal(filePayload.version, 1);
  } finally {
    process.stdout.write = prevWrite;
    process.stderr.write = prevErr;
    restoreHome();
    process.chdir(prevCwd);
    globalThis.fetch = prevFetch;
    process.exitCode = prevExit;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("doctor sets exitCode on critical failures", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-doctor-"));
  let restoreHome = () => {};
  const prevFetch = globalThis.fetch;
  const prevWrite = process.stdout.write;
  const prevErr = process.stderr.write;
  const prevExit = process.exitCode;

  try {
    restoreHome = withHome(tmp);
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.writeFile(path.join(trackerDir, "config.json"), "{bad", "utf8");
    globalThis.fetch = async () => ({ status: 200 });
    const outCapture = createWriteCapture();
    const errCapture = createWriteCapture();
    process.stdout.write = outCapture.write;
    process.stderr.write = errCapture.write;
    process.exitCode = 0;

    await cmdDoctor(["--json"]);

    assert.equal(process.exitCode, 1);
  } finally {
    process.stdout.write = prevWrite;
    process.stderr.write = prevErr;
    restoreHome();
    globalThis.fetch = prevFetch;
    process.exitCode = prevExit;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("doctor tolerates null config.json payload", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-doctor-"));
  let restoreHome = () => {};
  const prevFetch = globalThis.fetch;
  const prevWrite = process.stdout.write;
  const prevErr = process.stderr.write;
  const prevExit = process.exitCode;

  try {
    restoreHome = withHome(tmp);
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.writeFile(path.join(trackerDir, "config.json"), "null", "utf8");
    globalThis.fetch = async () => ({ status: 200 });
    const outCapture = createWriteCapture();
    const errCapture = createWriteCapture();
    process.stdout.write = outCapture.write;
    process.stderr.write = errCapture.write;
    process.exitCode = 0;

    await cmdDoctor(["--json"]);

    const payload = JSON.parse(outCapture.read());
    assert.equal(payload.version, 1);
  } finally {
    process.stdout.write = prevWrite;
    process.stderr.write = prevErr;
    restoreHome();
    globalThis.fetch = prevFetch;
    process.exitCode = prevExit;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

function createWriteCapture() {
  let out = "";
  return {
    write(chunk, enc, cb) {
      out += typeof chunk === "string" ? chunk : chunk.toString(enc || "utf8");
      if (typeof cb === "function") cb();
      return true;
    },
    read() {
      return out;
    },
  };
}
