# UPSTREAM 跟踪与 Fork 改动地图

## 最新检查点：2026-10-28 Windows 轮（泄漏修复发布前核对）

经代理 fetch 到 `f15b3f643a2df5119724cc77f797ac9aa0cb2052`（#911）。相对上一检查点 `b2c2eb85` 仅新增此一个主线提交：`fix(dashboard): reject partial community metrics cache`，只改 `dashboard/src/hooks/use-community-stats.js` 及其测试。该 hook 在 fork 运行路径中已无存活调用方（引用它的 LeaderboardPage / MarketingLanding 均已移出路由，文件按依赖清理原则保留为死代码），**不采纳**，后续若恢复任何社区统计入口再重新评估。

# 上一检查点：2026-10-28 第二次 ZCode 接续审查

经代理 fetch 到 `b2c2eb8545cee15d517f4fd6e783191c2ba30117`。

- 采纳 `e20958ce`（#902/#888）：原生 ZCode 重置权益倒计时条、网页折叠区、同到期批次提示、五语文案及测试；保留 fork 的可恢复错误提示，折叠时也可见。
- `74254ace` 是 #899 官方账号视图测试，`7dedbeba` 是排行榜修复；相关功能已移除，不采纳。版本发布提交不合入。
- 已审查 `64bbaa5d`（#900）DSH 会话分析。新上游将 `session-<id>` 归一为 `<id>`；fork 已保存并跨设备导出旧身份，直接替换会改变 session_hash，导致新扫描与旧历史重复保留。因此暂缓整体移植，须先设计可恢复的旧身份/远端快照迁移；保留现有 fork-dsh-sessions 对上游解码器的复用。试验夹具通过不代替迁移验收，本轮未改采集、去重和会话存储。
- 独立修复：选择项仅提交字段补丁；设备卡片与下拉共用页面状态、项目请求补 device_id；轮询/文件变化/重启按持久化 last_attempt_at 统一节流；ZCode 缓存按本机账号/套餐/团队指纹隔离，不保存凭证。不恢复官方云功能。

