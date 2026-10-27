// Reproducible, bounded-concurrency checks. No install, push or release action.
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  cp = require("node:child_process");
const root = path.resolve(__dirname, "..");
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-fork-verification-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const checks = [
  [
    "node-tests",
    process.execPath,
    [
      "--test",
      "--test-concurrency=4",
      ...fs
        .readdirSync(path.join(root, "test"))
        .filter((n) => n.endsWith(".test.js"))
        .sort()
        .map((n) => `test/${n}`),
    ],
  ],
  [
    "dashboard-tests",
    npm,
    [
      "--prefix",
      "dashboard",
      "test",
      "--",
      "--reporter=dot",
      "--maxWorkers=2",
      "--minWorkers=1",
    ],
  ],
  ["typecheck", npm, ["--prefix", "dashboard", "run", "typecheck"]],
  ...[
    "copy",
    "locale",
    "guardrails",
    "versions",
    "ui-hardcode",
    "bot-frames",
  ].map((name) => [`validate-${name}`, npm, ["run", `validate:${name}`]]),
  ["dashboard-build", npm, ["run", "dashboard:build"]],
];
const results = [];
const output = path.join(root, "docs/fork/evidence/local-verification.json");
for (const [name, command, args] of checks) {
  const log = path.join(logDir, `${name}.log`);
  const fd = fs.openSync(log, "w");
  const start = Date.now();
  process.stdout.write(`${name} running\n`);
  const child = cp.spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: ["ignore", fd, fd],
  });
  fs.closeSync(fd);
  const text = fs.readFileSync(log, "utf8");
  const summary = text
    .split("\n")
    .filter(
      (l) =>
        /^ℹ (tests|pass|fail|cancelled|skipped|duration_ms)/.test(l) ||
        /Test Files\s|Tests\s+\d|Duration\s+\d|built in /.test(l),
    )
    .slice(-8);
  results.push({
    name,
    exitCode: child.status,
    signal: child.signal,
    durationMs: Date.now() - start,
    log,
    summary,
  });
  fs.writeFileSync(
    output,
    JSON.stringify(
      { checkedAt: new Date().toISOString(), logDir, results },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(`${name}: ${child.status === 0 ? "PASS" : "FAIL"}\n`);
}
process.exitCode = results.some((r) => r.exitCode !== 0) ? 1 : 0;
