# 个人同步版验收矩阵

## 2026-10-28 用户实测事实补充

用户在接续会话明确反馈：Windows 已在前一晚安装测试，Mac 已出现同步过来的 Windows 记录。因此真实 Windows 安装与跨设备基础同步已有用户实测证据；下文历史“全部未验证”表述不能覆盖该事实。尚未逐项验证的本轮 Windows 升级/托盘/关窗后台/DPAPI 故障恢复，以及项目/会话/隐藏的全链路一致性仍保持原边界，不用构建或 Wine 代替。

更新时间：2026-10-27。接手基线 `main` / `bc5ad2f0`，当时工作区干净。本轮改动保留在工作区，没有推送、发布或覆盖安装。历史成功声明不作为本轮证据。

**验证通过**仅限列出的自动化/浏览器范围；**需外部条件验证**不能由语法解析或网页构建替代。

## 当前环境验证

| 需求 | 代码入口 | 验证方式 | 当前状态、证据和剩余 |
|---|---|---|---|
| 上游变化先核对 | `UPSTREAM.md` | 只读 fetch + 提交比较 | 验证通过：2026-10-27 fetch 到 `9dc925d89e7c526c9d5831b689a8bac427e7d8ea`；分项采纳 Qoder、Ultrafast、本地定价和 ZCode 原生额度修复，见 UPSTREAM.md |
| 全工具采集/归一化/去重 | `rollout.js`、`sync.js`、`pricing/` | Node 25 与嵌入式 Node 22 完整回归，保留统计测试 | 验证通过（夹具）：两轮均 3700 项，3683 通过、17 跳过；见 local/runtime-verification.json；没有逐工具真实账单核对 |
| 连续扫描、源删除、重启后保留 | `fork-view.js`、`fork-dsh-sessions.js` | DSH 日志夹具；两进程删源和重启 | 验证通过：`fork-prefs-pricing.test.js`、`fork-end-to-end.test.js`；未采集数据不会补造 |
| 桶/项目/会话/偏好双向链路 | `webdav/scheduler.js`、`sync-store/`、`local-api.js` | 两个 HOME、两个 Node 进程、真实 HTTP WebDAV 和 API | 验证通过：`fork-end-to-end.test.js`，导入文件实际被读取；不是坚果云或真实双机 |
| 重复/旧版本/版本冲突/原子导入 | `sync-store/importer.js`、`fork-store.js` | 重复周期、校验/身份/版本冲突、写失败 | 验证通过：不重复累计；缺前序或内容冲突不提交，失败保留历史 |
| 设备及备份恢复 | `scheduler.js`、`fork-backup.js`、`fork-view.js` | 删除临时状态、恢复、两次同步、重启；同总量模型修正 | 验证通过：自身恢复可经 API 读取；旧备份只补缺；导入不作为本机回传 |
| 离线/认证/限流/服务错误 | `webdav/client.js`、`scheduler.js` | 401、429 Retry-After、503、截断、损坏文件、篡改 | 验证通过：暂停/退避、部分失败可见，恢复后收敛；真实网络条件待验 |
| 变化触发和后台调度 | `serve.js`、`scheduler.js` | 调度回归、零变化请求检查、代码核对 | 验证通过（服务层）：30 秒防抖、5 分钟轮询，不依赖页面挂载；原生生命周期另列 |
| 项目归并/区分/拆分 | `privacy.js`、`fork-prefs.js` | 跨路径同 Git、同名不同仓库、非 Git、别名夹具 | 验证通过：仓库身份区分，非 Git 使用设备及路径哈希；别名保留来源 |
| 明细与设备范围 | `fork-view.js`、会话 API/UI | API 三范围、项目/会话/模型数据、生产页面 | 验证通过（API/网页）：远端无本地路径/恢复命令；原生面板待验 |
| 隐藏/取消隐藏不扣汇总 | `fork-prefs.js`、会话 API/UI | 双端隐藏/取消、显示隐藏项、重启、总量比较 | 验证通过：Lamport 事件收敛，列表筛选在汇总后执行 |
| 同进程价格刷新/离线回退 | `pricing/index.js`、`litellm-fetcher.js` | 两版价格、负缓存、离线获取时间回归 | 验证通过：来源/内容版本/获取时间可查，TTL=0 真正刷新 |
| 自定义价和历史估值 | `fork-costs.js`、`fork-prefs.js` | 来源+模型、价格更新、跨设备合计、显式重估 | 验证通过：汇总和会话总费用保留首次观察依据；不是历史当时价格或账单；细分仍按上游能力 |
| 订阅/API消费/充值分开 | `fork-prefs.js`、`ForkSyncPage.jsx` | 双端 ID/编辑/去重/多货币；生产页面保存编辑重载 | 验证通过：充值不计支出，估值不加入支出；自动账单对账未实现且不宣称存在 |
| 官方功能退出运行入口 | `App.jsx`、sidebar、native bridge、两端菜单、Vite | 路由回归、构建、入口核对、浏览器联网 | 验证通过（自动化/网页）：无登录阻断和官方外发，旧路由回本地；原生实机另列；历史未引用源码和发布脚本保留 |
| API 防护和同步隐私 | `local-auth.js`、`privacy.js`、`fork-backup.js` | 安全回归、正文/路径/凭证 URL/嵌套恶意字段 | 验证通过：白名单；HTTPS（环回测试例外）；凭据不随重定向外发；不引入内容加密 |
| 备份/恢复与写失败 | `fork-backup.js`、`fork-store.js`、原生导出桥 | 隐私/补缺/幂等/原子写失败；浏览器下载恢复 | 验证通过：64 MB 上限，无密码；已有记录保留；真实 OS 凭证另列 |
| 旧手动导入共存 | `local-usage-transfer.js`、`fork-view.js` | 既有导入和读取回归 | 验证通过：同设备 WebDAV 优先避免重复；旧桶备份没有会话明细 |
| 个人身份/数据隔离 | `bin/personal.js`、`tracker-paths.js`、两端配置 | 真实 CLI 临时 HOME 启动、旧配置哨兵、退出 | 验证通过（CLI）：新目录/端口，不修改 hooks；原生安装级隔离待验 |
| 网页主要流程 | `scripts/fork-ui-smoke.cjs` | 生产 assets + 真实 local-api + 测试 WebDAV | 验证通过：`evidence/ui-check.json` 和四张截图；设置/同步、支出编辑重载、备份恢复、远端会话与明细、隐藏/取消及三个范围，零页面错误/外部请求 |
| 前端回归/类型/校验/构建 | `scripts/fork-verify-local.cjs` | 全量套件和逐项校验 | 144 文件/1256 项；类型、copy、locale、guardrails、versions、UI hardcode、bot frames 和构建结果见 `evidence/local-verification.json` |

