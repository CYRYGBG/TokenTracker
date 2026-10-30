# AGENTS.md — TokenTracker 个人同步版（本仓库唯一权威规范）

> 本文件是本仓库的**唯一权威**项目规范（用户已确认 `CLAUDE.md` 不再使用，其仍适用的内容已并入本文件）。
> **每次任务开始**：先读 `docs/fork/REQUIREMENTS.md`（需求）、`docs/fork/UPSTREAM.md`（上游跟踪+改动地图）、`docs/fork/STATUS.md`（当前状态）。**每次任务结束**：更新 `docs/fork/STATUS.md` 的事实状态（做了什么、验证了什么、下一步、阻塞）。
> 规范冲突时以本文件为准；发现过时内容直接更新本文件。

## 0. 本 fork 是什么

个人使用的 AI 编程用量统计与**多设备同步分析**工具，基于 [xiufengsun/TokenTracker](https://github.com/xiufengsun/TokenTracker) 的 fork（origin = [CYRYGBG/TokenTracker](https://github.com/CYRYGBG/TokenTracker)）。

- **无官方 TokenTracker 账号/云后端**：登录、排行榜、付费云同步、会员、遥测均已移除（见 §2）。
- **多设备同步走用户自己的 WebDAV 网盘**（首个目标坚果云），设计见 `docs/fork/SYNC_DESIGN.md`。
- 平台：macOS（状态栏主入口）+ Windows（托盘）。Linux 非首版目标。
- 核心原则：**沿用上游采集/扫描/去重/计数/定价/项目与会话分析引擎，不重写**。本 fork 的差异 = WebDAV 同步 + 历史明细持久化 + 界面精简 + 实际支出记录。
- 当前主要工具：Codex、ZCode、DeepSeek Harness；但**保留上游全部工具的采集能力**。

## 1. 工作边界（长期有效）

**允许**：本地开发、依赖安装、只读获取 upstream（`git fetch upstream`）、测试、本地构建、本地提交。
**未经用户明确授权禁止**：推送到任何远端、发布 npm 包、创建正式 Release、向原作者仓库写入、操作官方线上后端、向用户分发更新。上游文档中的发布流程（npm publish / DMG / release workflow / Homebrew）**对本 fork 不适用，不得自动执行**。不创建额外定时任务或后台监控服务。

2026-10-27 本轮交付及接续修复明确授权：将本轮审核产物（macOS arm64 / Windows x64）及对应源码快照发布到 `CYRYGBG/TokenTracker` 的 GitHub Release。授权不包含 npm、上游仓库写入、官方渠道更新或覆盖安装；发布分支与标签独立，保留本地既有历史。


2026-10-28 用户本轮新增明确授权：代为将本机 Applications 中的个人版从 1.4.11 覆盖安装为已发布的 1.4.12，保留统计与同步配置并做本地可恢复备份。此项仅限本机个人版安装，不涉及官方应用、数据清理或 npm 发布。

2026-10-30 用户明确授权：按确认的精简预览接入个人周报/月报，同时修复同步成功后顶栏残留失败提示及错误原因不清的问题；验证后推送源码并发布 personal-v1.4.19 的 macOS arm64 / Windows x64 安装包至 CYRYGBG/TokenTracker。继续禁用整个仓库的 GitHub Actions，不覆盖安装本机应用。

**跟进 upstream 的规则（重要）**：

1. 开始新的开发/修复/升级前，先 `git fetch upstream`（需代理，见 §7），与 `UPSTREAM.md` 记录的已检查 SHA 比较；离线时明确记录"未能核对"，不把旧缓存当最新。重点看：采集器（`parse*Incremental`）、扫描路径、增量游标、会话/请求去重、子代理归属、模型识别、缓存/推理 Token 归一化、价格表、数据修复、macOS/Windows 兼容、安全修复。
2. 优先复用上游相关改进，再补 fork 适配。可合并（merge）或挑选（cherry-pick），但需理解依赖顺序；不盲目 cherry-pick 数据修复，也不无条件合并整个 upstream/main。
3. 对已共享/已推送的历史不重写、不 force push。
4. **合并冲突必须保留两方面**：上游统计正确性修复 + 本 fork 的 WebDAV 同步/历史保留/界面精简。不得借解决冲突恢复官方登录/支付/排行榜/遥测，也不得用上游版本覆盖同步模块。
5. 新同步/数据适配/明细存储/fork 配置放**独立模块**（`src/lib/webdav-*`、`src/lib/fork-*`、`src/lib/sync-store*` 等）；对热点统计文件（`sync.js`、`rollout.js`、`local-api.js`、`pricing/`）做最小必要修改。避免无关重排、批量格式化、文件搬迁、抽象重写——降低合并成本。
6. 集成上游改动后跑针对性回归，在 `UPSTREAM.md` 记录 SHA、影响、验证、剩余风险。改采集/去重/迁移后必须验证：**连续两次采集不重复**、**源日志删除后历史保留**。
7. 厂商功能/价格/接口/认证等**公开事实先查代码和官方资料**，不问用户；只有用户自己的使用偏好才问用户。

## 2. 已移除的官方功能（不得借合并恢复）

官方注册/登录/OAuth/设备授权（`device-login`、`cloud-account`、InsForge SDK）、排行榜/点赞/公开主页、付费云同步/会员/兑换码/支付（billing/checkout）、Skills 管理器、宠物/皮肤/成就/灵动岛装饰体验（若上游后续修复统计核心波及相关文件，摘取修复时保持本 fork 的移除状态）、官方心跳/遥测/PostHog/默认 Sentry、自部署向导、IP 检测页、官方 statuspage 引用。独立桌面小组件首版不纳入（状态栏/托盘不是小组件）。

移除原则：成品入口与运行路径真正去掉（路由/导航/启动钩子/后台任务/原生菜单/深链/构建依赖/默认网络请求）；历史 SQL、素材、辅助脚本按依赖清理，不必一次性清空，但不得在构建或运行时意外启用。本地 API 的接口安全校验保留。

**唯一会把用量发往官方云的路径**曾是 `src/commands/sync.js` 的 `drainQueueToCloud()`（需 deviceToken）与 `telemetry.js` 心跳——fork 中已断开；任何改动不得重新接通。允许保留的联网功能：LiteLLM 价格表（`raw.githubusercontent.com/BerriAI/litellm`）、厂商额度查询（anthropic/chatgpt/qoder/zcode 等官方端点）、汇率（open.er-api.com）、各厂商 status 页。

## 3. 项目结构（继承上游，仍准确）

- **CLI**（`src/`，CommonJS，Node ≥20）：个人入口 `bin/personal.js` → `bin/tracker.js` → `src/cli.js`，默认 :17680，数据在 `~/.tokentracker-personal/tracker/`。直接运行兼容入口且未设 `TOKENTRACKER_PERSONAL=1` 时仍沿用旧目录与 :7680；个人版日常使用必须走 personal.js。
- **Dashboard**（`dashboard/`，React 18 + Vite 7 + TS strict + Tailwind）：构建到 `dashboard/dist/`，由本地 serve 提供。
- **macOS app**（`TokenTrackerBar/`，Swift 5.9 + XcodeGen）：菜单栏 +（首版排除的 WidgetKit target）。`EmbeddedServer/` 打包 CLI 运行时 + dashboard，gitignored，按需 `TokenTrackerBar/scripts/bundle-node.sh` 构建。
- **Windows app**（`TokenTrackerWin/`，.NET 8 WinForms + WPF + WebView2）：系统托盘。动态回环端口起 bundled CLI serve，WebView2 承载 dashboard。dashboard 适配以 `isNativeWindowsApp()`（`dashboard/src/lib/native-bridge.js`）门控。
- **Linux**（`TokenTrackerLinux/`，Tauri）：非首版目标，不主动投入。

数据流：AI CLI 运行 → hook 触发 → `rollout.js` 解析 → `queue.jsonl` → 本地 API → dashboard。

支持的 provider 权威清单：grep `parse*Incremental` in `src/lib/rollout.js`（不是本文件）。

## 4. 常用命令

```bash
npm test                                  # node --test test/*.test.js
node --test test/<name>.test.js           # 单个测试文件
npm run ci:local                          # tests + validations + dashboard build（fork 中发布相关校验按需跳过）
npm run dashboard:dev                     # Vite dev（本地 API mock，5173）
npm run dashboard:build                   # 构建到 dashboard/dist/
node bin/personal.js serve --no-open      # 个人版服务 :17680，独立数据目录
```

`npm run dashboard:dev` 无 CLI 后端；验证 `src/` 改动用隔离 HOME 或 `node bin/personal.js serve`；不使用运行中的官方应用作为测试后端。

## 5. 承重约定（Load-bearing conventions）

### Token 归一化（不得违反）

```
input_tokens                = 非缓存输入（不含缓存读写）
cached_input_tokens         = cache 读
cache_creation_input_tokens = cache 写
reasoning_output_tokens     = 推理（Codex/acode/every-code/OmO/Cline/Muse 已折叠进 output_tokens 计费）
total_tokens                = input + output + cache_creation + cache_read（+reasoning 当 output 不含它时）
```

**成本只由 `input_tokens + output_tokens + cached_input_tokens + cache_creation_input_tokens + reasoning_output_tokens` 计算，绝不用 `total_tokens`**（`computeRowCost` in `src/lib/pricing/index.js`）。若新 provider 只填 `total_tokens`，dashboard 会显示 $0 成本。

### Queue entry（上游格式，保持兼容）

UTC、半小时桶、append-only；读取方按 `(source, model, hour_start)` 取最新条目。结构见 `docs/fork/SYNC_DESIGN.md` 与 `src/commands/sync.js`。

### 项目约定

- `src/` 用 CommonJS；`dashboard/` 用 ESM + TS strict。不混用。
- 环境变量前缀：CLI 用 `TOKENTRACKER_`，dashboard 用 `VITE_`。
- Git 提交信息用英文、conventional 风格（`feat:`/`fix:`/`refactor:`/`chore:`/`docs:`/`test:`）。
- **隐私**：只有 token 计数与统计元数据——绝不采集/同步提示词、消息、对话正文、代码、凭证（fork 同步字段白名单见 SYNC_DESIGN.md）。
- `TokenTrackerBar/EmbeddedServer/` gitignored；改 `TokenTrackerBar/project.yml` 后跑 `(cd TokenTrackerBar && xcodegen generate && ruby scripts/patch-pbxproj-icon.rb)`。

### 解析器正确性（上游经验，长期有效）

- 去重用 `claudeMessageDedupKey()`；裸 `if (msgId && reqId)` 在 DeepSeek/Kimi/Mimo/MiniMax/Claude 子代理上会放开去重、多计 1.6–3.7×。
- 不要盲信 `input_tokens` 语义：Codex/every-code 的 `input` 含 cached tokens，直接拷贝会多计 6–7× 成本。上线前用原始 usage + 厂商账单核对。
- `contextTokensUsed` 类字段通常是快照不是累计值。
- Mimo (mimocode) 把 Claude Code 历史镜像进自己的 SQLite：`readMimoDbMessages()` 只保留 `providerID` 为 `mimo`/`xiaomi` 的行，丢弃 `anthropic`（含在 Claude Code 里跑的 mimo 模型），否则重复计数。
- 动数据迁移的版本：改 `sync.js`/cursor schema 后**连续跑两次 sync** 做压力测试——第二次暴露第一次隐藏的状态污染。

### Native ↔ web bridge

```
JS → window.webkit.messageHandlers.nativeBridge.postMessage({ type, key?, value?, name? })
Swift → NativeBridge.shared.handle(message:) → evaluateJavaScript("window.dispatchEvent(new CustomEvent('native:settings', { detail }))")
React → useNativeSettings() 订阅
```

`SMAppService.mainApp.register/unregister` 后调 `launchAtLoginManager.refresh()`。

### Dashboard 布局

- `AppLayout` 包裹的页面外层用 `flex flex-col flex-1`（不是 `min-h-screen` + 自己的 sticky header/footer）。
- `AnimatePresence` 高度动画容器内的输入框用 `focus:ring-inset`（否则阴影焦点环被裁剪）。

### 与子代理协作

子代理完成后**用直接读文件验证状态**，不轻信摘要消息。

## 6. 文档体系（docs/fork/）

| 文档 | 内容 |
|---|---|
| `docs/fork/REQUIREMENTS.md` | 确认的功能范围、删除项、数据语义、验收标准 |
| `docs/fork/SYNC_DESIGN.md` | 同步数据模型、WebDAV 布局、身份、版本规则、恢复策略、凭证边界 |
| `docs/fork/UPSTREAM.md` | 上游 SHA 记录、采纳/暂不采纳决策、fork 改动地图 |
| `docs/fork/STATUS.md` | 当前阶段、已完成、下一步、阻塞、测试结果、未验证项 |
| `docs/fork/ACCEPTANCE.md` | 逐项验收状态及证据 |
| `docs/fork/README.md` | 安全启动、迁移、原生与真实网盘验收步骤 |

上游 `docs/` 中关于云后端运营（cloud-*、self-hosting、billing operations）的文档对本 fork 仅作历史参考。`DESIGN.md`、`PRODUCT.md` 中与官方云相关部分已被本 fork §0–§2 取代。

## 7. 本机环境事实

- GitHub 直连超时；git 与 npm（原生模块下载）都需代理 `127.0.0.1:7897`（本仓库 git 已配置 `http.proxy`；npm 用环境变量 `HTTP_PROXY/HTTPS_PROXY`）。
- 开发机：macOS arm64，Node 25。无完整 Xcode和 Windows 实机；可用 CLT 的 swiftc 完整编译 macOS app（`python3 scripts/build-personal-macos.py`）。.NET 8 已补 WindowsDesktop targets，可跨平台 publish；Inno Setup 6.7.3 可在隔离 CrossOver bottle 编译安装器。构建通过不等于 Windows 实机通过；macOS 产物为个人 ad-hoc 签名，未做开发者公证。
- 版本三处同步（package.json / project.yml / csproj）规则保留，但**不触发任何发布动作**；fork 版本策略见 STATUS.md。

## 8. 上游发布流程的关系（必读）

上游 `CLAUDE.md`（现仅作上游历史参考，见根目录指针文件）描述的 npm publish + release workflow + Homebrew 流程属于**官方分发渠道**，本 fork **永不自动执行**。官方更新渠道已切断。2026-10-28 用户要求恢复应用内更新：个人版只允许 CYRYGBG/TokenTracker 的 personal-vX.Y.Z 稳定发布，严格匹配平台安装包并校验 SHA256SUMS.txt。默认不自动更新，用户可主动开启；应用存活期间的检查计时器不创建外部后台服务。旧 1.4.11 需先手动覆盖安装一次。
