# 接续提示词：完成 TokenTracker 个人版 1.5.0，六项改进与双平台发布

请接手本仓库已有工作，完成下面所有改进、自我验收、构建与正式发布。不要仅交计划、截图、代码或单个平台安装包。用户已经明确授权本轮向 **CYRYGBG/TokenTracker** 推送源码、创建 `personal-v1.5.0` 稳定 Release 并通过个人版应用内更新交付 macOS arm64 和 Windows x64；不需要再次询问是否发布。不要写 upstream、发布 npm、恢复官方云/账号/遥测/装饰功能、操作 Actions 开关、覆盖安装本机应用或清理用户数据。

本轮最终交付后，原对话将独立抽查源码、测试与公开发布证据。因此请留下可重跑的验收命令和结构化证据，而不是仅声称“全部完成”。本提示词是用户认可的六项范围；新增的无关产品功能和其他上游提交不应借机混入。

## 0. 先确认现场，不能重置工作区

- Mac 仓库：`/Users/chenyingrui/Code/Token Tracker`。
- 分支：`codex/personal-release-20261027`；交接时 HEAD：`4cffe4ac69f0913079302080ad124187ad1d9022`。
- 已发布最新为 `personal-v1.4.20`，本机 Applications 也已经运行 1.4.20。本轮目标 **1.5.0**，个人版版本号独立于上游 1.5.2。
- 先阅读 `AGENTS.md`、`docs/fork/REQUIREMENTS.md`、`UPSTREAM.md`、`STATUS.md`、`SYNC_DESIGN.md`、`PERFORMANCE_PLAN.md`、`PLAN-1.5.0.md`。根 `CLAUDE.md` 不再是权威规范。
- 先看 `git status --short` 和实际 diff。下面代码是**未提交、未推送**的工作，不在 HEAD 中。不要 `reset --hard`、`clean`、覆盖这些文件，也不要误以为工作区已完成。若在另一台机器工作，必须先取得这些未提交改动（包括未跟踪文件），不能仅 checkout 这个 SHA 后宣称已接续。
- 经代理 `git fetch upstream && git fetch origin`。上次核对 upstream 为 `a9ef316fbe58cf594dbefa7cdbfd5f71cfa212f1`；新提交只核对相关部分，不无条件 merge upstream/main。共享分支不 force push、不重写历史。若 origin 有新提交，先理解并安全整合。
- git 已配代理；GitHub/npm 下载需 `HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897`。可用 gh：`/Users/chenyingrui/conda_root/bin/gh`。不要输出 token、完整环境、凭证或用户源日志正文。
- Mac 可 CLT 构建 Swift app；Windows 可 .NET 自包含交叉构建，Inno Setup 在已有隔离 CrossOver bottle 中运行。具体可靠命令优先读上一版构建脚本、README、证据及本机工具，不凭记忆猜参数。不启用 CI 绕过本地问题。

### 已做但未提交的准确状态

1. 上游 `0258ac0b225f48eddcf8d6f872a0fc63028f645e` 已按文件摘取到：
   - `src/lib/codex-rollout-parser.js`
   - `src/lib/codex-usage-record.js`
   - `src/lib/rollout.js`
   - `src/lib/session-analytics.js`（手工适配，保留 fork 不同的 DSH 路径）
   - 新测试 `test/codex-session-ledger-parity.test.js`、`test/codex-observed-model-attribution.test.js`
   定向命令 `node --test test/codex-session-ledger-parity.test.js test/codex-observed-model-attribution.test.js test/fork-session-worker.test.js` 已 **11 项通过**。这不等于升级/远端历史迁移已验收。
2. `src/lib/fork-journal.js` 是刚写的**增量存储原型**，`src/lib/fork-store.js` 已初步接入。原型大致为旧 JSON 基线 + `.journal` 校验追加事务、跨进程锁、定期压实、读取缓存。**尚未评审完成，未写专门的大文件/中断/并发测试，不可直接发布**。
3. 初步存储接入后执行：
   `node --test test/fork-prefs-pricing.test.js test/fork-session-worker.test.js test/fork-end-to-end.test.js test/webdav-sync-store.test.js test/webdav-two-device-sync.test.js`
   共 **31 项通过**，日志 `/tmp/tt-150-store-initial.log`。这些夹具大多很小，不足以证明超过 256 KiB 的日志分支正确。
