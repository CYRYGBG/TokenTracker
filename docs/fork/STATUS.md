# STATUS — 个人同步版事实状态

## 2026-10-31 personal-v1.5.0 六项改进实现完成(实现与验证事实;构建/发布状态见下文后续条目)

本节记录接续实现对话完成的六项改进与同步失败修复。上游核对:经代理 fetch,upstream/main 仍为 `a9ef316fbe58cf594dbefa7cdbfd5f71cfa212f1`;origin 同名分支无新增;origin/main 的 5 个 CI 探测提交不纳入。版本已三处受管同步为 1.5.0(sync-versions/validate 过)。

**1. Codex 会话与首页账本一致性**:按文件摘取 upstream `0258ac0b`(codex-rollout-parser/codex-usage-record/rollout/session-analytics,session-analytics 手工适配保留 fork DSH 路径);reset sentinel 谓词移入 codex-usage-record.js 单份共享;session ledger 模式(ledgerUsage)处理 fork 继承前缀、total-only 旧事件、时间戳去重、observed 模型归属(hourly cursor modelAttributionPolicy,含对齐行的零行收回);Codex 摘要缓存经 `codex_usage_version` 单独失效,其他 provider 缓存不动。验收:`codex-session-ledger-parity`(同日/跨日 fork、重复副本、total-only、缓存升级/重启)与 `codex-observed-model-attribution`(跨模型切换/重启/inode 重扫/默认策略不变/对齐收回)全绿;集成验证 `codex-session-revision.test.js` 证明修订写回 fork 长期历史、随 seg 整行向下修订、费用仅因用量修订重冻结、源删保史、无变化周期零重发。

**2. 本地增量存储(fork-journal.js 定稿)**:≥256 KiB 的 fork-cost-basis/session-groups/sessions/wire-*/imports-recovery envelope 走"旧 JSON 基线 + `.journal` SHA-256 校验追加事务(仅变化行)";无变化不落盘(此前旧版无变化也整写 10.15 MB/次);单事务达 max(1 MiB, base/2) 预算直接重写基线,避免"先追加再压实"双写;压实先原子提交新基线再清日志,中断可幂等重放;断尾追加不算提交、下次写入在锁内截断;完整记录损坏读取显式报错(FORK_JOURNAL_CORRUPT)、下次写入隔离 `.journal.corrupt-*` 并从基线自愈;读-改-提交统一进单一跨进程锁(fork-store update/withTransaction,多文件按全局排序加锁),fork-costs/fork-view collectSessions/backup restore/importer/fork-prefs 全部事务化,消除两进程旧快照互相覆盖。缓存按 dev/ino/size/mtimeNs/ctimeNs+journal 尾部识别,内存上限 32 MiB LRU,读端返回独立克隆。验收:`fork-journal-store.test.js` 16 项(≥10 MiB 夹具单行修订/相同输入零写入/重复小变更增长与默认阈值压实摊销/直接重写/断尾/损坏隔离/不支持版本/旧 JSON 升级/原子替换/克隆/第二进程/双写并发/读写竞争/imports 向下修订/生产阈值钉死/备份往返)。

**3. WebDAV seg 真实增量**:seg 仅携带相对"上次成功发布内容"(`webdav/published/<kind>.json` 键序无关逐行哈希表)的整行 upsert(新增/修订/向下修订;缺失键不删除),base 仍全量;登记表仅在上传确认成功后推进——失败重试重发、上传成功本地提交中断自动对齐不重传、登记表缺失/落后强制一次全量 base(升级首变/重装恢复);recovery/rebase 语义保留。`fork_sync:1`/文件名/hash/自校验/since_seq 链不变,1.4.20 读端兼容用 `git archive personal-v1.4.20` 提取的旧 importer 实测。验收:`webdav-delta-seg.test.js` 5 项(仅变化行/零变化零上传/失败重试重发+基线不提前/提交中断对齐/服务器一致跳过恢复/旧服务器状态重基地/1.4.20 读端/自校验契约)。

**4. 共享读取与报表计算**:scopedQueueRows 先决策读路径再触盘,消除个人版"async 读一次+fork-view 同步全读一次"的重复;fork-view 新增 bucketSnapshot(单次读+合并,在途请求合并),buckets/deviceUsage 接受共享快照,deviceUsage 由逐设备 N+1 次全量改单快照分组;新增 `/api/fork/report` 聚合端点,从一次加载产出与六个端点逐字段一致的负载(summary/previous/daily/breakdown/projects/devices,forkMeta 装饰对齐);dashboard `use-fork-report` 改为单请求,不改 UI 文案/布局/颜色。验收:`fork-report-aggregate.test.js` 4 项(六端点逐字段一致/顺序六请求 ≥5 次解析链 vs 聚合 1 次/并发合并单次且不返回陈旧/同大小改写、设备新增、 breakdown 一致性即时可见)。

**5. 动画与凭证查询**:MenuBarAnimator 新增 `hasFrameConsumer` 门控——文字额度且无图标消费者(按钮图更新关闭且灵动岛不在消费帧)时停掉动画/眨眼/冲刺 timer 并驻停单帧,`noteActivity` 无副作用,眨眼续延补守卫防泄漏;岛启用且面板可见且左翼为 todayTokens 时仍正常消费帧;StatusBarController 在全部三处 updatesButton 写入点刷新门控并监听岛面板显隐;额度刷新/队列采集/点击面板/reduce-motion 分支不动。`/api/webdav/status` 改用 `webdavCredentialExists`:macOS keychain 只列属性不读密码(无 `-w`)、Windows DPAPI/file 纯 fs stat 不启动 PowerShell,30 秒有界缓存,保存/清除即失效、URL/用户名变化自然换键、未知错误不缓存可重试;真实同步仍走完整凭证读取。验证:动画 harness `dist/reviewed-1.5.0.noindex/menu-bar-animation-harness/run.sh` 12/12(抑制零帧零唤醒跨 31 秒泵、快速开关无双份 timer、驻停单帧、眨眼节奏恢复);凭证测试并入 `webdav-credential-store.test.js`(存在性不解密/TTL 缓存/失效/keychain 属性探测无 `-w`/锁定错误不缓存可重试/DPAPI 纯文件判定)。

**6. 恢复与更新可靠性**:失败退避与正常间隔分离——退避到期时刻持久化 `next_attempt_ms`,调度器在该时刻附近唤醒重试(30 分钟间隔+1 分钟退避→约 1 分钟重试,24 小时同理),阶梯 1/5/15/60 分钟与 Retry-After(秒/HTTP-date)/reset 照旧,401/403 暂停自动但手动可用,成功清除待重试,重启从持久化恢复,全部触发源仍单轮互斥;PUT/MOVE 瞬时 WEBDAV_NETWORK/WEBDAV_TIMEOUT 在周期内幂等重试一次(真实故障:1.4.20 大文件上传被网盘重置导致 WEBDAV_NETWORK,见本机 state.json);GET/PROPFIND 404/错误响应正文显式释放。macOS 更新复用上游 `7e65d770` 限流识别/冷却/网页回退思想(详见下方 6b 条目):仅认 CYRYGBG/TokenTracker personal-vX.Y.Z 稳定 tag 与本平台资产,API 与回退同校验 SHA256SUMS,严格拒绝上游仓库/其他 host/凭证 URL/预发布/错误资产/checksum。验收:`webdav-retry-schedule.test.js` 8 项(30 分钟/24 小时退避实际触发、阶梯、Retry-After、401 暂停手动可用、重启恢复、timer 唤醒、瞬时重试发布成功)+更新 harness 96 项(见下)。

**7. 全量自验**:Node 全量 `node --test --test-concurrency=2 test/*.test.js` = 3781 项,3764 通过/17 跳过(既有平台/语料类跳过)/0 失败(日志 /tmp/tt-150-full-node-final.log);dashboard Vitest 150 文件/1290 项通过,typecheck 干净,生产构建通过;copy/locale/ui-hardcode/guardrails/versions/bot-frames/架构校验通过;全仓 Swift typecheck 0 错误(30 个既有警告);更新回退 harness 96 项与动画 harness 12 项均从 `dist/reviewed-1.5.0.noindex/` run.sh 可重跑实测通过。性能五场景(`scripts/measure-perf-1.5.0.js`,口径=进程内 fs 写入调用字节/解析链次数/墙钟,非 SSD 磨损非电池):≥10 MiB 历史单条修订写入 10,154,135→2,480 字节;30 次连续小变更 304,624,050→74,400 字节(压实 0 次,journal 68 KB<1 MiB 预算);无变化周期旧版整写 10,154,135 字节→新版仅 274 字节锁簿记;报表刷新 6 请求 5 次解析链 133ms→1 请求 1 次 32ms;两设备单行变更 seg 载荷 1,603,519→508 字节(0.032%)。measurement JSON:dist/perf-1.5.0.noindex/performance-1.5.0-measured.json。旧版每写耗时更低(30 次 593ms vs 1219ms)如实记录:新路径以每次约 20ms 的差分/克隆开销换 ~4000× 写入减少,不宣称电池收益。

**同步失败排查(用户报告"经常同步失败")**:本机 state.json 显示 last_failure=WEBDAV_NETWORK/PUT、退避顶格 60 分钟;系统代理全关、应用未配代理,为直连上传大文件被重置。本轮三项缓解:差异 seg 使上传载荷从 MB 级降至 KB 级、失败退避到期即重试(不再等满正常间隔)、上传瞬时错误周期内幂等重试一次。未宣称网速/耗电改善,等待用户实际观察。

未验证/边界:Windows 实机安装/GUI/常驻未验收(无实机);长期 72h 观察未做;合并/发布流程见后续条目;本节提交后 dist 中旧 1.4.20 安装包不得冒充 1.5.0。

## 2026-10-31 personal-v1.5.0 双平台应用内更新交付完成