> 记录与上游 [xiufengsun/TokenTracker](https://github.com/xiufengsun/TokenTracker) 的关系：已检查/已合入 SHA、采纳决策、本 fork 各行为的改动位置。
> 每次 fetch upstream、合并、cherry-pick、或大改动落盘后更新本文件。

## 1. 基线记录

| 项目 | SHA | 日期 | 说明 |
|---|---|---|---|
| fork origin/main（克隆时） | `905a54e89b8bf42b0dd19bcd0bfb40d3fca92e3d` | 2026-10-25 | fix(pricing): Kimi K3.1 Pro rates (#875) |
| upstream/main 首次检查 | `b7ae26604241b5dcdbe86fd0c7901e3f4d0d3aeb` | 2026-10-26 | fix(windows): dedicated OAuth login window (#882) |
| 共同基线（merge-base） | `905a54e8` | — | fork 零独有提交 |
| **本 fork 工作基线** | `b7ae2660` | 2026-10-26 | 本地 main 已快进至 upstream HEAD（fork 改动开始前对齐，避免日后冲突） |
| 上次核对时间 | `9dc925d8`（完整 SHA 见末尾） | 2026-10-27 | 经代理再次 fetch；已分项采纳统计、价格和原生修复，未合并发布版本 |

快进时合入的 3 个上游提交（fork 无任何本地改动时直接 ff，无冲突）：
- `72d83158` fix(trae-cn): discover classic "Trae CN" data directory (#881) — 采集器目录发现修复，**采纳**。
- `328f0d41` feat: OpenSquilla usage tracking (#883) — 新采集器（rollout.js +277 行 + 测试），**采纳**（扩展工具支持符合需求）。
- `b7ae2660` fix(windows): dedicated OAuth login window (#882) — Windows OAuth 独立窗口；fork 将移除官方 OAuth，此改动整体退出运行路径，仅在摘取同文件其他修复时注意别带回登录行为。

## 2. 上游改动跟进决策

| 上游领域 | 策略 |
|---|---|
| 采集器（rollout.js 的 `parse*Incremental`）、增量游标、去重、模型识别、Token 归一化 | **优先尽快合入**（fork 核心价值所在） |
| 价格表（curated-overrides.json / seed-snapshot） | **尽快合入**；注意 fork 自有的用户自定义价格层不能被覆盖 |
| 数据修复（repair* / migrations） | 理解依赖与迁移顺序后挑选合入；合入后必测"连续两次采集不重复 + 源日志删除后历史保留" |
| macOS/Windows 兼容与安全修复 | 尽快合入；若触及 fork 已移除的登录/深链代码，只摘修复不带回功能 |
| 官方云/排行榜/支付/遥测相关 | **不合入**（与 fork 定位冲突）；若其中夹带统计修复，手术式摘取 |
| 宠物/皮肤/成就/灵动岛/Skills 修复 | 不合入（功能已删）；夹带通用修复时摘取 |

## 3. Fork 改动地图（2026-10-27）

| 范围 | 当前入口与差异 | 验证 |
|---|---|---|
| CLI / 官方外发断开 | 既有 sync/serve/local-api 云切除保留；无遥测初始化 | Node 回归、生产页面网络检查 |
| 个人身份 | bin/personal.js；tracker-paths/local-api/session-analytics/machine-id/proxy-env；原生标识、scheme、Windows mutex/pipe/安装器 | 隔离 CLI 实际启动，不改旧配置 |
| 后台同步 | webdav/scheduler.js、client.js、credential-store.js；共享实例+进程锁，变更防抖/退避；serve 内生命周期 | 双进程 HTTP 故障及幂等测试 |
| 数据导入 | sync-store/importer.js，校验/白名单/同版本冲突；每 kind 单 JSON 原子提交行+高水位，兼容旧 JSONL | 截断、冲突、回退、备份、写失败 |
| 读取层 / 历史 | fork-store.js / fork-view.js / fork-dsh-sessions.js；local-api 小范围接入，原生范围头；自己远端恢复视图，旧手动导入可共存 | 实际 local-api + 独立进程重启 |
| 项目 / 隐藏 / 支出 | fork-prefs.js；稳定事件 ID + Lamport 序号；session UI 与 ForkSyncPage | 跨设备合并/拆分/隐藏/付款去重 |
| 估值 / 价格 | fork-costs.js；pricing/index.js 新 reload/自定义规则与版本；litellm-fetcher 的 TTL=0 修复及获取时间 | 同进程刷新、离线缓存、历史依据 |
| 元数据备份 | fork-backup.js / /api/fork/backup；浏览器及原生本地导出桥 | 白名单、自身/其他设备恢复、保留现有行 |
| 网页精简 | App、Sidebar、SettingsPage；移除官方 SDK/遥测依赖、云预加载、实验卡 | Dashboard 全量、UI 冒烟、生产构建 |
| 原生精简 | 两端 OAuth 注册/深链/宠物入口断开；Widget target 排除；个人 GitHub 更新渠道（默认自动更新关闭） | CLT 完整 Swift 构建、Windows 自包含 publish、安装器编译；实机层级见 STATUS |

热点统计引擎保留：rollout.js 复用原解析器，增加既有项目解析导出、归档读取诊断与上游 Qoder 格式兼容；sync.js 接入长期明细与首次后台归档回填；session-analytics.js 导出已有 fragment merge，并保留 fork 已保存的会话费用依据；pricing 保留上游匹配、Token 归一化、长上下文/速度/DeepSeek 规则。未重写采集器。

原生代码已有改动不等于实机通过，详细层级见 STATUS.md / ACCEPTANCE.md。历史未接通功能的“计划中”旧地图已移除，避免继续误判。

## 4. 上游可复用资产清单（fork 直接借用，不重写）

| 资产 | 位置 | fork 用途 |
|---|---|---|
| 小时桶 append-only 账本 + "最后一条 per key 胜"读端 | `queue.jsonl` + `src/lib/async-queue-reader.js` | WebDAV 同步的桶级数据载体（整行 upsert、重放幂等——上游云 ingest 已验证的合并语义） |
| 项目×小时桶 | `project.queue.jsonl`（上游本地专用不上传） | fork 将其纳入同步（新导出器，不改上游写入路径） |
| 跨设备导入账本 | `src/lib/local-usage-transfer.js`（v1 schema、sequence 单调、双段确认导入、self_import/snapshot_conflict 检测、≤5MB/100k 行/32 设备） | 格式与状态机参照；fork 的 v2 扩展项目/会话明细，突破其"无明细"限制 |
| 设备身份 | `src/lib/machine-id.js`（config.json 持久 + ~/.config seed，硬件指纹兜底） | 直接复用为设备 ID |
| 账号级去重 | `src/lib/account-usage-dedup.js`（cursor 整行取 MAX；trae-cn 会话级 LWW，`snapshot_verified_at` 严格大于才替换，缺失≠删除） | 多设备同步合并时沿用同语义 |
| 项目识别 | `rollout.js` `resolveProjectMetaForPath`/`canonicalizeProjectRef`（git remote 归一化去凭证，`public_verified` 状态） | 同一仓库跨设备归并的依据 |
| 会话明细 sidecar | `src/lib/session-analytics.js`（`session.queue.jsonl`，v27） | fork 长期明细存储的**上游字段来源**；fork 新增导出层剥离本地敏感字段（title 保留、cwd/绝对路径不导出） |
| 归档扫描 | codex/acode `archived_sessions` 深扫 + 事件级去重（issue #187） | 直接复用 |
| 价格管线 | `src/lib/pricing/`（四级兜底 + curated 优先 + DeepSeek 分时 + 长上下文档 + 速度档） | 全保留，加 reload + 用户覆盖层 |
| 汇率 | `dashboard/src/lib/exchange-rate.ts` + `currency.ts`（open.er-api.com，24h TTL） | 保留 |

## 5. 上游已知问题（与 fork 改动引入的问题区分）

- **serve 内存价格表不自动刷新**：`ensurePricingLoaded` 仅加载一次（`state.loaded` 门控），磁盘缓存更新后常驻进程不感知。上游现状；本轮通过 reload 和 TTL=0 修复，并完成同进程回归。
- **session sidecar 不保留已删除源文件的会话**：sidecar 按发现文件整体重建（5min TTL）。上游现状；fork 的 fork-history 长期明细存储已解决，源删除与重启已回归。
- **queue.jsonl 桶行对"源删除"保留**（append-only 无例行删除，修复有 GUARD）——上游 0.26.3 曾因误清 Claude jsonl 丢 21.7 亿 token 后回滚（sync.js:255-268 注释）。fork 同样不得引入此类清理。
- **`project.queue.jsonl` 无 model 列**——项目视图按 source 聚合不含模型分解，上游现状，fork 同步格式如实沿用（不扩列，避免重写上游聚合）。
- 上游云的 `cloud-usage-reset`（清空设备用量整队列重放）语义与 fork"历史保留"原则冲突——fork 不移植该行为。

## 2026-10-26 接续核对

- 工作区开始时 main / `bc5ad2f0d8e65aebebd223183a5115d27c0c53c4`，无未提交修改。
- 经仓库代理成功 `git fetch upstream`；最新 `8d32a956181bf52fae449c89b8f6520253566283`，相对已检查 `b7ae2660` 仅版本发布 #884。无采集/计价/安全修复需要摘取；暂不整合官方发布版本，保持本地版本三处一致。
- 发现旧地图把尚未移除的 dashboard/native 写为已移除，事实以 ACCEPTANCE.md 为准。

## 2026-10-27 复核

- 跨夜继续工作后再次经仓库代理 `git fetch upstream` 成功。HEAD 仍为 `8d32a956181bf52fae449c89b8f6520253566283`，与前次一致。
- 相对工作基线 `b7ae2660` 只有 #884 发布版本提交；不合并官方发布流程或改动个人版版本。
- 本轮修复上游当前没有对应新提交：常驻价格刷新及 TTL=0、长期会话保留为 fork 独立适配。回归包括连续两次采集、重启、源删除、自己的远端恢复。

## 2026-10-27 ZCode 接续审核后复核

- fetch 到 `9dc925d89e7c526c9d5831b689a8bac427e7d8ea`，本轮固定此检查点，不跟随发布流程。
- 采纳 `2f19cd46` 的 rollout Qoder 格式兼容及针对性回归：credits-only 活动、子代理归属、格式漂移；不抄版本号修改。
- 采纳 `d04b9132` 的旧手动传输与会话筛选 Ultrafast 字段修复及测试；WebDAV 白名单原已保留相关数值字段。
- 采纳 `2e774e82` 的本地 GPT-6.1 Terra 定价和匹配修复，仅引入本地测试，不接回云函数。已对照 [官方模型页](https://developers.openai.com/api/docs/models/gpt-6.1-terra) 与 [官方价格页](https://developers.openai.com/api/docs/pricing) 核对标准价和速度/长上下文规则。
- 采纳 `8b49cd2b` 的 macOS ZCode Reset Credits / Start Plan 模型、文案和面板及测试源；没有恢复官方 TokenTracker 账号功能。
- 暂不采纳 `9f09f6e8`、`e212fd26` 的额外会话骨架/列布局，避免本轮审计夹带页面结构变化；可在后续 UI 任务单独评估。`9dc925d8` 仅发布提交，不采纳。
- 新增 fork 修复：归档回填在 soft-skip 后继续重试；open/stat 失败进入本地诊断台账，台账原子写入。复现从 165 Token 卡住 → 修复后后台恢复 465，连续采集幂等及源缺失保史按相关测试验证。

- 解锁后原生验收修复：菜单栏指标设置退出已移除的小组件页，直接使用官方 SettingsRow/Select 和既有指标归一化；退出时对自有 Node 显式 SIGTERM 并限时等待，最终 DMG 复验宿主/子进程/端口均结束。再次 fetch 仍为上述 SHA。

- 2026-10-27 本机重复图标清理前再次 fetch：upstream/main 仍为 9dc925d89e7c526c9d5831b689a8bac427e7d8ea，无新增主线提交。本轮仅调整构建目录/临时产物清理和对应校验路径，不改采集或已发布二进制。

## 2026-10-28 接续交付

本轮开始再次 fetch，upstream/main 仍为 `9dc925d89e7c526c9d5831b689a8bac427e7d8ea`，没有新主线修复需要移植。复用上游 DeviceUsageCard、菜单栏指标和原生下载/安装流程，增加独立 PersonalUpdateChannel / PersonalUpdateInstaller。首页设备分布此前读取旧手动导入通道而没有接 WebDAV，本轮经 fork-view/local-api 的独立 device-usage 适配恢复。没有改采集器、去重和迁移。

用户明确要求应用内更新后恢复自己的发布渠道：仅 CYRYGBG/TokenTracker、personal-vX.Y.Z 稳定标签、精确资产和必须的 SHA-256。macOS 替换前检查个人 bundle 身份/版本/签名；Windows 复用既有安装 GUID，校验失败不启动安装器。状态栏 Codex/Claude 五小时指标可在未取得额度时配置，不再因可用性筛选而找不到入口。


## 2026-10-28 状态栏故障前核对

再次 fetch 到 upstream/main 0c279d967169232b0cc92d7f170c290f5ebe710a。相对 9dc925d8 仅 #899：让官方账号云视图慢请求在后台完成并填充缓存。个人版已移除官方账号云读取路径，本轮不采纳，未涉及采集/定价/迁移修复。当前故障为 fork 移除账号接口后遗漏修改 macOS 健康检查，已在独立 LocalServerHealth 及 APIClient 最小接线修复，不恢复官方端点。


## 2026-10-28 ZCode 面板修复前核对

再次 fetch，upstream/main 前进到 `4cf3e212`（v1.4.15 发布提交）。相对上次记录 `0c279d96` 新增两项：

- `34397349` fix(limits): Grok 配额池跟随剩余模式（#904，#885 维护者跟进）——上一轮会话已在本工作树独立实现同一修复（provider-specs、web 面板、Swift 视图、五语文案 `limits.grok.shares_are_used`），本轮与上游逐文件比对：实现与文案键**逐字一致**，差异仅为 fork 有意保留的增量（离线提示去官方 CLI 引用、ZCode 重置权益文案、设置页个人版措辞）。无需再合并；后续合并该区域冲突时应以双方同源为准。工作树遗留的一处 `limitRow(productPool:)` 旧签名调用（Start-plan 授权区块）本轮已按上游清理。
- `4cf3e212` 仅 v1.4.15 发布提交，不采纳。

`0c279d96`（#899 官方账号云视图后台完成）维持上轮"不采纳"结论：fork 已无该代码路径。

本轮新增 fork 修复：ZCode 限额磁盘缓存兜底（`zcode-usage-limits-cache.json`，trackerDir 优先同 OpenCode Go）——ZCode 配额端点瞬时失败不再使整个分区从状态栏消失，改为显示上次成功数据并带 `stale` 标记；Swift `ZcodeLimits` 解码 `stale`/`cached_at` 并如 Codex 一样透传数据年龄。未动采集器、去重与迁移。
