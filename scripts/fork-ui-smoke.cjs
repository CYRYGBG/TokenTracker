const fs = require("node:fs/promises"),
  assert = require("node:assert/strict"),
  path = require("node:path"),
  os = require("node:os"),
  { fork } = require("node:child_process"),
  { once } = require("node:events");
const repo = path.resolve(__dirname, "..");
const { chromium } = require(
  path.join(repo, "dashboard/node_modules/playwright"),
);
const { createWebDavTestServer } = require(
  path.join(repo, "test/helpers/webdav-server"),
);
(async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-personal-ui-"));
  const dir = path.join(home, ".tokentracker", "tracker");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({ machineId: "ui-machine-aaaa" }),
  );
  await fs.writeFile(
    path.join(dir, "queue.jsonl"),
    JSON.stringify({
      source: "codex",
      model: "gpt-5.4",
      hour_start: "2026-10-26T08:00:00.000Z",
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      billable_total_tokens: 150,
    }) + "\n",
  );
  const dav = createWebDavTestServer();
  await dav.listen();
  const peer = path.join(home, "peer", ".tokentracker", "tracker");
  await fs.mkdir(path.join(peer, "fork-history"), { recursive: true });
  const remoteSession = {
    session_hash: "fixture-windows-session",
    session_id: "fixture-windows-session",
    source: "claude",
    model: "claude-sonnet-4-6",
    title: "Windows 会话验收",
    project_ref: "https://github.com/fixture/shared",
    total_tokens: 60000,
    tokens: { input_tokens: 50000, output_tokens: 10000 },
    started_at: "2026-10-26T08:00:00.000Z",
    ended_at: "2026-10-26T08:05:00.000Z",
    duration_ms: 300000,
    cost_usd: 0.3,
  };
  await fs.writeFile(
    path.join(peer, "config.json"),
    JSON.stringify({ machineId: "ui-windows-bbbb" }),
  );
  const peerBucket = {
    source: remoteSession.source,
    model: remoteSession.model,
    hour_start: remoteSession.started_at,
    ...remoteSession.tokens,
    total_tokens: 60000,
    billable_total_tokens: 60000,
  };
  await fs.writeFile(
    path.join(peer, "queue.jsonl"),
    JSON.stringify(peerBucket) + "\n",
  );
  await fs.writeFile(
    path.join(peer, "project.queue.jsonl"),
    JSON.stringify({
      ...peerBucket,
      project_key: "fixture/shared",
      project_ref: remoteSession.project_ref,
    }) + "\n",
  );
  await fs.writeFile(
    path.join(peer, "fork-history", "session-groups.json"),
    JSON.stringify({ [remoteSession.session_hash]: [remoteSession] }),
  );
  const uploaded = await require("../src/lib/webdav/scheduler").runSyncCycle({
    trackerDir: peer,
    machineId: "ui-windows-bbbb",
    password: "app-password",
    config: {
      url: dav.baseUrl(),
      username: "user",
      directory: "tokentracker-fork",
      device_name: "UI Test Windows",
      enabled: true,
    },
    state: { version: 1, docs: {}, imported: {}, notes: [] },
  });
  assert.equal(uploaded.ok, true);
  const child = fork(path.join(repo, "test/helpers/fork-api-server.cjs"), [], {
    env: {
      ...process.env,
      HOME: home,
      TOKENTRACKER_PERSONAL: "0",
      TT_UI_ASSETS: path.join(repo, "dashboard/dist"),
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let serverErrors = "";
  child.stderr.on("data", (d) => (serverErrors += d));
  const [{ port }] = await once(child, "message");
  const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
  let executablePath = process.env.TOKENTRACKER_BROWSER_EXECUTABLE;
  if (!executablePath) {
    try {
      await fs.access(chromium.executablePath());
    } catch {
      const versions = (await fs.readdir(cache))
        .filter((n) => n.startsWith("chromium_headless_shell-"))
        .sort();
      if (versions.length)
        executablePath = path.join(
          cache,
          versions.at(-1),
          "chrome-headless-shell-mac-arm64/chrome-headless-shell",
        );
    }
  }
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
  } catch (e) {
    child.send("close");
    await once(child, "exit");
    await dav.close();
    await fs.rm(home, { recursive: true, force: true });
    throw e;
  }
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
  });
  await page.addInitScript(() =>
    localStorage.setItem("tokentracker-locale", "zh"),
  );
  const errors = [],
    requests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => requests.push(r.url()));
  try {
    await page.goto(`http://127.0.0.1:${port}/devices`);
    await page
      .getByRole("heading", { name: "同步与设备", exact: true })
      .waitFor();
    await page.getByLabel("服务地址", { exact: true }).fill(dav.baseUrl());
    await page.getByLabel("用户名", { exact: true }).fill("user");
    await page.getByLabel("应用密码", { exact: true }).fill("app-password");
    await page.getByLabel("设备名称", { exact: true }).fill("UI Test Mac");
    await page
      .getByRole("button", { name: "保存并测试连接", exact: true })
      .click();
    await page.getByRole("status").filter({ hasText: "连接成功" }).waitFor();
    await page.getByRole("button", { name: "立即同步", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "同步周期完成" })
      .waitFor();
    await page.getByLabel("厂商", { exact: true }).fill("Codex");
    await page.getByLabel("金额", { exact: true }).fill("20");
    await page.getByRole("button", { name: "添加记录", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "支出已保存" }).waitFor();
    await page.getByRole("cell", { name: "20 USD" }).waitFor();
    await page
      .getByRole("button", { name: "编辑", exact: true })
      .first()
      .click();
    await page.getByLabel("金额", { exact: true }).fill("22");
    await page.getByRole("button", { name: "保存编辑", exact: true }).click();
    await page.getByRole("cell", { name: "22 USD" }).waitFor();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出备份", exact: true }).click();
    const download = await downloadPromise;
    const backupFile = path.join(home, "statistics-backup.json");
    await download.saveAs(backupFile);
    await page.locator("input[type=file]").setInputFiles(backupFile);
    await page
      .getByRole("status")
      .filter({ hasText: "已补回缺失记录" })
      .waitFor();
    await page.reload();
    await page.getByRole("cell", { name: "22 USD" }).waitFor();
    await page.locator("#app-main-content").evaluate((e) => e.scrollTo(0, 0));
    await page.screenshot({
      path: path.join(repo, "docs/fork/evidence/sync-settings.png"),
      fullPage: true,
    });
    await page.locator('a[href="/dashboard"]').first().click();
    await page.waitForTimeout(1600);
    await page.screenshot({
      path: path.join(repo, "docs/fork/evidence/dashboard.png"),
      fullPage: true,
    });
    await page.goto(`http://127.0.0.1:${port}/sessions`);
    await page.waitForTimeout(800);
    await page.getByText("显示已隐藏项", { exact: false }).waitFor();
    const sessionButton = page.getByRole("button", {
      name: /Windows 会话验收/,
    });
    await sessionButton.waitFor();
    await page.getByTitle("ui-windows-bbbb", { exact: true }).waitFor();
    await sessionButton.click();
    await page.getByRole("dialog").waitFor();
    await page.screenshot({
      path: path.join(repo, "docs/fork/evidence/session-detail.png"),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "隐藏", exact: true }).click();
    await sessionButton.waitFor({ state: "hidden" });
    await page.getByRole("checkbox").check();
    await sessionButton.waitFor();
    await page.getByRole("button", { name: "取消隐藏", exact: true }).click();
    await page.getByRole("button", { name: "隐藏", exact: true }).waitFor();
    await page.getByRole("checkbox").uncheck();
    await page
      .getByRole("combobox", { name: "统计范围" })
      .selectOption("local");
    await sessionButton.waitFor({ state: "hidden" });
    await page
      .getByRole("combobox", { name: "统计范围" })
      .selectOption("ui-windows-bbbb");
    await sessionButton.waitFor();
    await page.getByRole("combobox", { name: "统计范围" }).selectOption("all");
    await page.waitForLoadState("networkidle");
    await sessionButton.waitFor();
    await page.screenshot({
      path: path.join(repo, "docs/fork/evidence/sessions.png"),
      fullPage: true,
    });
    if (errors.length) throw new Error(errors.join("\n"));
    const external = [
      ...new Set(
        requests.filter((u) => !u.startsWith(`http://127.0.0.1:${port}`)),
      ),
    ];
    const report = {
      date: new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
      }).format(new Date()),
      browserVersion: browser.version(),
      productionAssets: true,
      realLocalApi: true,
      isolatedHome: true,
      webdav: "local protocol fixture",
      flows: [
        "save settings",
        "test connection",
        "sync now",
        "save and edit expense, reload through API",
        "download backup and restore missing statistics",
        "dashboard route",
        "sessions route",
        "remote WebDAV session visible with device and detail modal",
        "hide, show hidden, unhide through API",
        "local, remote device and all scopes",
      ],
      pageErrors: errors,
      externalRequests: external,
      serverErrors: serverErrors.slice(0, 500),
    };
    await fs.writeFile(
      path.join(repo, "docs/fork/evidence/ui-check.json"),
      JSON.stringify(report, null, 2),
    );
    process.stdout.write(JSON.stringify(report));
  } finally {
    await browser.close();
    child.send("close");
    await once(child, "exit");
    await dav.close();
    await fs.rm(home, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
