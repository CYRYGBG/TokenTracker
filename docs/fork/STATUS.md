# STATUS — 个人同步版事实状态

更新时间：2026-10-28。已获用户明确授权，将审核后的 macOS/Windows 安装包发布到自己的 fork；不发布 npm、不向 upstream 写入、不覆盖安装官方应用。发布源快照分支 `codex/personal-release-20261027`，标签 `personal-v1.4.11`。需求入口 REQUIREMENTS.md；验收入口 ACCEPTANCE.md；ZCode 提示词与结果审核见 ZCODE_REVIEW.md。

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

本机可执行的最终 macOS 界面/关窗驻留/正常退出、安装器哈希和包内资源验证已完成；不要使用旧目录产物。后续仅在真实 Windows / 坚果云 / 双机环境补验对应项，不把构建或协议夹具当实机通过。2026-10-27 用户已明确授权在自己的 GitHub fork 发布这两个安装版本；覆盖安装与 npm 发布仍未授权。

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
