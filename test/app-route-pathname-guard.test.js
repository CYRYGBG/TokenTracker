const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { transform } = require("esbuild");

const repoRoot = path.join(__dirname, "..");

async function parseDashboardFile(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  const source = fs.readFileSync(absolutePath, "utf8");
  await transform(source, {
    loader: "jsx",
    sourcefile: relativePath,
  });
}

test("App.jsx parses without duplicate identifier errors", async () => {
  await assert.doesNotReject(parseDashboardFile("dashboard/src/App.jsx"));
});

test("personal fork exposes local statistical routes without retired product pages", () => {
  const source = fs.readFileSync(path.join(repoRoot, "dashboard/src/App.jsx"), "utf8");
  for (const route of ['/dashboard','/sessions','/limits','/settings','/devices']) assert.ok(source.includes(route));
  for (const page of ['LoginPage','LeaderboardPage','CloudCheckoutPage','PetPage','SkillsPage','WidgetsPage','Analytics','SpeedInsights']) assert.ok(!source.includes(page),page);
});
