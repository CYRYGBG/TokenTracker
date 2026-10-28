const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");

function readTrayContext() {
  return fs
    .readFileSync(path.join(repoRoot, "TokenTrackerWin/TrayApplicationContext.cs"), "utf8")
    .replace(/\r\n/g, "\n");
}

test("personal Windows tray schedules guarded personal update checks", () => {
  const source=readTrayContext();
  assert.match(source, /_updateCheckTimer\.Start\(\)/);
  assert.match(source, /_updateCheckTimer\.Tick.*CheckAsync\(silent: true\)/);
  assert.match(source, /_ = _updateChecker\.CheckAsync\(silent: true\)/);
  const checker = fs.readFileSync(path.join(repoRoot, "TokenTrackerWin/UpdateChecker.cs"), "utf8");
  assert.match(checker, /silent && !AutoUpdatePolicy\.IsEnabled\(\)/);
});

test("periodic update check timer is disposed with the tray context", () => {
  const source = readTrayContext();
  const disposeStart = source.indexOf("protected override void Dispose(bool disposing)");
  assert.notEqual(disposeStart, -1, "Dispose override must exist");
  const dispose = source.slice(disposeStart);

  assert.match(
    dispose,
    /_updateCheckTimer\.Dispose\(\);/,
    "the update check timer must be disposed to avoid leaks after quit",
  );
});