4. 计划文件是新建的 `docs/fork/PLAN-1.5.0.md`；STATUS 只记录此前只读调查，尚未标记本次交付。版本仍为 1.4.20。**其余四项和大部分存储/增量同步尚未实现；未构建、未创建 1.5.0 Release。**

## 1. 修复 Codex 会话与首页账本的一致性

### 要改什么

沿用上述上游修复：会话统计使用 ledgerUsage 语义、正确处理 fork 继承前缀、total-only legacy usage、reset sentinel、时间戳去重及模型归属；只使 Codex 缓存失效，不强制重扫所有 provider。保留个人版已有 ZCode 元数据 SQL、Node 只读优先、Harness 缓存、工作线程、价格冻结与历史保留。

### 自验标准

- 新增上游测试及当前相关解析/分析回归全绿；不以修改期望值掩盖失败。
- 同日/跨日 fork、重复副本、计数重置、只有 total 的旧事件等合成输入，**同一统计范围、同一可比口径**的首页账本与会话总数相等；模型分布也正确。不把跨设备求和与单会话去重强行混为一种口径。
- 重复采集两次结果不累计翻倍；缓存升级后再读/重启不回到旧计数；其他 provider 缓存不无故失效。
- 源记录可读时，修订写回 fork 长期历史并向远端发送整行向下修订；源记录已删除时保留原有历史，不冒充成功重算。费用保持既有“用量修订才更新估值、单独刷新价格不改历史估值”的语义。
- 验证本地/远端、旧缓存升级与源删保史，不能只通过 parser 单测就完成本项。

## 2. 减少整份历史文件反复重写

### 要改什么

调查窗口中，1.4.20 后台 Node 121.2 秒实际读取约 362 MiB、写入约 40.6 MiB，期间发生自动采集/同步并有工具持续使用，不能当成稳定空闲速率或每日耗电。主要可改路径：约 8.7 MB 的 sessions、约 8.7 MB 的 session-groups、约 6.4 MB 的 wire-sessions，以及费用依据/导入视图等，每次少量修订可能重写完整 JSON。

完成或替换现有 journal 原型，使用独立 fork 模块，不重写上游采集引擎。优先消除多份大历史快照的全量写入；无变化不落盘，少量变化只写变化记录，积累后有界压实。必要时优化 upstream sidecar 的无变化写入，但不要为了改它破坏上游格式/缓存。

### 原型必须额外检查

- 事务读取—修改—提交必须在**同一个跨进程锁**中。给最终 write 加锁不等于整个更新原子；检查 fork-costs、fork-view、backup restore、importer 和 retain 的所有调用方，避免两进程旧快照相互覆盖。进程内 serial 与跨进程锁不能产生重入死锁。
- 数组重排、重复键、显式替换与“源缺失保留”语义需明确；不能让通用 durable.write 静默改变原有语义。
- 缓存键必须识别原子替换、同大小重写、纳秒时间、journal 尾部及压实；缓存有内存上限，不返回可被调用方污染的共享可变对象。
- 部分末尾事务不视为提交；下次写入安全处理断尾。完整事务损坏需明确报错并保留可恢复状态，不能悄悄当空历史。单条记录/总日志应有适当预算。
- 压实时先提交新基线再清日志的每个中断点、并发读新旧文件组合都要测试；不能丢最后一次更新。原子重命名/flush/目录持久化要求按平台验证，不能仅依赖代码注释。
- 所有读端、备份/恢复、远端导入、重装恢复均能读取最新逻辑视图。旧 JSON 留作基线后，不能仍用直接 readFile(JSON) 的入口读到过时数据；备份须包含 journal 中的新修订。
- 升级不修改用户的 AI 源数据库/索引，不新建外部服务。保留旧 JSON 可恢复基线。需说明旧应用回退只看到最后基线的限制，并提供可验证的导出/压实恢复办法；不要让用户静默丢失新版期间的历史。

### 自验标准