## 构建与外部条件

| 需求 | 代码/步骤 | 当前状态 | 证据与准确限制 |
|---|---|---|---|
| macOS 工程和 Swift 语法 | XcodeGen + icon patch、Swift parser | 验证通过 | Widget target 已移除；语法解析不做完整类型检查 |
| EmbeddedServer arm64 | `TokenTrackerBar/scripts/bundle-node.sh --arch arm64` | 验证通过 | `evidence/artifacts.json` 记录 Node 22.22.2、源码和资源哈希一致性及隔离启动/退出；不是 `.app` |
| macOS app 完整编译/签名/运行 | build-personal-macos.py | 编译、签名、只读卷启动验证通过 | CLT 完整 Release 构建；最终 DMG 原生页面、关窗驻留、重开和正常退出通过；未公证，未覆盖安装 |
| Windows 原生完整构建 | `TokenTrackerWin.csproj` | 构建通过 | .NET 8 + WindowsDesktop targets，自包含 win-x64 publish；ISCC 安装器通过；Wine 运行时检查不等于 Windows 实机 |
| 原生范围/菜单/生命周期 | 两端 ServerManager/面板/菜单 | macOS 部分实测通过 | 最终 DMG 设置桥/指标保存/关窗驻留/重开/菜单退出及自有 Node 清理通过；唤醒、开机启动、Windows 实机仍待验证 |
| Keychain / DPAPI | `webdav/credential-store.js` | macOS Keychain 实测通过；DPAPI 待验 | 真实 Keychain 临时测试凭据写入/读取、URL 隔离及删除后不可读通过；未用真实网盘凭据，Windows DPAPI 需实机 |
| 真实坚果云 HTTPS | 应用 `/devices` 设置 | 需外部条件验证 | 需在应用内安全配置；协议夹具不能证明坚果云兼容性 |
| 真实 Mac↔Windows 双机 | README 双机步骤 | 需外部条件验证 | 需第二台设备及两端原生产物；不复制原始对话目录 |

新增归档错误后恢复、权限错误诊断、旧包不一致与源码重建的复核见 ZCODE_REVIEW.md。当前安装产物仅使用 dist/reviewed/，旧 dist/personal/ 不作为修复版。

原生检查结果另见 `evidence/native-checks.json`。没有创建额外后台服务/定时任务，未覆盖安装、清理或重置真实历史。首次原生隔离验证发现 HOME 覆盖后已退出修复；ZCode 此前可能误停实例的操作见 ZCODE_REVIEW.md。跨夜休眠导致超时/取消的旧日志已废弃为通过证据；本表引用随后限制并发完整运行的结果。

2026-10-27 解锁后补验：真实 macOS Keychain 的临时测试凭据写入/读取、URL 隔离和清理通过，见 `evidence/keychain-check.json`；DPAPI 未实测。原生设置的小组件死链与退出残留已修复并重建最终包，见 `native-checks.json` 与 `native-app-settings.png`。

2026-10-27 用户授权 GitHub 分发已完成：`personal-v1.4.11` Release 正式公开，macOS/Windows 两附件和校验和远端 digest 一致，匿名下载均 HTTP 200，见 `evidence/release.json`。发布不改变未实测的平台/真实网盘验收状态。


## 1.4.12 新增验收

| 项目 | 结果 |
|---|---|
| WebDAV 左列设备卡 | 原生三设备合计 750，远端 600，清除恢复 750，空闲设备保留；真实 API 回归通过 |
| 账号级用量 | 卡片与合并桶总量一致，Cursor 跨设备 MAX 不相加 |
| 五小时指标 | 无凭据仍可选择 Codex 五小时，原生偏好保存 codex5h；不伪造额度 |
| 更新校验 | macOS 精确 URL/标签、SHA、真实签名 bundle 原子替换及拒绝坏包；Windows 172 项通过 |
| 原生桥 | 自动更新 on/off 保存并恢复关闭，检查中按钮禁用 |
| 完整回归 | Node 3685 pass / 17 skip，Dashboard 1260 pass，发布前检查通过 |
| 实机边界 | Windows 升级、真实坚果云/物理双机、未来发布的无人值守升级尚未实测 |