- 已于 2026-10-31 17:30（Asia/Shanghai）公开发布 [personal-v1.5.0](https://github.com/CYRYGBG/TokenTracker/releases/tag/personal-v1.5.0)，release ID `429824123`，设为 latest。构建/标签源码固定 `5d30c0bc5704b6299a207dad75b76b26120293de`（实现提交 `8f99cc51` + 跨平台测试夹具修正 `5d30c0bc`，两平台产物在夹具修正提交后重建）。分支已推送；tag 未移动。gh release create 需 workflow scope 的老问题依旧，改用 REST API 创建/发布，附件用 uploads.github.com 直传（gh api 对 uploads 主机返回 404，与代理无关，curl 正常）。
- macOS DMG 65,057,572 字节，SHA256 `d9e5eabe51c1f1729dd301a6c0d634ed54a51857e056a104348da6a2303d7be7`；Windows Setup 299,795,239 字节，SHA256 `f719b14fb849a90d76e9e1bfd3a1de54d7c6e48eb8e61bf4ab180851989ee9fb`；SHA256SUMS.txt 两行 212 字节。远端 digest/大小与本地一致，匿名下载 HEAD 均 200，公开校验文件与本地逐字节一致，`releases/latest` 指向 1.5.0，tag 指向 5d30c0bc。发布说明中 Node 计数初版误写 3867/3850，已更正为 3781/3764（仅改 body，未动 tag/资产）。
- 旧版更新通道核对：用 `git archive personal-v1.4.20` 提取的 1.4.20 Swift 通道代码编译探针，对公开 latest 元数据+真实匿名下载的 DMG（65,057,572 字节，哈希一致）验证：识别 1.5.0、DMG URL 合规、以 1.4.20 代码解析公开 SHA256SUMS 并通过真实字节校验、错误平台资产被拒；1.4.20 Windows release-client/integrity 探针（net8.0，macOS CLR 运行）识别 1.5.0、Setup URL/大小（299,795,239）精确、校验和匹配、未触发回退。未驱动本机已装的 1.4.20 应用点击检查更新（留给用户验证提示，不替用户安装）；1.5.0 的限流回退以 96 项夹具 harness 为准，未伪称公网限流实测。
- Windows 链路：EmbeddedServer 按新源码刷新（npm ci 生产依赖+既定裁剪）、verify-windows-package 321 输入逐字节一致/2569 文件、Inno Setup 6.7.3 于 tt-inno10 编译通过；打包内 Windows Node 22.22.2 于 tt-smoke64 跑 8 个改动相关测试文件 68 项通过/2 项跳过（跳过原因：裸 Wine 无 git/bsdtar，兼容读取契约已在 macOS 验证）。macOS 链路：真实 Vortex + 全源 swiftc Release、hdiutil VALID、挂载版本/bundle/codesign/三目录逐文件一致、86 个原生源码哈希匹配、隔离 HOME bundled CLI 冒烟（17885 端口握手 serverVersion=1.5.0）。
- 未验收边界照旧：Windows 实机安装/GUI/常驻、72h 观察、真实坚果云速率、公网限流回退实测均未做；不覆盖安装本机应用；未发 npm；未写 upstream/main；Actions 开关未动。

## 2026-10-31 macOS 个人版更新检查限流冷却与网页回退（HANDOFF-1.5.0 项6b，已实现未提交）

- 适配 upstream `7e65d770`（官方版限流识别/冷却/网页回退）到个人版更新通道，不复制官方仓库 URL、官方资产名或官方文案；未动 Windows 代码，仅只读对比 `TokenTrackerWin/UpdateReleaseClient.cs` 确认限流判定与冷却语义一致（429 即限流；403 需 x-ratelimit-remaining:0 / Retry-After / "rate limit" body 之一为证据；冷却取 Retry-After（秒或 HTTP-date）与（配额耗尽时）x-ratelimit-reset 的较大者，无时间则固定 60 秒）。
- 改动文件：新增 `TokenTrackerBar/TokenTrackerBar/Services/PersonalUpdateReleaseClient.swift`（UI-free：`GitHubRelease` 移入此文件；`PersonalUpdateRateLimit`、`PersonalReleasePageParser` 纯逻辑类型；客户端持有 API 冷却状态并实现回退）；修改 `UpdateChecker.swift`（API 抓取替换为客户端调用；handleResult 在冷却时显示限流状态、失败弹窗附可重试时间、fallback 成功后保留冷却指示）；`PersonalUpdateChannel.swift` 新增 `assetURLString(tag:name:)` 规范 URL 构造器（API 与回退路径都要求绝对等于规范 URL）；`Strings.swift` 新增 `updateRateLimitedStatus`、`updateRateLimitedRetryAt` 两键五语言。默认不自动更新语义、静默检查开关、bundle ID/版本/codesign 校验、SHA-256 校验失败即失败、完整复制替换流程全部未动。
- 个人版回退规则：只允许解析 `https://github.com/CYRYGBG/TokenTracker/releases` 列表页（无 personal 标签时再试其 `.atom`）；tag 严格匹配 `personal-vX.Y.Z` 稳定三段（预发布/四段/上游仓库 tag 一律不匹配）；资产从该 tag 的 `expanded_assets` 片段解析，下载 URL 必须经 `PersonalUpdateChannel.assetURL` 验证（精确 `/releases/download/<tag>/<资产名>` 路径、https github.com、无端口/凭证/query/fragment、精确 `TokenTrackerPersonal-macOS-arm64.dmg`）；`SHA256SUMS.txt` 必须来自同一 tag，缺失/格式错即更新失败，绝不放宽。
- 验证（CLT，真实执行）：`swiftc -typecheck` 两个 UI-free 文件独立通过；/tmp swift harness（URLProtocol stub + 注入时钟）编译运行 96 项断言全部通过，覆盖：正常 API（无回退）、403 带证据回退并钉住 tag/资产/size/digest、429+Retry-After 秒、403+Retry-After HTTP-date、普通 403 不进冷却不回退、冷却期内跳过 API 到 reset 后回 API、fallback 失败保留冷却、Retry-After/reset 取较长者、无时间固定 60s 不虚构重试时刻、列表页/atom 解析取最高稳定 tag（拒绝上游仓库 tag/预发布/四段）、重定向落到非官方路径被拒（invalidReleasePage）、expanded_assets 错误资产名/query 凭证/外 host/http/凭证 URL 拒绝、SHA256SUMS 缺条目/短 hex/错文件/空拒绝、assetURL 14 例与限流纯逻辑矩阵；harness 已持久化到 gitignored `dist/reviewed-1.5.0.noindex/update-fallback-harness/`（run.sh 可一键重跑 96 项，已实测）。整仓 Swift 编译证明：复用构建脚本相同 swiftc 调用（`-whole-module-optimization -swift-version 5 -target arm64-apple-macosx12.0`，-I 复用 dist/personal-build.noindex 内已有 Vortex 模块，只读）对 app 全部源码 `-typecheck` 返回 0，无新告警；`xcodegen generate` + patch-pbxproj-icon 已重跑（xcodeproj 为 gitignored 生成物），新文件已进 app/QA target。未构建 DMG、未动 dist 产物、未提交/推送。
- 发现未处理：listing/atom/expanded_assets 是 GitHub 服务端渲染页面，若 GitHub 改版可能失效（fail-closed，表现为更新检查失败而非降级）；冷却状态仅内存（重启丢失，与上游/Windows 一致）；body 含 "rate limit" 的 403 按上游语义视为证据（极端情况下可能把含该字样的普通 403 误判为限流，冷却有界且可恢复）；静默自动更新经回退成功下载时不显示限流状态（进度通道优先，与上游一致）；对 HEAD size 与 SHA256SUMS 下载不做限流判定（github.com 下载域不在 REST API 配额内，同上游/Windows）。

## 2026-10-31 personal-v1.5.0 已启动，按用户要求交接实现

- 用户明确授权把只读调查表格六项全部实施并发布更高版本；本轮选定 personal-v1.5.0。随后用户改为要求编写可交给另一个对话自行实现/验收的明确提示词，原对话最后复核。因此本对话已停止继续实现，未构建或发布 1.5.0，未启动另一对话或后台任务。
- 接续提示词：`HANDOFF-1.5.0.md`，完整列出六项改动、现场、测试/故障注入/性能与兼容验收、双平台构建/发布和返回复核证据；分阶段计划 `PLAN-1.5.0.md`。当前 HEAD 仍为 `4cffe4ac69f0913079302080ad124187ad1d9022`，分支 codex/personal-release-20261027，以下改动均未提交/推送，需在本工作区接续。
- 已按文件摘取 upstream `0258ac0b` 的 Codex ledger/session 修复，手工适配 session-analytics 的 fork 差异；新增两个上游测试文件。Codex parity/observed attribution + fork-session-worker 共 11 项通过。未完成完整升级、跨设备修订验收，不能标记全项完成。
- `fork-journal.js` 和 `fork-store.js` 仅为大历史增量存储原型；尚缺专门覆盖大于 256 KiB、压实/断尾/校验损坏/跨进程事务/备份回退的测试与评审。初步定向 fork prefs/worker/end-to-end + WebDAV store/two-device 共 31 项通过（`/tmp/tt-150-store-initial.log`），不能据此认定日志分支可发布。其他六项中的大量实现仍未开展，应用版本仍为 1.4.20，现有 dist 包不可作为新版上传。
- 工作区原样保留代码/新模块/测试及文档供接续；不改用户源数据/配置/凭证、不覆盖本机安装、不操作 Actions。下一步由接手对话按提示词实现、验证并双平台发布，再返回本对话复核。

## 2026-10-31 后续优化只读调查（未实施）

- 用户本轮仅要求调查与汇报，不开发、不发布。经代理 fetch upstream/origin；upstream 从 `e28c90dd` 更新至 `a9ef316fbe58cf594dbefa7cdbfd5f71cfa212f1`（8 个提交），origin 发布分支无新增。本机安装版本已为 1.4.20；本轮未安装、未改代码/配置/统计/凭证、未触发手动采集或真实网盘测试，仅补本节事实记录。
- 未主动操作应用的 121.2 秒观察窗口捕获后台 Node 的周期负载：5 秒间隔 ps 样本最高 CPU 43.8%，进程实际磁盘读取增量 379,813,888 字节、写入增量 42,565,632 字节，采样物理占用峰值 316.5 MiB、末值 126.1 MiB。原生 app 写入增量为 0。口径为各 PID 的 proc_pid_rusage v2；不含独立采集子进程的 I/O，不是 dirty-memory 指标，也不是整机能耗。观察期间源工具仍在使用、自动采集/同步发生，不将该窗口外推为固定每两分钟写入或每日耗电；未完成无源变化/休眠/Windows 对照。
- 已确认剩余放大路径：会话/分组/导出历史等使用整份 JSON 比较与原子重写；本机 sessions 约 8.7 MB、wire-sessions 约 6.4 MB。同步调度器直接将 retain 后完整 rows 放进 seg 文档，已有 `diffRowsByKey` 仅用于测试、尚未接入调度器；单类数据变更仍传完整历史。周/月报 6 个并行请求及 deviceUsage 的逐设备查询重复读取/解析本地与导入快照，个人版 scopedQueueRows 绕过现有异步 queue reader 的缓存结果，再调用同步全量 reader。后续应优先评估真实行增量、共享快照/请求合并、减少整文件重写；不改变历史保留、修订及幂等语义。
- 次要问题：文字菜单栏仅禁用按钮图片写入，动画/眨眼 Timer 仍工作；同步设置页可见时每 15 秒读取状态，每次都会调用系统凭证读取（macOS security / Windows PowerShell DPAPI），不是首页 ForkScope 轮询也读取凭证。自动同步退避与正常间隔共同生效，短退避结束不意味着立即重试，长间隔配置可使恢复延后；macOS 个人版更新仍仅走 GitHub latest API，没有新版上游的限流网页回退。上述静态结论尚未逐项量化功耗或复现真实服务限流。
- 用已安装 Node 22，将 upstream 新增 `codex-session-ledger-parity.test.js` 的前三个合成夹具直接运行在当前源码：同日分叉、跨日分叉、仅 total 的旧 usage 三例均复现不一致；例如同日夹具会话模型合计 150、小时账本合计 100，另一例得到 60 而期望 42。仅使用临时合成日志，已自动清理；缓存迁移第四例跳过。不是用户真实历史对账，也未导入上游修复。建议将 `0258ac0b` 的 Codex 一致性修复列为高优先级评估；其缓存失效与 fork 持久历史/远端快照修订仍需单独回归。
- 上游 `45f82619` 为 ZCode 分区最后成功缓存、`ad1107c4`/`125f1c1e` 为登录归属/跨区域额度、`7e65d770` 为 macOS 更新限流回退、`03bfd5b2` 为部分模型静态价格覆盖，均未采纳。个人版已有 usage-limits 外层 ZCode 缓存与账号隔离，不将上游新增缓存误报为当前完全没有缓存；后续需比对分区/过期/认证错误语义及重复存储风险。无全量回归或构建，因为本轮未实施变更；等待用户决定范围。

## 2026-10-31 personal-v1.4.20 双平台应用内更新交付完成

- 已于 2026-10-31 10:17:41（Asia/Shanghai）公开发布 [personal-v1.4.20](https://github.com/CYRYGBG/TokenTracker/releases/tag/personal-v1.4.20)，release ID `429662838`，设为 latest。构建/标签源码固定 `267f731e3544c0ff49e34338829cd83fe8fc69b1`；两平台在 Mac 本地构建，未运行 Actions、未发布 npm、未写上游/main。分支已推送；发布后仅补文档和证据，不移动标签。
- macOS DMG 为 65,090,503 字节，SHA256 `c61bd0e5ed4f45ababf773446a652636aa7d01ac2b5bef5556ee396060033a78`；Windows Setup 为 299,795,580 字节，SHA256 `0a6d87df774700e94011f0b9c5a17a366dcdfc37b20abf3da9656735d4867213`。三附件 GitHub digest/大小匹配本地，匿名下载 HEAD 均 200，公开两行 SHA256SUMS.txt 与本地一致，匿名 latest API 指向 1.4.20。
- macOS 完整 Release/签名/镜像校验通过，挂载 app 与构建 app 一致，85 原生源和 321 包内输入匹配；Windows 自包含 Release/程序集版本及源码 SHA、320 输入/2567 文件清单核对和 Inno Setup 6.7.3 编译通过。实际 Windows Node 22 在隔离 Wine 下通过 16 项工作线程/SQLite/缓存/双进程保史回归。bundled CLI 隔离 HOME 离线握手/退出、官方目录保护和单份 JS/CSS 校验通过。
- 软件内更新验收：本机安装的 1.4.19 手动“检查更新”已真实弹出 1.4.20、当前 1.4.19 和“下载并安装”提示，未点击安装，截图仅保留线程私有目录。用 1.4.19 的 Swift 更新通道代码读取公开元数据/校验文件并核验 DMG 通过；1.4.19 的 Windows release-client/integrity 原代码从公开 API 识别 1.4.20，安装包 URL/大小/校验和与产物一致。Windows 原生界面/实际升级、本轮 72h 常驻仍未实机验收，不能将兼容环境测试写成 Windows 实机升级通过。
- 发布与验收证据：`evidence/release-1.4.20.json`、`update-channel-1.4.20.json`、`macos-build-1.4.20.json`、`windows-build-1.4.20.json`、`artifacts-1.4.20.json`、`local-verification-1.4.20.json`、`performance-1.4.20.json`。临时 Windows 运行时夹具已清理；不覆盖安装、不修改网盘配置、不上传私人统计或截图。

- 用户明确授权完成磁盘读写/能耗优化和 WebDAV 180 秒超时修复，并以 macOS/Windows 应用内更新交付。origin 构建修复三提交已快进纳入；upstream `e28c90dd518b328315979b965391102ec1f026e0` 新增官网徽标变动不纳入。本轮不操作 Actions，保留另一会话已获授权的个人 Mac 构建状态。
- ZCode 显式优先 Node 只读 SQLite，运行时缺模块才回退 CLI，锁定/SQL/权限等操作失败不重复执行。SQL 仅投影统计/去重/归属字段，将既有 native/legacy 历史分界保守地下推到数字时间条件；秒/毫秒兼容，特殊文本仍由原 JS 过滤。其他 provider 的默认 SQLite 顺序不改。
- 历史构建移到工作线程并合并在途请求，强制刷新排在普通构建之后，跨进程租约串行合并，保留已删除源的历史；读取保存价格表与同步自定义价格，后台线程不额外刷新网络价格。Harness 按文件身份/大小/纳秒修改信息缓存归一化元数据，未变化时不再解压，不存正文，源修订/替换和强制刷新会失效。
- 真实库只读统计字段对照一致；该 Node 查询场景原耗时约 32 秒、实际写入约 103 MB，新路径冷/热约 1.9/0.18 秒、实际写入约 7 MB，峰值物理占用约 343→159 MB。仅为查询进程的测量，不外推整机耗电或 SSD 寿命；详细私人来源/哈希未上传。公开安全指标见 `evidence/performance-1.4.20.json`。
- Node 最终全量 3737（3720 通过、17 跳过、0 失败，concurrency=2）；首次发现 origin 旧 SDK 修复遗留两处测试断言，已改为验证材料兼容回退且禁止 glassEffect，未恢复宠物入口。另一轮 concurrency=4 的旧 Antigravity 100ms 预算断言偶发失败，单文件 13 通过/4 跳过，未放宽断言；最终全量已绿。新增线程响应性、自定义价格、双进程保史、缓存命中/同大小改写、SQL 元数据/时间边界及原 Node 20 回退测试通过。
- Dashboard 全量 150 文件/1290 项通过，typecheck/copy/locale/guardrails/versions/ui-hardcode/bot-frames 和生产构建通过；C# Windows 逻辑/更新测试 172 通过；实际安装包 Node 22 定向 111 项（107 通过、4 跳过）通过；构建 Python 6 项通过。当前未覆盖安装本机应用。

## 2026-10-30 WebDAV 超时延长与磁盘读写优化计划（本地完成，未发布）

- 用户要求制定具体后续磁盘优化方案，并反馈自动同步 30 秒超时过短。已核对该 30 秒为 WebDAV 单次网络请求预算，与本地 SQLite CLI 的 30 秒超时独立；前端 sync-now 没有额外 30 秒 AbortController。经代理 fetch upstream，仍为 `2ea4010899cc6681670110f2691c07fd7bbf8ce6`，无新增相关改动。
- WebDAV 默认请求预算由 30 秒延长至 180 秒，自动同步、手动同步及连接测试统一生效；整轮多文件同步没有 30 秒总截止时间。保留显式请求时限与现有退避、认证暂停、单轮互斥、校验失败不导入等约定。
- 修复 GET/PROPFIND 已收到响应头但正文超时或断线时，错误未被结构化的问题；现在正文读取沿用该请求的截止信号，保存 WEBDAV_TIMEOUT/WEBDAV_NETWORK、实际预算和操作类型。英文及简繁体文案改成“请求未完成”，同时适用于等待响应与文件传输阶段。
- Node 定向 54 项通过（WebDAV 全组、两设备收敛/幂等/恢复、凭证、历史保留和 API 安全）；实际已安装包内 Node 22 运行网络客户端/调度 17 项通过。新增虚拟时钟 31 秒响应、真实回环服务器正文卡住、列表正文超时/下载断线、慢请求期间手动/自动同步互斥，以及失败退避/恢复回归。未接触真实网盘配置或上传测试数据。
- Dashboard 同步范围/设置页 13 项、错误说明 1 项、typecheck、copy/locale 校验通过；首次 Vitest 命令从根目录启动时线程上下限冲突，修正为 dashboard 目录并指定 min=1/max=2 后通过。copy 校验保留已有未使用键警告，无新增校验错误。
- 已新增 `PERFORMANCE_PLAN.md`：依次消除慢 CLI 失败后重读、缩小旧消息查询载荷、合并扫描/复用未变化元数据，再减少无变化写入/唤醒；逐步核对 Token/费用/去重/源删保史，使用实际 I/O 计数而非将 dirty-memory 事件当 SSD 写入量。性能优化本轮仍为方案，未宣称已修复能耗。
- 本轮未改版本号、未改 SQLite/采集器、未构建或发布安装包、未推送、未覆盖安装本机应用；当前安装的 1.4.19 尚未获得 180 秒修复。下一步可按性能方案逐项实施与量化验证后组装新版本；Actions 保持禁用，无外部定时任务。

## 2026-10-30 macOS 大量能耗排查（已定位，尚未修改或分发修复）

- 核对本机实际运行安装版为 1.4.19。经代理 fetch upstream，仍为 `2ea4010899cc6681670110f2691c07fd7bbf8ce6`。本轮只读源码审查、临时进程采样和只读数据库对照，未修改采集逻辑、用户配置、凭证、已安装应用或发布资产；未新建后台服务。
- 空闲 `top` 四次采样中 app/WebKit 基本为 0%，后台 Node 为 0–0.2%；Activity Monitor 当时当前能耗影响 0–0.1，但 12 小时电源为 332.10。`pmset` 未发现个人版持有睡眠阻止断言。低空闲 CPU 不能排除周期子进程负载。
- 330 秒临时采样捕获后台 `sqlite3` 多次接近一个核心满载；直接父进程既有 serve Node，也有 serve 启动的本地 sync Node。捕获 SQL 指向 ZCode 数据库：原生 model_usage 读取及旧 message 表 `json_extract(data,'$.role')` 过滤、完整 data 输出和 `ORDER BY time_created`。查询计划为 `SCAN message` + `USE TEMP B-TREE FOR ORDER BY`。不将所有系统 WebKit/Node 进程归到本应用。
- 系统本日磁盘写入诊断明确记录安装包内 Node PID 75191 在 5060 秒窗口中有 8589.94 MB file-backed memory dirtied，采样堆栈包含 `node::sqlite::StatementSync::All` 和 `pwrite`。这是系统写入诊断口径，不等同于用户统计文件增大 8.6 GB。常驻 Node 空闲物理占用约 79 MB、历史峰值约 705.8 MB；未发现持续前端动画满载证据。
- 关键对照：以实际打包 Node、同一只读 SQL 和本机数据执行现有 sqlite-reader 路径，CLI 在 30009 ms 因 ETIMEDOUT 终止，随后自动退回 Node SQLite，同一读取总计 31518 ms；结果 19960 行、data 约 59.6 MB。直接 Node SQLite 两次同 SQL 分别 1819/564 ms（含结果哈希），行数、载荷字节数及结果 SHA256 一致。已验证“先失败 30 秒再重读”的浪费；尚未修改全局 SQLite 选择顺序，不能称已修复。
- 次要开销：fork DSH 会话适配每次读取 12 个源文件，未改动时仍解压/重算，两次约 1005/839 ms、约 7.6 MB 压缩输入。会话历史收集与用量采集是独立调用方；analytics 自身已有 per-home single-flight/TTL/按文件复用，不能一概称所有工具每次全量重扫。macOS 启动环境明确为 APP_SHELL=macos，已排除 serve 的 personal/windows 一分钟兜底与原生五分钟循环同时启用这一假设。状态读取还会反复通过 security 子进程查询 Keychain，但本轮非主要 CPU 峰值来源。
- 私有证据仅在 gitignored `dist/energy-review.noindex/`（idle-top、process-samples/summary、sqlite-baseline、node-sqlite-comparison、dsh-baseline、Activity Monitor 截图），原始系统诊断未上传。临时采样/对照进程已结束，Activity Monitor 恢复原先无筛选的磁盘页。本轮未跑全量测试或构建，因为应用源码未修改。
- 后续修复重点：在兼容 Node 20 与既有 SQL/错误语义的前提下，避免已支持 Node SQLite 的安装版先重复执行慢 CLI；缩小 ZCode 旧格式历史读取、复用未变化的会话结果。必须补 SQLite 失败/锁定/不同运行时回归，并核对跨设备统计、连续两次采集幂等、源删保史及修复前后 CPU/写入证据后，才可声称节能修复并分发。当前不以拉长刷新间隔或关闭额度功能掩盖问题。

## 2026-10-30 跨设备项目识别只读核对

- 核对 1.4.19 实际实现：从工具记录的工作目录向上找 Git 配置，优先 origin、否则首个 remote；标准化 SSH/HTTPS、去凭证与 .git，fork 同步标识按规范化仓库引用生成，分支/本地路径不作为同仓库跨设备匹配依据。无可识别仓库引用时保留设备隔离的本地身份，或无法形成项目桶而留在未归属用量，不通过提示词/代码相似度推断。
- 手动 project_alias_add/remove 规则随 prefs 同步；读取时应用别名并保留 original_project_key，可取消归并恢复来源。不同 origin、镜像/SSH 主机别名及工具缺少目录证据会影响自动关联；同仓库的分支/子目录通常共享项目身份。本轮只读审查，未修改应用、用户配置或已发布资产，未重新构建/发布。

## 2026-10-30 Windows 发起 macOS 构建修复（已构建验证）

- 完成：修复提交 `10a0995a`、`beb600c9` 已推送个人发布分支。第二轮 [run 41046723933](https://github.com/CYRYGBG/TokenTracker/actions/runs/41046723933) 使用 macos-15 arm64，2 分 13 秒完整通过前端/EmbeddedServer/真实 Vortex/Swift Release/DMG/版本与签名检查及附件上传；源码固定 `beb600c901b65038ded36a3bb4b6a7dbbdc124f1`。不是仅修改脚本或只排队成功。
- DMG 已下载本机 `dist/macos-ci-41046723933/`，72,255,993 字节，SHA256 `164d8f720d64828a6536019de32ec1be2ca49ab006aa83d885953a5d1471278c` 与构建清单一致，85 个原生源码哈希与当前源码逐项一致。证据 `evidence/macos-build-repair-2026-10-30.json`。
- 已安装 GitHub CLI 2.103.3；仓库 Actions 已按授权恢复，仅 personal macOS 工作流 active，另外 11 个逐个 disabled_manually（含排行榜定时、官方发布与 npm），避免恢复仓库开关时连带启动官方任务。后续从 Windows 手动 dispatch 个人发布分支即可生成 Mac 附件，步骤见 README。
- 本次只验证现有 1.4.19 的构建链：未新建 Release，未更换既有 tag/公开附件，未覆盖安装。Mac GUI/安装实机未在本轮验证；已有 Swift 并发警告和 Actions 旧 action 的 Node20 弃用警告不影响本轮成功。当前无构建阻塞；下一次产品版本按现有双平台验收/发布规则执行。

- 本机个人发布分支已从 `3f64610f` 快进至远端 `5a7fa5fe`（1.4.19）；保留原有未跟踪 workflow `.bak`。已 fetch upstream，仍为已检查 `2ea40108`，无额外上游修复待纳入本轮。
- 实查 GitHub：排行榜定时任务 run `40799723374` 因 `LEADERBOARD_REFRESH_SECRET is not configured` 失败；个人 macOS run `40735012090` / runner probe `40737895297` 均 runner 名为空、步骤为空、job cancelled，未开始编译。不能把所有失败邮件归因于 Swift 编译。
- GitHub 官方 2026-10-01 公告：macos-14 于 2026-11-02 退役，此前有 brownout 和容量缩减。个人工作流改为 macos-15 arm64、固定 Node 22.22.2、45 分钟运行超时、只读源码权限，版本输入走环境变量；缓存路径使用 runner.temp。
- Python 构建在任何下载/写 staging 前检查宿主、架构、SDK/工具及受管版本；`--prepare` 串联依赖安装/前端/EmbeddedServer/原生 DMG，`--check` 单独诊断环境。Vortex 下载使用超时重试、临时文件、校验后替换，可恢复中断缓存；不放宽 pinned SHA。shell 打包拒绝非 macOS、非法架构、缺前端资源，并保留 npm 失败日志。
- Windows 已验证：Python 构建工具回归 6 项、架构 4 项、shell 语法、YAML 解析及版本一致性通过；实际 Windows `--check` 清楚拒绝，未进入下载/原生构建。已初始化 CodeGraph（1297 文件）并忽略本地索引；没有改统计/同步引擎、应用版本、个人数据或安装。
- 用户已明确授权推送修复、仅恢复个人 macOS 构建并实际编译验证；不发布新版本，其余官方工作流保持禁用。构建结果见本节首条。
- 首次实际 run `41046337433` 已分配 macos-15，前端/运行时打包全过，原生编译暴露旧宠物视图 `PetBubbleSurface.glassEffect` 依赖 macOS 26 SDK（当前 Xcode 16.4 / SDK 15.5）；运行时 availability 不能隐藏未知 API。个人版保留原有 material fallback，移除该未启用功能的新 SDK 分支，不恢复宠物入口。随后第二轮全绿。

## 2026-10-30 personal-v1.4.19 双平台发布已完成

- 用户明确授权把最终精简预览接入生产，并追加同步提示修复后发布双平台。新增 `/reports` 与侧栏入口，真实只读数据、按本机时区的完整日周期和同期比较；货币、Token 格式和 Card/Button 复用应用实现。保留未归属/其他项目、账号级用量独立语义，错误不伪装为零值。
- 复现证据：本机只读状态在 11:03 已成功且 last_failure=null，旧顶栏仍显示 WEBDAV_TIMEOUT；原因是 ForkScope 仅挂载时读取。已加入手动同步完成事件、15 秒可见页面状态核对、窗口回到前台刷新及请求代际保护。同步设置页同样更新状态但不覆写未保存的凭证草稿。
- 超时持久化安全的持续时间/HTTP 状态/操作事实，错误说明不渲染原始异常、凭证或远端路径；部分文件失败保留历史与上次完整成功时间，不提示完整成功。已有循环正在运行时不假称同步已完成。
- Node 最终全量 3724（3707 通过、17 跳过、0 失败）；首次 Dashboard 并行全量一个旧排行榜用例超时，单文件 18 项通过，限制并发后最终 150 文件/1290 项全绿，新增周期请求竞态、失败、部分同步与运行中提示回归通过。类型、文案/中文覆盖、UI/架构/版本校验已通过。生产构建通过；只读代理本机 API 核对真实统计、周/月切换、货币设置联动和 320/1280px 布局，修复窄屏 SVG 的网格最小宽度溢出。临时预览已清理，真实截图只留线程私有目录。构建/发布事实见下文；未覆盖安装本机应用。

- 已于 2026-10-30 11:40:01（Asia/Shanghai）公开发布 [personal-v1.4.19](https://github.com/CYRYGBG/TokenTracker/releases/tag/personal-v1.4.19)，release ID `428625920`，设为 latest。源码/标签固定在 `1d776bf5004bb477e4326de0f3738ad1bbe02ed5`；发布后只提交文档与证据，不移动标签。
- macOS 完整 CLT Release、85 个原生源文件哈希、319 个包内输入、签名、只读挂载内容及 DMG 校验通过；Windows 自包含交叉构建、318 输入逐字节对齐、2565 文件清单、Inno Setup 6.7.3 编译和 Windows Node 22 HTTP/Undici/SQLite/WASM/zstd 冒烟通过。另以实际 bundled CLI 在隔离 HOME 离线启动/握手/退出并核对官方目录不变；Node 22 定向 44 项通过。
- 发布的 macOS DMG 为 65,217,676 字节，SHA256 `a4e95b5989fc16eef116ab0889fc228793977e7418129613526ac45bfe961f9f`；Windows Setup 为 299,788,123 字节，SHA256 `8b5396b8f22eb41babfdcdbe4daaf8118e3805089719dedbe2760178a9b18e70`。三附件远端 digest/大小匹配本地、匿名下载 HEAD 均 200，公开 SHA256SUMS.txt 与本地一致，latest/tag 构建来源已核验。
- 证据：`evidence/release-1.4.19.json`、`macos-build-1.4.19.json`、`windows-build-1.4.19.json`、`local-verification-1.4.19.json`、`artifacts-1.4.19.json`。Actions 确认 enabled=false；未运行 CI、未发 npm、未写上游或 main、未覆盖安装本机应用、未上传真实统计。Windows 本轮未实机验收安装/原生界面；innoextract 1.9 无法解析 6.7.3 格式，故不宣称独立解包已验证；长期 72h 常驻仍未验收。

## 2026-10-30 周报/月报效果预览（历史方案，最终稿已随 1.4.19 接入）

- 用户继续指定移除整块“本期回顾”及自动总结句，已同时删除对应布局留白和渲染逻辑；浏览器确认指标卡片直接跟在日期比较之后，无控制台错误。仅更新私有预览，未改生产应用。
- 用户随后指定精简四处文案：移除顶部设备范围提示、标题下截止日/完整自然日数量、设备卡片说明及整个底部日期/时区/版本/汇率/费用提示区；标题下只留周期，已有比较日期和估算指标名称保留。周报/月报切换实测正常，指定文案在渲染界面全部消失，控制台无错误；已更新私有预览与截图。数据、生产代码和已安装应用未改动。
- 根据用户对预览的进一步反馈完成第二版：加入基于真实汇总的一句话回顾，趋势/项目并排优先展示，工具/设备紧凑排列、模型明细默认折叠；比较栏补完整日期与相同天数，指标同时展示百分比及绝对增减。未归属项目可展开按工具核对的差额，不推断缺失原因；四个周期的来源差额合计均与未归属总量一致。费用沿用本机原生保存的 CNY/汇率，仅改变展示，不重估历史费用。浏览器实测四周期切换、说明与模型展开、1024/736/320px 排版，无控制台错误；修正中等窗口大金额轻微溢出。第二版截图与交互预览仅保留在线程私有目录，仍未接入或发布生产功能。
- 用户明确允许使用本机已安装个人版的真实统计绘制效果。只读访问正在运行的 1.4.18 本地 API，范围为全部已同步设备、Asia/Shanghai；未触发扫描、同步、重估、配置保存或其他写请求，未修改已安装应用和应用源码。
- 在本机线程可视化目录生成可切换周报/月报及日期的独立预览，参照现有中性色卡片、字体、边框/圆角与工具配色，支持深浅外观。默认上周完整周期及本月至昨日；上一比较区间使用相同完整自然日数，不含今日未完成统计。
- 趋势、工具、设备 Token 合计已逐项对齐总量；项目无归属部分单列而不省略，费用来自应用估算总值并明确不代表实际付款。未采集提示词/会话正文/代码，预览不含本地鉴权 token、设备 ID、项目 URL 或绝对路径；真实快照和项目名称仅留在本机 gitignored 目录与本轮私有预览，不推送 GitHub。
- 浏览器验证四种报告期间切换、1024/320px 布局通过，窄屏无水平溢出，无控制台错误；截图存于同一私有预览目录。核对记录 `dist/report-preview.noindex/verification.json`。临时检查页/端口已清理，不安装或新增后台监控服务。
- 上述为预览阶段的事实记录；用户随后批准最终精简稿接入并发布，当前交付状态以 1.4.19 发布节为准。


## 2026-10-29 后续优化建议评估（未实施）

- 用户询问当前值得优化的方向。本轮只读检查当前实现与验收记录，未更改应用源码、依赖、版本或发布，未新增监控/定时任务。
- 建议顺序：① 72h 常驻、休眠唤醒和 Windows 提交内存的量化验证，在现有进程内按需低频采样，依结果优化；② 按工具/设备核对真实历史与统计完整性，将缺口/源不可用/已保留历史区分，避免自动改数；③ 在已有同步设备与成功时间之上补充上传/拉取状态、退避原因和下次重试；④ 在现有更新哈希/身份校验与完整替换之上补新版本启动健康确认和可恢复回退；⑤ 用半年/一年历史规模测量查询和同步开销后，再考虑减少整份 JSON 读取及缓存/增量优化。
- 这些为待确认建议，不将历史未验收项写成当前已复现故障；已有真实 Windows 基础安装/双机同步证据保留，本轮 1.4.18 Windows 实机及长期常驻仍未验收。后续实施范围由用户决定。


## 2026-10-29 personal-v1.4.18 双平台发布已完成

- 用户明确授权纳入审查建议、本机验证并正式发布 macOS arm64 / Windows x64；不使用 GitHub Actions，不覆盖安装本机应用。
- 已接入上游 #919 ZCode 空重置权益/零数量条目隐藏、#921 Qoder Desktop 0.4.x 额度兼容；保留个人版错误提示、缓存隔离及同步/历史语义。此前已推送的付款提示条移除和菜单栏额度文字去图标一并交付。
- Undici 8.12.2→8.12.3；SQLite、图标库和 PostCSS 本轮不升级，采纳依据见 UPSTREAM.md。所有托管版本同步为 1.4.18，XcodeGen 与 icon patch 已执行。
- 回归：Node 全量 3722（3705 通过、17 跳过、0 失败）；Dashboard 146 文件/1276 项通过；Qoder 34 与额度面板 59 定向测试通过；typecheck、copy、locale、ui-hardcode、guardrails、versions、bot-frames、架构通过。未改采集器或迁移；全量含重复采集/源删保史与 WebDAV 用例。
- 构建源码固定为 `e5d64c7ef060d9171f13f9578089e4296c672a64`，分支与 personal-v1.4.18 标签已推送。Node 22.22.2 对网络/代理/WebDAV、Qoder、历史保留和有界解压的 105 项回归通过；前端生产构建通过。
- macOS CLT 完整 Release、签名/镜像校验、314 个打包源码/资源和 85 个原生源码哈希核验通过；Windows 自包含 win-x64 交叉构建、ISCC 6.7.3 安装器编译及 313 个输入逐字节匹配通过。Windows Node 22 在隔离 64 位 Wine 下完成 HTTP/Undici、SQLite/WASM、Qoder/rollout 加载和有界解压冒烟。两平台运行时均校验官方 Node 下载 SHA；macOS strip/ad-hoc 重签流程可从官方二进制复现；Windows 共用无原生 .node 插件的生产 JS/WASM 依赖。
- 真实 bundled CLI 在隔离 HOME 下离线启动、本地握手/生产 HTML 和正常退出通过。构建与运行时证据：`evidence/local-verification-1.4.18.json`、`macos-build-1.4.18.json`、`windows-build-1.4.18.json`、`artifacts-1.4.18.json`。
- 边界：本机 innoextract 1.9 仅支持至 Inno Setup 6.0.5，无法解包本次 6.7.3 安装器，独立解包未验收；不将其 loader revision/checksum 警告当作安装器已损坏的结论。ISCC 自检和打包前清单通过，Windows 实机安装/托盘界面及 72h 常驻仍未验证。未覆盖安装本机应用。Actions 已确认 enabled=false。
- 已于 2026-10-29 15:36:30（Asia/Shanghai）公开发布 [personal-v1.4.18](https://github.com/CYRYGBG/TokenTracker/releases/tag/personal-v1.4.18)，release ID `427564574`，设为 latest。三附件的远端 digest/大小与本地一致，匿名下载 HEAD 均 200，公开 SHA256SUMS.txt 逐字节匹配；标签指向固定构建源码 e5d64c7e。首次 Windows 大文件上传遇 broken pipe，重试后完成。发布证据 `evidence/release-1.4.18.json`，当前汇总 `evidence/release.json` 已同步。发布后仅提交文档/证据，不移动构建标签；未写 upstream/main、未发 npm、未重开 Actions、未覆盖安装本机应用。


## 2026-10-29 官方新提交初步评估（历史，后续已授权并发布）

- 经代理 fetch 成功并通过官方 API 核对 upstream/main 为 `f80ed15a`（v1.5.1）；比上次 c30d1e3b 多三次提交，内容为两组依赖升级及版本发布。
- 结合尚未适配的 #919/#921，建议优先 ZCode 空重置权益展示修复；Qoder 0.4.x 额度兼容有条件收益；undici 等依赖按实际修复及回归结果分别考虑。遥测、官网 SEO 和官方版本元数据不引入，详见 UPSTREAM.md。
- 用户要求先简要汇报，故只更新审查记录；应用源码、依赖、版本及发布未改，未跑构建或测试、未推送本轮文档。下一步等待用户选定采纳范围。


## 2026-10-29 两处界面精简（已随 1.4.18 发布）

- 按用户截图删除顶部“实际付款（全部记录日期）”提示及正常状态下的整条占位，不再为该提示请求 prefs；实际支出设置和记录不变。部分同步失败提示与旧设备范围迁移仍保留。
- macOS 菜单栏额度/统计改为直接使用原有文字图层，移除左侧 Clawd 图标及 6pt 间距；保留百分比、五小时/周标签、分隔线与倒计时。动画不再向文字按钮写入图标，也不再逐帧重绘统计。关闭数字显示或没有选择指标时仍保留单独图标入口。
- 验证：Dashboard App/Settings/ForkSync 3 文件 30 项通过；macOS 定位/后台同步/本地化相关 Node 14 项通过；dashboard typecheck、ui-hardcode、架构 guardrails、生产构建通过；本机完整原生 Swift typecheck 通过（仍有已有的 Swift Sendable 警告）。本轮未新增测试，不涉及统计引擎修改。证据 `evidence/ui-polish-2026-10-29.json`。
- 上游经代理 fetch 到 c30d1e3b；新增 ZCode 空重置权益、Qoder 0.4.x 额度读取列为后续独立适配，详见 UPSTREAM.md。
- 交付边界：源码改动已本地提交为 `d4a2218e`。用户随后明确授权先推送到 `origin/codex/personal-release-20261027`，两个改动留待下次新版本一起发布。本轮不构建下一版本安装包、不创建 Release；已公开的 1.4.17 三附件、本机安装和禁用的 GitHub Actions 保持不变。现已随 1.4.18 完成双平台重建与发布，具体验证层级见首节。


## 1.4.17 发布（2026-10-28/29 Windows 实机轮，用户授权发布双平台）

**内存尖峰排查与修复（本轮核心）**：
- 事故复盘：Windows 实机事件日志显示 10/28 14:07 RADAR 内存泄漏检测点名 node.exe（个人版 1.4.14 serve，pid 107088），16:38 提交内存 8.04GB，呈 4–8GB 周期性锯齿；窗口期 node stderr 三次 `Session history warning: ZSTD_error_memory_allocation`。已排除：官方版残留（其 serve 10/25 后未运行）。
- 实测定位：隔离环境 45 分钟常驻 `collectSessions` 压力（真实 HOME 会话日志 + CDP 采样 + 0/20/45min 三张堆快照）完全平稳——快照对比无任何类增长超 200KB，循环本身无泄漏。真实 1.4.16 serve 跑 2.7h 仅 205MB。结合锯齿形态与 ZSTD 报错，锁定根因为**巨型临时解压**：`zstdDecompressSync` 在任何上限检查前就按帧声明（或损坏、或缺失）的内容大小整块分配；活跃追加的 .zst 会话归档每轮扫描 mtime 变化触发重复解压 → 周期性 GB 级分配/回收锯齿 → 极端时分配失败报 `ZSTD_error_memory_allocation` 并挤占系统提交预算。
- 修复（a62e7033 + 978f948f）：新增 `src/lib/zstd-bounded.js` 有界流式解压（`zlib.createZstdDecompress` 管道 + 计数 Writable，超限即销毁解压器停止分配）；`decodeDshZstdFrame` 按帧剩余预算硬上限（覆盖无 Frame_Content_Size 的流式帧）；`readCodexRolloutSnapshot` 对压缩后仍超输出上限的归档按 stat 直接拒绝并记 `oversized-archive` 台账（不再读入内存）；`decodeZedThreadBlob` 接入 32MB 有界解码。覆盖 Codex 归档快照、DSH 帧、Zed blob 三条解压路径。新增 4 项单测（round-trip/超限拒绝/帧预算/台账）全过。

**Windows 实机测试适配（f5224a04）**：
- fork-profile 测试卡死修复：exit waiter 改为 spawn 时注册（serve 早死于就绪检查时迟挂的 `events.once()` 在 Windows 上永远等待）；Windows `kill()` 是 TerminateProcess，退出码断言按平台区分。
- windows-launch-activation fixture 对齐 fork 已改名的个人版管道 `TokenTrackerPersonal.Windows.Tray.DeepLink`（上游 fixture 钉的还是官方名）。
- webdav 凭据 file fallback 的 POSIX 0600 断言在 NTFS 无语义（Windows 实走 DPAPI），按仓库既有 skip 模式平台跳过。
- 新机环境补齐：.NET 8.0.427、Inno Setup 6.7.3、PowerShell 7.6.9、sqlite3 3.54.1、Node 22.22.2 win-x64 缓存、WebView2 独立运行时安装包（官方 fwlink，214.9MB）。

**打包死重修复（90aecc73）**：vite `emptyOutDir` 显式化；`verify-windows-package.cjs` 新增「dashboard/dist/assets 仅允许一份 main-*.js / main-*.css」断言（此前 1.4.16 包内携带 3 个旧 main bundle 约 2MB，包与工作区同时脏可双过清单比对）。

**macOS 构建通道（历史及本轮事实）**：Windows 侧 d05b2449 曾新增 fork 专用 `release-personal-macos.yml`，并单独提交到 main。随后用户明确禁用整个仓库的 GitHub Actions；本轮确认 Actions `enabled=false`，未运行或重新开启任何 workflow。macOS 改由本机 CLT 完整编译，未修改 main。

**验证**：node 全量 3714 项 0 失败（3672 过 42 跳过，Windows 实机）；fork 端到端/去重/设备 19 项全过（连续采集不重复、源删历史保留语义由 fork-end-to-end 覆盖）；dashboard vitest 146 文件 1273 项全过（首轮 sentry.test.js 收集失败为 vitest 旧转换缓存误报，清 `.vite` 缓存后消失）；typecheck、copy/locale/ui-hardcode/guardrails/versions/bot-frames/架构全过。Windows 包校验 313 输入逐字节一致 + 4880 包文件 + 单 main 断言通过（sourceSha d05b2449）。

**构建**：Windows Setup `dist/reviewed/TokenTrackerPersonal-Windows-x64-Setup.exe`，SHA256 `e936a06978ec7d38cd2af03f6b510d6f52c4e51b6c955ebd4fed778e85b38147`（331,078,335 字节），证据 evidence/windows-local-1.4.17-build.json + windows-package-1.4.17.json。macOS DMG 使用本机 CLT 构建，源码 `3f64610fcc8473292d4bf9dafbec375898cdfc63`，SHA256 `b3b01687c17c421ad497ba2673c5ce899cb0c0cee782e65d5b0e4f64a5008b38`（65,203,000 字节）。原始构建清单位于 `dist/reviewed/macos-build.json`，入库副本见 `evidence/macos-build-1.4.17.json`。Windows 构建提交 d05b2449 到本轮源码只涉及 workflow/文档/证据；139 个 Windows 运行时源码、入口和包清单文件逐项哈希一致，未重建 Windows。

**macOS 本地回归（2026-10-29）**：Node 3712 项（3695 通过、17 跳过、0 失败）；dashboard 146 文件/1273 项通过；typecheck、copy/locale/ui-hardcode/guardrails/versions/bot-frames/架构及生产构建通过。首轮默认并发中 Reset Bank 的 180ms 时序预算用例失败，单文件 15 项重跑通过；随后以 concurrency=2 全量通过，未修改测试或放宽断言。bundled Node 22.22.2 上有界解压、双进程历史/幂等与 WebDAV 间隔 7 项通过。DMG 校验、只读挂载、深度签名验证通过；挂载包与构建 app 完全一致，314 个源码/资源文件及 85 个原生源码哈希匹配，main JS/CSS 各一份。证据见 `evidence/local-verification-1.4.17-final.json`。

**标签对齐授权**：用户明确允许把尚未发布的 personal-v1.4.17 从旧源码 `23558a8faf7851d9c78b660b457d7047aa4549e4` 对齐到已构建源码 `3f64610fcc8473292d4bf9dafbec375898cdfc63`。已仅对该标签使用显式 force-with-lease；旧提交仍保留在分支历史，未重写或强推分支。发布后的文档证据提交独立于构建源码，标签固定在已审核的构建快照。

**发布已完成（2026-10-29 10:13:19，Asia/Shanghai）**：[personal-v1.4.17](https://github.com/CYRYGBG/TokenTracker/releases/tag/personal-v1.4.17)，release ID `427378343`，已公开并设为 latest。DMG、Windows Setup、SHA256SUMS.txt 三资产的远端 digest/大小均与本地匹配；匿名跟随重定向 HEAD 均为 200，公开校验文件逐字节一致。远端标签指向构建源码 `3f64610f`，发布前确认远端分支 tip 未变。结构化发布证据见 `evidence/release-1.4.17.json`，当前汇总 `evidence/release.json` 已更新。

**未做/边界**：72h 常驻稳定性与游戏同开提交峰值验收待真实观察（修复已消除分配根因，但不等于验收）；上游 `f15b3f64`（社区指标缓存修复）不采纳——fork 无存活调用方；本机升级走应用内更新；本轮未操作升级或覆盖安装，读取到的本机版本仍为 1.4.15。

## 2026-10-28 接续开发记录（1.4.17 发布结果见首节）

- 已逐项复核第二个 ZCode 接续会话的用户需求、文字对话和实际实现；核对 1.4.16 已公开，三附件本地大小/远端 digest 一致，但此前 release.json 与 STATUS 停在 1.4.15。详见 ZCODE_REVIEW.md。
- 后续本机安装遵循用户新偏好：已有更新能力的版本一律应用内更新，不再终端换包。接续会话已提供 Windows 旧版迁移提示词。当前本机实际为 1.4.15。
- 用户已明确反馈 Windows 实机安装测试且 Windows 同步记录抵达 Mac。此为基础链路的用户实测证据；本轮 Windows 升级/托盘/DPAPI 等具体行为仍未由本机自动化验收，不能继续笼统称“Windows 从未测试”。
- 修复凭证草稿被选择项提交/加载覆盖的问题；选择项只提交自身字段，失败不显示为已应用。纯文本/编辑输入框、保存并测试和取消流程保留。价格/支出/项目归并表单也沿用官方 SettingsRow。
- 左侧设备卡片与官方卡片内下拉共用页面筛选，不再写全局偏好并 reload；项目请求补齐相同 device_id。隔离界面实测：合计 750，Windows 600，点击 Mac 后下拉与总览为 150，明细同步变化；零用量设备保留。
- 自动同步的轮询、文件变化、重启共用持久化间隔；修改配置会重新调度，手动立即同步可绕过间隔；认证暂停和服务端退避保留。旧“每 5 分钟只发固定请求量”估算未覆盖文件变化/多机，不能作为免费网盘永不超限保证。
- ZCode 磁盘缓存补账号/套餐/团队指纹隔离，不保存凭证；切换凭证后失败不会显示旧账号额度。复用上游 e20958ce 的重置权益倒计时/折叠区与批次提示，保留本地化失败提示。
- upstream 经代理核对到 b2c2eb8545cee15d517f4fd6e783191c2ba30117；其余采纳/暂缓依据见 UPSTREAM.md。本轮不改采集、去重和历史存储。
- Node 全量 3708：3691 通过、17 跳过、0 失败；针对性后端 179：178 通过、1 跳过。前端最终 146 文件/1273 项通过。首轮高并发中一个已有 LeaderboardPage 用例 5 秒超时，降低到两 worker 后全量通过；首轮 UI 扫描曾把测试里的箭头表达式当文本，改为带花括号后通过，不放宽门禁。
- 类型、文案/翻译、UI、架构、版本及生产构建通过；macOS CLT 完整 Release、Windows 自包含 publish/ISCC 已通过。DMG 校验与包内资源/原生源码哈希/签名检查通过；bundled Node 22 跑间隔、设备、真实本地握手 4 项通过。正式发布与应用内升级结果在下一条补记，未完成前不算已安装。

更新时间：2026-10-29。已获用户明确授权，将审核后的 macOS/Windows 安装包发布到自己的 fork；不发布 npm、不向 upstream 写入、不覆盖安装官方应用。发布源快照分支 `codex/personal-release-20261027`，本轮标签 `personal-v1.4.17`。需求入口 REQUIREMENTS.md；验收入口 ACCEPTANCE.md；ZCode 提示词与结果审核见 ZCODE_REVIEW.md。

## 2026-10-28 Windows 实机 1.4.16 应用内升级与三项验证（本轮）

- 本机两套安装并存，已鉴别：官方版残留 `C:\Users\cyr\AppData\Local\Programs\TokenTracker\`（上游 v1.4.11+cf721ab3，无 personal.js，数据在 `~/.tokentracker`，占用 HKCU Run「TokenTracker」自启项，Codex notify hook 仍指向官方 CLI；10/25 后未再运行。本轮未卸载、未改动，是否清除待用户决定）。个人版在 `D:\01.软件\TokenTracker Personal\TokenTrackerPersonal.exe`，升级前 1.4.14+166e6c2d（当日 14:37 由 1.4.12 应用内自动升级而来；泄漏报告中的 server pid=107088 即该 1.4.14 实例，14:38 启动）。
- 升级走应用自身更新器：未改任何配置（`UpdateChecker.autoUpdateEnabled` 用户此前已开启）；系统 WinINET 代理为关，启动时注入 HTTP(S)_PROXY=127.0.0.1:7897。应用启动静默检查发现 1.4.16 → 下载 → SHA256 校验通过（b220c99c…b4f44c3，与从发布页独立下载的 SHA256SUMS.txt 一致）→ 静默安装 → 自重启 → 「up to date current=1.4.16」。安装后 exe 1.4.16+616e1423，内嵌 CLI 1.4.16（fork-view device_id 代码在位、1.4.17 草稿改动不在），统计目录与 WebDAV 配置未受影响。
- ① 设备下拉：官方 Token 总数卡片右上角出现「按设备筛选」（全部设备/蛟龙16pro(本机)/Mac）。切 Mac 后 Token 总数 4.6B/$579→3.7B/$412、日明细 10-28 行 105.7M/699→81.7M/487、模型占比与排行、热力图（active_days 88→73）、趋势数据源（daily 10-28 全量 102.6M vs Mac 78.6M）全部联动。API 层精确分区：win 207,579,733 + Mac 700,852,871 = 全量 908,432,604 token（会话 1,235+4,023=5,258）。截图 4 张见 evidence/windows-personal-1.4.16-*.png。
- ② 同步页：凭据五项默认纯文本（应用密码只显「已保存」不回显），「编辑」才出输入框（密码框空、占位「已保存；留空保留」；按钮变「保存并测试连接/取消」），取消还原且配置未动。「后台自动同步」开关（off→on）与「同步间隔」（5→15→5 分钟）在编辑态外即时保存，每次「设置已保存」，后端 config.json 与 /api/webdav/status 即时反映，结束状态 enabled=true、interval=5，与升级前一致。
- ③ 升级后同步正常：新 server 起动即同步成功（22:05，buckets seq 26→27），「立即同步」22:12 再成功，状态行「上次成功 2026-10-28 22:12 / Mac：已同步」，last_failure=null、无退避、credential_present=true。
- 泄漏线索（供下一轮排查）：18:34–19:04 该 serve 进程 node stderr 三次 `Session history warning: ZSTD_error_memory_allocation`，与冲高回落窗口吻合。升级后新 server（pid 165432，21:59 起）基线 WS≈251MB/PM≈346MB；72h 稳定性与游戏同开提交峰值验收仍待观察。
- 打包小观察（1.4.17 可顺手处理）：已装包 dashboard/dist/assets 残留 3 个旧 main-*.js（index.html 引用最新构建，功能无影响，多约 2MB 体积）；`dashboard:build` 似未清空 outDir。
- 官方版残留清除（2026-10-28 用户明确授权「官方版可以直接删了」）：Inno 卸载器静默移除 `C:\Users\cyr\AppData\Local\Programs\TokenTracker\`（注册表卸载项与开始菜单快捷方式随之消失）；手动清除运行时残留——HKCU Run 自启值「TokenTracker」、`%LOCALAPPDATA%\TokenTracker\`（224MB，含官方 WebView2/更新器下载）、`~/.tokentracker\`（127MB，官方统计数据）；并从 `~/.codex/config.toml` 的 notify 链移除指向官方 node+notify.cjs 的 `--previous-notify` 段（保留 Codex 自带 computer-use 通知）、删除 `~/.claude/settings.json` 中仅有的两条官方 hook（Stop/SessionEnd，指向已删文件）。两配置文件改前已留 `.bak-before-official-tokentracker-removal` 备份。清理后无残留引用，个人版应用与 WebDAV 同步不受影响（22:20 仍成功同步）。注意：开机自启现在没有任何 TokenTracker 生效，个人版如需自启要在应用内开启。
- 本轮零源码改动；未推送远端、未发布。结构化证据见 evidence/windows-local-install-1.4.16.json。

## 当前实现

- 保留上游全部采集器、归一化、去重、价格和分析引擎；网页保留统计、会话、额度、设置、WebDAV/设备和本地年度回顾。官方账号、云/支付、社区、宠物/皮肤/成就/灵动岛与遥测退出产品运行路径。
- WebDAV 同步桶/项目/会话/偏好；共享调度器、进程锁、30 秒防抖、5 分钟轮询、认证暂停/限流退避、校验与同版本冲突防护；导入实际进入 local-api。后台不依赖网页保持打开。
- 独立长期会话存储，删除源和不完整扫描不清历史；DSH 用量适配复用上游解析。Git 身份跨路径归并，非 Git 保持设备内身份；别名合并/拆分保留来源。
- 本机/全部/指定设备共用 API 范围；隐藏与取消隐藏跨设备同步但不扣汇总；远端会话不带本地路径或可执行恢复命令。旧手动导入与 WebDAV 共存，同设备 WebDAV 优先。
- 同进程价格刷新、来源/版本/获取时间、来源+模型自定义价格；汇总与会话总费用保留首次观察依据，支持显式重估。实际订阅/API消费与充值独立，充值不计消费，多币种分开汇总，没有自动账单对账。
- 64 MB 统计备份包含设备、桶、项目、会话和偏好，不含应用密码/正文/本地路径；只补缺失记录，不用旧备份覆盖新记录。
- 个人 CLI 和原生标识独立，默认 `~/.tokentracker-personal/tracker`、macOS :17680；不安装官方 hooks，不调用官方更新渠道。新增页面复用官方 Card、Button、ToggleSwitch、输入框和字体/主题，保持官方风格。

## ZCode 接续审核与修正

已审核接续实现的提示词、工具调用、实际代码和测试日志；检查归档、历史保留和安装包一致性。会话标识、提示词及真实用量快照仅保留在本机。

ZCode 新增的 512 MiB Codex 解压上限、后台归档回填和缺口台账已保留。但其“全部完成”报告不能直接验收：旧 macOS app/staging/DMG 没有最后两项修复，原生二进制仍监听官方队列目录；回填 soft-skip 后会错误标记完成；open 权限拒绝不进诊断台账。

本轮已修复：

1. 回填只在解析成功且无缺口时标记完成，临时失败后后台会重试。隔离复现：原实现 165 → 文件修复后仍 165 → 手动全量 465；现后台可恢复 465，重复采集稳定。
2. open/stat 失败记录为本地缺口；诊断文件原子写入，读失败不覆盖旧文件。
3. 完整重编译当前 Swift 源码，队列监控使用个人目录；宿主保留显式 HOME，使隔离验证不被强制导向真实用户目录。首次原生验证发现 HOME 被宿主覆盖后已退出并修复，没有清理或重置真实历史。
4. 新增 `scripts/build-personal-macos.py`，用 CLT 编译真实 pinned Vortex 和完整 Swift app、签名、构建 DMG，并记录 native 源文件哈希；资源 accessor 不等于替代 Vortex 行为。
5. 解锁后发现并修复原生设置残留小组件死链：直接提供官方指标选择与显示控制，保留既有归一化规则；清理账户/官方更新/日志上传文案。修复退出后自有 Node 残留：显式终止自有子进程并等待其限时退出，复验不再残留。
6. 新产物统一输出 `dist/reviewed/`，不再把旧 `dist/personal/` 或旧 installer/Output 当最终修复版。

真实历史差异尚未逐会话对账。不以一次不完整重扫清掉历史，不盲目取新旧最大值；允许有依据的统计修正。私有账本审计明细不随源码发布。

## 上游核对

经代理 fetch 到 `9dc925d89e7c526c9d5831b689a8bac427e7d8ea`。分项采纳 Qoder 格式漂移修复、Ultrafast 子集在手动传输/会话筛选中保留、GPT-6.1 Terra 本地定价、macOS ZCode Reset Credits / Start Plan 显示；不整合发布版本和云函数。价格已对照官方资料核对。其余 UI 骨架/列布局暂缓，细节与 SHA 见 UPSTREAM.md。

## 最新验证

- Node 25 全量：3700 项，3683 通过、17 跳过、0 失败/取消。新增跳过项为缺本机 Qoder CN 真实语料，不宣称该语料实测通过。
- Dashboard：144 文件 / 1256 项通过；类型、copy、locale、架构、版本、UI hardcode、bot frames 和生产构建均通过。末轮文案曾触发 App 保留术语校验，已修正并定向重跑 locale/build 通过，旧失败保留在索引 previousAttempts。
- 当前完整验证与逐项日志：`evidence/local-verification.json`。旧失败索引已经重新执行替换；ZCode 自己的 3676 项日志是历史结果，不冒充最新。
- Node 22 完整回归：以 `evidence/runtime-verification.json` 最新记录为准。
- WebDAV 双进程/真实 HTTP/local-api、历史/故障/恢复、生产前端主要流程已覆盖；页面无错误或外部请求，见 `evidence/ui-check.json`。不是坚果云实测。
- 归档复现和旧包比较：`evidence/zcode-review.json`；新包源码/资源匹配及签名检查：`evidence/artifacts.json`。

## 安装产物与实机层级

| 层级 | 当前事实 |
|---|---|
| macOS 原生构建 | CLT swiftc Release + 真实 Vortex 静态库完整编译，ad-hoc 签名验证；没有开发者公证 |
| macOS 安装镜像 | `dist/reviewed/TokenTrackerPersonal-macOS-arm64.dmg`；带 Applications 快捷方式；原生源码哈希见同目录 macos-build.json |
| macOS 挂载与后台 | 只读挂载启动，隔离个人数据目录创建，17680 后端正常；最终包内完整 src/bin/dist 与工作区逐文件比较 |
| macOS 最终界面/关窗/退出 | 用户解锁后从最终 DMG 复验：同步页、原生设置桥、指标保存/恢复正常；关窗进程/HTTP 仍在线；重新打开正常；菜单退出后宿主与自有 Node 均结束、17680 关闭，镜像已卸载 |
| Windows 构建 | .NET 8.0.132 + WindowsDesktop targets，EnableWindowsTargeting、自包含 win-x64 publish 已通过 |
| Windows 安装器 | `dist/reviewed/TokenTrackerPersonal-Windows-x64-Setup.exe`；ISCC 6.7.3 经隔离 CrossOver 编译；包含 WebView2 离线运行时及存在检测 |
| Windows runtime 冒烟 | Wine 内 node.exe 22.22.2、zstd 往返和真实 rollout 模块加载通过；不等于 Windows 实机安装/托盘/升级通过 |
| macOS Keychain | 真实系统存储中用临时测试凭据完成写入/读取、URL 隔离、删除后不可读；没有使用真实网盘凭据，见 keychain-check.json |
| Windows 实机/DPAPI、真实坚果云/双机 | 未验证，需要对应环境及用户在应用内安全配置凭据；不发送密码到聊天 |

## 接续

本机可执行的最终 macOS 界面/关窗驻留/正常退出、安装器哈希和包内资源验证已完成；不要使用旧目录产物。后续仅在真实 Windows / 坚果云 / 双机环境补验对应项，不把构建或协议夹具当实机通过。2026-10-27 用户已明确授权在自己的 GitHub fork 发布这两个安装版本；当时尚未授权覆盖安装；2026-10-28 本轮已授权本机个人版覆盖安装，npm 发布仍未授权。

个人 CLI 排查命令 `node bin/personal.js serve --no-open`；日常安装使用上述桌面产物。旧官方数据不会自动写入新目录，可通过已有导出/导入或统计备份恢复；没有日志或历史明细证据时不补造。外部验收步骤见 README.md。

## GitHub 发布

已于 2026-10-27 19:38（Asia/Shanghai）正式发布 [personal-v1.4.11](https://github.com/CYRYGBG/TokenTracker/releases/tag/personal-v1.4.11)，含 macOS arm64 DMG、Windows x64 Setup 和 SHA256SUMS.txt。三份附件均已上传，GitHub 远端 digest 与本地 SHA-256 全部一致；匿名下载 HEAD 均返回 HTTP 200。

源码快照 `a99edf0d4f54a8ed358614154917ef471c75a420` 位于 `codex/personal-release-20261027`；标签指向此快照。原有本地 main 历史保留，远端 main 未改变。没有执行 npm / Homebrew 发布，也未向原作者仓库写入。真实会话标识、真实 Token 快照和本机路径已从发布资料中移除，原始审计留在本机 gitignored 目录。公开发布与下载验证见 `evidence/release.json`；Windows 实机/DPAPI 和真实坚果云/双机验收仍按前述限制保留。

## 本机重复应用图标清理（2026-10-27）

已定位四份同 bundle ID 的个人版：Applications 正式安装版、旧 dist/personal 构建、dist/reviewed 解包产物、旧 personal-build/dmg 临时副本。原因是开发/验收留下多个可被系统索引的 .app；当时实际运行的是旧构建副本。

已通过菜单退出旧副本，注销三个开发路径的 Launch Services 登记。旧 app 与临时副本保留为 dist/app-copies.noindex 内的 .app.backup，可恢复；当前解包产物转入 dist/personal-build.noindex。系统 Spotlight 查询只返回 /Applications/TokenTrackerPersonal.app。安装版二进制与已审核发布版一致，已从 Finder 启动，原生统计窗口正常、个人后端 HTTP 200；没有删除/重置统计目录，没有退出官方版小组件。

构建脚本今后将解包 app 放入 .noindex 构建目录，DMG 创建后清理临时 staging；校验脚本按 manifest 的 appPath 找产物。已验证脚本语法、迁移后的包内资源/签名/隔离 CLI，以及既有 DMG/Setup 的 SHA256SUMS。没有改动已发布安装包；本轮只改构建工具，未重新发布。证据见 evidence/app-deduplication.json。


## 1.4.12 接续修复（2026-10-28）

- 首页官方 DeviceUsageCard 原本保留但没接 WebDAV；现显示同步设备的名称、平台、日期范围用量及同步时间，保留零用量设备。点击切换持久化全局范围，账号级用量沿用原去重。
- 恢复 macOS/Windows 个人版更新入口及可选自动更新，默认关闭；应用存活时启动及每六小时检查。只接受 CYRYGBG/TokenTracker 的 personal-vX.Y.Z 稳定发布、精确平台资产与 SHA256SUMS.txt。macOS 还校验 bundle ID、版本、签名，完整复制再替换，旧进程退出后启动；Windows 保持个人安装 GUID。
- 五小时查询和渲染未删除，但配置被实时可用性过滤。现 Codex/Claude 五小时项可预先选择，暂无额度显示横线；真实数据仍用原百分比、显示模式和倒计时，尊重隐藏厂商设置。
- Node 全量 3702 项：3685 通过、17 跳过、0 失败/取消；Dashboard 145 文件、1260 项通过；类型/文案/翻译/架构/受管版本/UI hardcode/bot frames/生产构建通过。Windows 原生 172 项通过。初次超时/性能失败与旧源码断言修正后，针对性和全量重跑通过；保留重跑说明。
- macOS 完整 CLT Release、Windows 自包含 publish / Inno 安装器重建为 1.4.12。临时目录真实签名 bundle 的 SHA/原子替换、拒绝错版本/损坏签名通过，失败保留旧安装。
- 独立 bundle ID、临时 HOME 原生验收：三设备合计 750，Windows 600、Mac 150、空闲 0；点击 Windows 后顶部范围与汇总为 600，再点恢复 750。Codex 五小时选择实际保存，自动更新开关 on/off 保存后恢复关闭，检查中按钮禁用。截图只含夹具。未配置完整 WebDAV 的夹具如实显示 partial，仍保留设备统计。
- 现有 Applications 1.4.11 未覆盖，个人统计目录未删除/迁移。旧版需先按 README 手动覆盖安装一次 1.4.12，之后应用内更新。Windows 实机升级、真实坚果云、物理双机仍未验证。

最终二进制再次原生复验：重启后 Codex 五小时选择保持；应用实际读取个人 GitHub 最新发布及校验文件，显示“1.4.12 已是最新版本”，关闭提示后设置仍保留结果。证据 personal-update-check.png / personal-device-card.png / personal-native-settings.png。没有发起真实覆盖安装或伪造未来升级。


## 1.4.12 发布完成

2026-10-28 10:14:45（Asia/Shanghai）已公开发布 [personal-v1.4.12](https://github.com/CYRYGBG/TokenTracker/releases/tag/personal-v1.4.12)，并设为 latest。源码标签指向 ee8d3a5979f3d966d2ee6828843c5fb8a485800b。macOS arm64 DMG、Windows x64 Setup、SHA256SUMS.txt 三份附件远端 digest/大小均与本地一致，匿名下载 HEAD 全部 HTTP 200；证据 evidence/release.json。

最终 DMG 的 hdiutil 校验通过；bundled Node 22 执行新的设备卡片与双进程 WebDAV/API 测试共 3 项通过。临时验收应用/夹具与偏好已清理，正式安装的 1.4.11 已恢复打开、后端 HTTP 200，Spotlight 仅返回 Applications 中一份个人版。没有覆盖原安装、删除用户统计目录、修改 main、发布 npm 或写入 upstream。


## 本机覆盖安装完成（2026-10-28 用户明确授权）

用户本轮明确要求代为安装后，已从已发布且 SHA-256 匹配的 1.4.12 DMG 覆盖安装 Applications 中的个人版。先通过原生菜单退出 1.4.11，在用户 Library/Application Support 下建立仅本机访问的 .noindex 备份（旧应用以 .app.backup 保存、统计目录及原生偏好），验证源 bundle 身份/版本/签名后完整复制并原子替换。未覆盖官方版，不清理或迁移个人统计目录，Keychain 凭据未修改。

实际安装版启动后核对：版本 1.4.12、签名有效、后端 HTTP 200，首页设备分布出现；统计与项目队列原有字节保留，长期会话身份全部保留，机器配置与 WebDAV 配置一致。session.queue 是会随正常采集重建的上游 sidecar，不用其字节变化判定历史丢失。原生第一个显示位已设为 codex5h，第二个仍为 todayCost；真实额度 API 返回 Codex 已配置且五小时窗口可用、无错误，未记录额度数值或凭据。自动更新保持默认关闭；实际检查个人 GitHub 渠道后显示“1.4.12 已是最新版本”。Spotlight 仅返回 Applications 中一份个人版。安装证据 evidence/local-install.json；含真实配置的备份路径只留本机 gitignored 安装记录，不随源码公开。


## 1.4.13 状态栏健康检查修复（2026-10-28）

用户发现状态栏弹出面板误报“服务器不可用”。复现时进程与本地 API 正常，但 macOS APIClient.checkServerHealth 仍请求已移除的官方账号接口 /functions/tokentracker-user-status，得到 404，因此 ServerManager 标为 failed，面板不进入统计分支。此前验收网页/更新入口而未覆盖真实状态栏内容，遗漏了此故障；此前 /health 的 200 是 SPA HTML 回退，不能作为 API 就绪证明。

已改为独立 LocalServerHealth，通过上游 CLI 已使用的 /api/local-auth JSON 握手检查非空 token 和与 app 一致的 serverVersion，拒绝网页 HTML、404、字段缺失与错版本。没有恢复官方账号接口，也没有重写采集器。离线提示改为应用内置服务，不再指导另装官方 CLI。Windows 健康检查不使用已删账号接口，本轮只同步版本与打包。

真实本地 API + Swift 帮助模块回归，以及原生端口/设置桥/更新校验/真实 serve 重装相关测试共 22 项通过；另含本地化定向 12 项通过，受管版本一致，dashboard 生产构建通过。macOS 完整编译、Windows publish 已通过；安装器与实际应用内升级/状态栏面板验收在接续步骤记录。


## 1.4.14 ZCode 面板可见性修复（2026-10-28 本轮）

用户报告 macOS 状态栏限额区只剩 Codex、ZCode 整段消失。诊断：API 侧 ZCode 数据健康（真实抓取成功），但 ZCode 是唯一没有磁盘缓存兜底的限额 provider——配额端点一次瞬时失败（5xx/超时）就产生顶层 error，Swift 按官方"隐藏出错厂商"的设计整段不渲染（当时 Claude 也因 token 过期被隐藏，故只剩 Codex）。Claude/Codex/OpenCode Go 均有 7 天磁盘缓存的 stale 兜底，ZCode 缺席。

修复（沿用同仓库既有模式）：
- `usage-limits.js`：新增 `zcode-usage-limits-cache.json` 磁盘缓存（trackerDir 优先，同 OpenCode Go；7 天上限；过期窗口/桶剔除；未安装不得凭缓存复活）。抓取成功写缓存并标 `stale:false`，失败读缓存标 `stale:true`，无缓存才落回错误。
- Swift `ZcodeLimits` 解码 `stale`/`cached_at`，面板按 Codex 同款透传数据年龄；不再静默消失而是显示旧数据+过期标记。
- 顺带修复工作树遗留的编译错误：上轮 Grok 剩余模式移植删了 `limitRow` 的 `productPool` 参数但漏改 Start-plan 授权区块调用点（上游 #904 已同步清理，本轮对齐）。

验证：新增 2 项 node 集成测试（失败后从缓存恢复+标 stale；未安装时缓存不得复活）；usage-limits 172 项全过（171 过 1 跳过）；zcode-limits/reset-credits 77 项全过；node 全量 3706 项 0 失败；dashboard vitest 1261 项全过（首轮 1 项超时抖动，复跑两轮全绿，同 STATUS 既有记录的重跑模式）；macOS 完整 CLT Release 构建通过并产出 DMG。upstream 核对见 UPSTREAM.md（#904 已等价落地、#899 不适用）。

尚未做：本轮修复只进了源码与本地构建产物，未提交 GitHub 发布、未覆盖安装本机应用（等用户对发布安排的授权）；Windows publish 与真实发布校验在发布步骤执行。

补充：`ci:local` 首跑卡在 ui-hardcode——上轮 `/devices` 重定向把 JSX 三元换行成 `) : Page ? (` 独立行，被扫描器当作裸文本节点（与上游 #904 提交说明里提到的同类误报）。已把 App.jsx 的嵌套三元改为提前计算 `content`（重定向逻辑不变），扫描器归零；guardrails/versions/bot-frames/架构测试/dashboard 生产构建全部通过，App+SettingsPage 前端测试 21 项通过。


## 1.4.14 GitHub 发布完成（2026-10-28 用户授权）

2026-10-28 13:40（Asia/Shanghai）前后已公开发布 [personal-v1.4.14](https://github.com/CYRYGBG/TokenTracker/releases/tag/personal-v1.4.14) 并设为 latest。标签指向 `166e6c2d`，分支同步推送至远端。三份附件（macOS arm64 DMG、Windows x64 Setup、SHA256SUMS.txt）远端 digest 与本地 SHA-256 全部一致，匿名下载 HEAD 均 HTTP 200；证据 `evidence/release.json`、`evidence/windows-package-1.4.14.json`。

构建链：macOS CLT Release 重新构建（含本轮全部源码与最新 dashboard，挂载验证版本/资源）；Windows 走 `EnableWindowsTargeting` 自包含 publish + `verify-windows-package.cjs`（311 项嵌入文件与源码逐字节一致）+ CrossOver win10 bottle 内 ISCC 6.7.3 编译 + Wine 冒烟（bundled node 22.22.2 加载真实 CLI 模块）。本轮工具链事实：本机原 Inno bottle 已不存在；CrossOver `cxbottle --create` 不指定模板时是 win98，会导致 Inno 6.7.x 安装器报 Error 120（Call not implemented），必须用 `--template win10`（或 win10_64 跑 64 位 node）。`verify-windows-package.cjs` 已对齐 fork 实际产物名（TokenTrackerPersonal.exe、无 pet/quota 页）。

personal-v1.4.13 草稿（含旧附件）已按授权删除，由 1.4.14 取代；1.4.13 本地安装版会被本版的应用内更新直接覆盖升级。未做：Windows 实机升级验证、本机应用内更新动作（用户侧手动检查更新即可验证）。npm 未发布、main 未改动。


## 1.4.15 同步设置页优化（2026-10-28 用户反馈驱动）

用户对"同步与设备"页提出三点：参数易误改、保存/保存并测试重叠、状态行机器码与 UTC 秒级时间难读；并要求间隔可选（坚果云免费版请求配额考虑）。

实现：
- WebDAV 卡片全部参数默认只读（字段 readOnly、开关与间隔禁用），"编辑"解锁；编辑态为"保存并测试"（合并原有两个重叠按钮，保存必测）+ "取消"（还原并回锁）。"立即同步"保持常驻。
- 新增同步间隔选择：5/15/30 分钟、1/2/6/12/24 小时（interval_minutes 存量非预设值保留可选）；调度器每轮重读配置，改动对下一轮即时生效；默认仍 5 分钟。坚果云免费版约 600 请求/30 分钟，5 分钟间隔约 42-66 次/30 分钟（≈7-11%），24 小时间隔更进一步降低。
- 状态区：上次同步时间本地化到分钟（YYYY-MM-DD HH:mm）；导入设备显示 device.json 里的名称（后端 /api/webdav/status 新增 device_names，失败不影响状态返回）；同步失败单独一行、附错误代码。
- 新增 ForkSyncPage 专项测试 7 项（锁定/解锁、保存并测试、取消还原、间隔预设与存量值、时间格式、设备名、失败行）；删除孤儿文案键 fork.personal.fadf24dbc5，新增 6 键五语言全覆盖。

验证：dashboard 1268 项全过（首轮 1 项超时抖动复跑全绿，同既有记录）；node 全量 0 失败；copy/locale/ui-hardcode/guardrails/versions/bot-frames/架构全部通过；双平台构建 + 包校验（311 文件逐字节一致）。

发布：personal-v1.4.15 已公开发布并设 latest，标签 29098132，远端 digest 与本地一致、匿名下载 HTTP 200（证据 release.json）。1.4.13/1.4.14 用户可应用内更新直接升级。未做：本机应用内更新动作（用户手动触发即验证）、Windows 实机升级。


## 1.4.16 官方设备下拉回归 + 同步页凭据只读（2026-10-28 用户反馈驱动）

用户三点新要求：①同步页凭证字段（服务地址/用户名/同步目录/设备名称/应用密码）未编辑时不应显示输入框；②后台同步/同步间隔/同步会话标题属选择项，无需编辑状态即可改；③仪表盘移除页首「统计范围」选择器，沿用官方多设备交互，在 Token 总数卡片位置加官方风格设备下拉。

实现：
- ForkScope 顶栏只保留实际付费与同步异常状态；启动时若存量偏好非 all 一次性复位（旧选择器入口已移除，防止陈旧偏好静默过滤无参调用方）。
- 官方 `UsageOverview` 卡片头部本就内置设备 `Select`（fork 此前用 `showDeviceFilter = !forkDeviceView` 硬关）；fork 本地视图改为从 `/api/fork/view` 取 WebDAV 设备列表（≥2 台显示），选择走客户端状态，随 `device_id` 参数按请求生效于 usage/daily/trend/heatmap/model-breakdown/context-breakdown。
- 后端 `fork-view scope()` 接受 `device_id`，但只接受真实存在的设备（本机 machineId / WebDAV 导入 / all / local）；未知 id（云时代遗留）保持既有本地回退——这是 local-usage-transfer 测试钉死的契约，首版实现曾破坏该测试后修正。
- 同步页：凭据行未编辑渲染纯文本（密码只显示「已保存/未配置」，不回显），编辑才挂输入框；开关与间隔 `disabled={busy}` 即时 PUT；「立即同步」不再附带写配置。复用既有文案键（cb84a961b0「设置已保存」、limits.apiKey.saved「已保存」），删除 3 个选择器专用键（174fd6f85c/fb9b2c7f31/8b4c1c5f0c），无新增键。

验证：dashboard 1268 项全绿（复跑两轮）；node 全量 3707 项 0 失败（含新增 device_id 作用域测试）；copy/locale/ui-hardcode/guardrails/versions/dashboard 生产构建全部通过。插曲：全量跑 SettingsPage 1 项偶发失败——根因是该用例点击未包 act（相邻用例均包），新增重写测试文件改变 worker 调度后暴露；补 act 包裹后连续两轮全绿（git stash 对照确认改动前树同样存在该竞态概率）。

发布：personal-v1.4.16 已公开发布并设 latest，标签指向 bbdc06b3，分支已推送。三附件远端 digest 与本地一致，匿名下载 HEAD 302（GitHub 对象存储标准重定向）。Windows 包校验 311 项字节一致 + tt-smoke64 Wine 冒烟加载改动后 CLI（1.4.16）。未做：本机应用内更新动作、Windows 实机验证（用户在 Windows 机器上经应用内更新即可验证本轮 UI）。