- 至少一个 **≥10 MB** 合成历史夹具：一次只改一条记录，提交后读取完全正确，源删除/缺失不减历史；第二次相同输入零新增数据写入。
- 在未达到压实阈值时，新增磁盘内容按变化量增长，不能再每次新增一份 10 MB 全量快照。记录多次小变更的总写入、压实次数与压实后大小，平均开销也须优于原始全量写法。
- 重启/第二进程/两个并发 writer/读写竞争/故障中断/断尾/校验损坏/原子替换/备份往返/旧数据首次升级都有真实测试；有向下修订和丢失源记录的夹具。
- 原测试通过外，还需专门证明原型日志分支被覆盖。不能降低阈值只让测试通过后忘记验证生产默认阈值。

## 3. WebDAV seg 真正只上传变化行

### 要改什么

`src/lib/webdav/scheduler.js` 目前将 retain 后完整 rows 直接放进 seg；`src/lib/sync-store/exporter.js` 的 `diffRowsByKey` 只有测试调用。接入相对**上次成功发布内容**的逐行差异：base 仍全量，seg 仅包含新增/修订整行，缺失键不删除，允许向下修订。四个 kind（buckets/projects/sessions/prefs）都适用。

不能把“本地已观察快照”当“上次成功上传快照”：失败重试、进程中断以及上传已成功但本地状态未提交时，都不能漏传。必要时加独立成功发布基线/清单，并保留现有 own-remote restore/rebase 安全路径。

### 自验标准

- N 条历史仅改 1 条：seg header.rows=1，载荷仅该条；零变化零上传；首次/阈值/恢复时 base 仍含完整历史。
- 上传中断/服务端失败后重试，未上传的修订仍会发送；发布后本地提交前崩溃，可从远端恢复而不倒退或覆盖新值。
- 混用旧版“全量 seg”和新版“差异 seg”可收敛；**fork_sync:1、文件名、hash、自校验及 since_seq 链保持兼容**。用 1.4.20 读端测试新文件，不靠猜测宣称兼容。
- 两设备往返、多段、缺前驱、重复导入、乱序/旧 base、账号级去重、源删保史、向下修订、重新安装/旧备份恢复、20 段压 base 和自身清理都覆盖。
- 记录真实序列化载荷大小对照，不承诺未经测量的网速/耗电改善。

## 4. 共享读取与报表计算

### 要改什么

- `local-api.js` 的 scopedQueueRows 在个人版先读 async queue cache，然后又通过 fork-view→exporter 同步全读 queue，消除这个重复路径，复用成熟异步读取与归一化。
- fork-view 的 buckets/projects/preferences/remote 与 deviceUsage 重复读多份相同文件；deviceUsage 目前按设备再次调用 buckets，再额外读 all。用同一一致性快照分组计算，不能漏掉账号级来源的去重。
- `dashboard/src/hooks/use-fork-report.js` 一次刷新发 6 个请求，分别重新读取和聚合同一数据。可采用个人报表聚合接口或共享快照/在途工作，接口和方案由你选择；结果应一致，不改用户认可的简洁前端风格。

### 自验标准

- 用读取/解析/聚合次数或明确采样证明合并生效，不能仅改成 Promise.all（现在本来就是并行请求）。一次报表刷新不再走六条独立全历史解析链。
- 缓存更新后及时失效；同大小改写、文件替换、设备新增、同步导入、偏好/别名/自定义价格变化均可见；失败不能缓存成成功或返回旧设备范围。
- 周/月、同期、日边界、时区、跨设备筛选、未归属项目、空数据、失败/部分同步等，结果与优化前同输入的结果一致；切换周期竞态不会覆盖新结果。
- 页面离开/隐藏后不发无意义请求，回前台可更新；不修改现有 UI 文案、布局、颜色和用户已要求删除的说明文字。

## 5. 停掉无消费者动画与反复凭证读取

### 要改什么

- `StatusBarController.swift` 的文字额度模式只设 animator.updatesButton=false，MenuBarAnimator 仍有眨眼/动画/冲刺 timer。没有有效图标消费者时停止对应 timer/绘制/通知，显示切换时恢复正确当前状态。不可恢复宠物/灵动岛入口，不能暂停五小时限额刷新。
- `/api/webdav/status`→webdavStatusSummary 每次读取系统密码只为了 Boolean 存在性；同步设置页可见时每 15 秒调用。改成不反复解密密码的存在性查询/有界状态缓存，Windows 不为每次轮询启动 PowerShell。真正同步时仍按系统凭证存储读取，缓存错误不永久阻断恢复。

### 自验标准

- 文字额度/窗口关闭、无图标消费者时装饰动画 timer 不运行；额度仍更新、队列活动仍采集、用户点击可打开面板。图标模式恢复、reduce-motion、断连/同步状态切换均正确。
- 连续状态轮询不会每次启动 security/PowerShell 或读取密码明文；保存、清除、地址/用户名变化立即失效，凭证存储临时错误可重试；不额外持久化明文、不输出 secrets。
- 前端只显示原有同步状态，继续保留草稿、同步完成事件和顶栏状态更新。不要把 ForkScope 的首页轮询误认为也在查询凭证。

## 6. 失败恢复与应用内更新可靠性

### 同步重试

正常间隔与失败退避分离：用户设 30 分钟同步间隔，首次网络失败若退避 1 分钟，就应在退避到期附近重试，而不是还等 30 分钟。后续 5/15/60 分钟与 Retry-After 按已有规则；401/403 暂停自动，手动重试仍可用；成功后恢复正常间隔。所有轮询、文件触发、重启、手动操作仍共用单轮互斥，不出现多条后台循环。

- 虚拟时钟验证 30 分钟/24 小时配置下，1/5/15/60 分钟退避实际触发；尊重 Retry-After、认证暂停，手动同步不制造并发；重启后退避仍正确。
- 网络/HTTP/正文超时分类仍明确，单请求 180 秒不回退至 30 秒；错误/404 的 GET、PROPFIND 响应正文也正确释放，不遗留连接资源。

### Mac 更新回退

参考上游 `7e65d770fec7bf3541549f5d101bd946a4fcff13` 的限流识别、冷却和网页回退，适配当前个人版 UpdateChecker，不直接复制其官方仓库/官方文件名。Windows 已有回退，检查与个人版规则一致。

- 正常 API、带证据的 403/429、普通 403、Retry-After 秒/日期、reset 时间、冷却重试、fallback 失败、错误重定向均有可执行测试。
- 回退只能识别 **CYRYGBG/TokenTracker 的 personal-vX.Y.Z 稳定 tag**；只匹配当前平台个人安装包，同时从该 tag 获取 SHA256SUMS 并验证下载字节。严格拒绝上游仓库、其他 host、凭证 URL、query/fragment、预发布、错误资产、错误 checksum。
- fallback 和 API 路径同样校验 checksum/包身份，不通过放宽验证换取“能更新”。继续默认不自动更新。

## 7. 全量自验与性能证据

顺序：每阶段定向验收 → 整合回归 → 固定构建提交 → 双平台构建 → 草稿资产核对 → 正式发布 → 公开更新通道核对。

- Node 全量：`node --test --test-concurrency=2 test/*.test.js`。1.4.20 基线为 3737（3720 pass/17 skip）；新增测试应使数量合理变化。报告实际数字、skip 原因和日志路径；不能只跑定向测试、删掉失败用例或无故放宽断言。
- Dashboard：在 dashboard 目录跑 Vitest 全量，可用 `--maxWorkers=2 --minWorkers=1`；跑 typecheck。根目录 validate:copy / locale / ui-hardcode / guardrails / versions / bot-frames；生产 dashboard build。
- Mac 原生改动要真实编译。CLT 可用 Swift harness 测试纯逻辑；不要将无法运行 Xcode XCTest 谎称通过。更新限流与动画生命周期需有可执行验证或清晰原生实测证据。
- Windows .NET 更新/逻辑测试及 Windows 打包 Node 22 定向回归；现有 Wine/CrossOver 能证明的范围按实际写。没有 Windows 实机时明确标注安装/GUI/常驻未实机验收。
- 使用隔离 HOME、临时数据、合成大历史/模拟 WebDAV；不得修改本机真实采集历史、源数据库或真实网盘做破坏性实验。
- 性能至少比较无源变化、单条修订、连续小变更、报表刷新、两设备同步五类场景的写入字节/请求与解析次数/耗时；报告测量范围、冷暖缓存、压实摊销与内存上限。不能拿旧版 dirty-memory 的 8.6GB 当 SSD 实写对照；不能外推节省多少电池。
- 性能前后必须使用同输入比较统计结果/哈希，不能以漏收数据、降频、关闭额度/自动同步实现“优化”。

## 8. 1.5.0 双平台正式发布

- 三平台受管版本元数据按现有 sync-versions/validate 更新为 1.5.0，实际只分发 macOS arm64 / Windows x64。计划及文档进度必须与事实同步，不把原型或未验证项勾成完成。
- 公开源码提交之前，检查未跟踪的新模块/测试都进入 Git；不要遗漏 fork-journal。更新 UPSTREAM 的采纳 SHA/改动地图和 SYNC_DESIGN 中 seg 与本地存储的过时说明。
- macOS 正常链路：`npm run dashboard:build`、`bash TokenTrackerBar/scripts/bundle-node.sh --arch arm64`、`python3 scripts/build-personal-macos.py`。如改 project.yml，按 AGENTS 要求 xcodegen generate + patch-pbxproj-icon。最终产物 `dist/reviewed/TokenTrackerPersonal-macOS-arm64.dmg`，保留 macos-build.json。
- Windows 正常链路以现有脚本/上一版证据为准：自包含 win-x64 publish + Node/dashboard 打包 + Inno Setup，产物 `TokenTrackerPersonal-Windows-x64-Setup.exe`，保留 windows-build.json。
- **dist 中现有安装包是 1.4.20，不能改文件名冒充 1.5.0。** 两端包内版本、打包源码清单与 SourceRevision/构建清单需匹配同一个已提交源码 SHA。发布前确认该分支 tip 仍为所构建的提交；如果代码有变动，应重建对应产物。发布后的证据文档提交可以另行跟进，但不能移动已发布 tag。
- 发布目标仅 `CYRYGBG/TokenTracker`，tag `personal-v1.5.0`。先用 draft 放两包和标准两行 `SHA256SUMS.txt`，确认无私人数据/日志/截图；全部验证后发布稳定版并设 latest。
- 正式发布后检查：远端三资产 digest/大小等于本地；两平台包及校验文件匿名下载可用（HEAD 200），公开校验文件内容一致；`releases/latest` 指向 1.5.0。
- 用 1.4.20 原有 Mac/Windows 个人更新通道代码核对公开 1.5.0，证明旧版能发现新版本、选对平台并验证 checksum。Mac 允许点击“检查更新”验证提示，但用户未要求本轮覆盖安装，不替用户点击安装。用新的限流故障夹具证明升级后 fallback 有效；未发布时不能伪称公网限流回退已经实测。
- 失败如实记录，不能只发其中一包后声称双平台交付。若遇真实阻塞，尽量完成独立工作，并留下准确原因和可恢复现场，不虚构 Windows 实机或 72h 观察。

## 9. 给原对话的最终复核材料（必交）

写入 `docs/fork/evidence/release-1.5.0.json`、`local-verification-1.5.0.json`、`performance-1.5.0.json`、`update-channel-1.5.0.json` 及两平台构建清单（可遵循既有证据格式）。内容至少包括：

1. 六项需求逐项映射：改动文件、实现方式、验收命令/测试名、通过结果及证据路径；不支持/未验收项明确列出。
2. 精确构建源码 SHA、发布分支、tag SHA、Release URL/ID、两包及 SHA256SUMS 的 SHA256/大小与远端比对结果。
3. 全量测试数量、失败修复过程、跳过原因、原生及实际打包运行时验证范围；本地日志可留 ignored 目录，公开证据不含私人来源/对话正文/凭证。
4. 大历史单条修订、反复无变化、真实差异 seg、上传失败重试、双设备/旧版兼容、缓存失效、凭证子进程次数、动画 timer、重试时间线、更新限流回退的可重跑证据。
5. 升级/回退/备份恢复说明；已知限制与尚未实机完成的 Windows/长期能耗项。

最终回复请简要给出：已发布版本与下载页、六项完成情况、核心性能数据、已知限制、证据文件及源码 SHA。只有实际完成双平台公开发布并验证个人版更新入口后，才写“交付完成”。不要自动向原对话发消息；把结果回给用户，由用户带回原对话复核即可。
