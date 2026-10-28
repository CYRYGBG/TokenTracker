# 个人版启动与外部验收

## 当前安装包

当前修复版统一位于 `dist/reviewed/`：macOS Apple Silicon 使用 `TokenTrackerPersonal-macOS-arm64.dmg`，Windows x64 使用 `TokenTrackerPersonal-Windows-x64-Setup.exe`。旧 `dist/personal/` 和旧 `TokenTrackerWin/installer/Output/` 尚未包含全部审核后修复，不作为本次交付版本。最终校验见 SHA256SUMS.txt 和 `evidence/artifacts.json`。macOS 最终包已完成页面、指标设置、关窗驻留、重开、正常退出/自有 Node 清理；Keychain 用临时测试凭据完成真实存储回归。Windows 实机/DPAPI 与真实坚果云/双机仍未验证。

macOS 是个人本地 ad-hoc 签名产物，未做开发者公证。Windows 安装包包含 .NET、Node 和 WebView2 离线运行时；不需要另外安装 Node。两者均未自动覆盖安装到你的应用目录，实机验证范围见 STATUS.md。

CLT 可复现 macOS 完整构建：先 `npm run dashboard:build` 和既有 EmbeddedServer 打包，再运行 `python3 scripts/build-personal-macos.py`。无需切换系统 Xcode；脚本编译 project.yml 相同 pinned Vortex 真实源码，检查下载校验和并记录所有 native 源码哈希。

这是 WebDAV 个人同步 fork，功能和限制以 REQUIREMENTS.md、STATUS.md、ACCEPTANCE.md 为准。不会自动发布或覆盖原官方应用。

## 本地启动

```bash
npm run dashboard:build
node bin/personal.js serve --no-open
```

访问 `http://127.0.0.1:17680`。同步与设备：`/devices`；会话：`/sessions`；基础设置与旧手动导入导出：`/settings`。首次采集可能需要等待。`--no-sync` 只跳过启动采集，后台进程仍负责后续采集；关闭网页不退出进程。Ctrl-C 正常退出。

个人入口使用 `~/.tokentracker-personal`。`bin/tracker.js` 是兼容引擎入口，单独直接运行且没有 `TOKENTRACKER_PERSONAL=1` 时仍会使用旧目录；日常使用请走 personal.js。旧应用的 7680 和新个人服务的 17680 分离。

在同步页填 HTTPS WebDAV 服务地址、用户名、应用密码、目录、设备名，保存并测试，再启用自动同步。真实坚果云密码不发聊天。标题可选择不同步；此前已上传的标题可能仍保留在网盘历史版本/备份中，关闭开关不承诺擦除旧版本。

订阅付款、API 实际消费和充值在同页手动记录；金额不能由 Token 倒推。充值不进入支出合计，模型估值也不加进支出。自定义单价单位是 USD / 百万 Token，仅作用于填写的工具来源与模型。刷新价格表不会自动重写历史估值；“重新估算汇总”是明确的重估动作。

## 隔离自动验证

```bash
node scripts/fork-verify-local.cjs
node scripts/fork-ui-smoke.cjs
node scripts/fork-artifacts.cjs
```

第一条执行完整 Node/Dashboard 回归、类型/文案/架构/版本校验及生产构建，日志写临时目录，索引写 `evidence/local-verification.json`。第二条需要 Playwright 浏览器，可用 `TOKENTRACKER_BROWSER_EXECUTABLE` 指定 Chromium；使用临时 HOME、真实 local-api 和协议夹具检查远端会话、范围、隐藏等，截图写 `evidence/`。第三条需要先运行下述 EmbeddedServer 打包，核对源代码及资源哈希，并用打包的 Node 启动隔离个人 CLI。都不访问真实会话/网盘，不代替原生 app 或坚果云验证。

## 备份与迁移

新版“导出备份”包含统计、项目、会话和偏好，最大 64 MB，不含应用密码、原始对话和本地绝对路径。恢复只补缺失记录，不覆盖现有记录。另一设备的备份作为独立设备导入，不冒充本机。恢复后的远端/无源会话没有可在本机执行的恢复命令。

旧版导入导出只覆盖其原本支持的用量桶，不能声称它能找回未采集的会话明细。旧源日志还在时，个人版会重新扫描；没有原始日志或之前保留的明细时不能补造。

## macOS 验收（Xcode 工程方式；CLT 构建见文首）

```bash
npm run dashboard:build
HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 bash TokenTrackerBar/scripts/bundle-node.sh --arch arm64
cd TokenTrackerBar
xcodegen generate
ruby scripts/patch-pbxproj-icon.rb
xcodebuild -project TokenTrackerBar.xcodeproj -scheme TokenTrackerBar -configuration Debug -derivedDataPath /tmp/tokentracker-personal-derived CODE_SIGNING_ALLOWED=NO build
```

产物应为 `/tmp/tokentracker-personal-derived/Build/Products/Debug/TokenTrackerPersonal.app`。先直接运行独立产物，不拖入覆盖安装。检查菜单栏、面板、统计窗口共用范围；关窗后修改测试源，再等待采集和 WebDAV；唤醒后确认继续采集；退出后确认服务退出；验证开机启动设置刷新。实际 Keychain 存取及系统授权提示单独记录，未通过不得写通过。

## Windows 验收（需要 Windows + .NET 8 WindowsDesktop SDK）

```powershell
dotnet build TokenTrackerWin/TokenTrackerWin.csproj
npm run dashboard:build
powershell -File TokenTrackerWin/scripts/bundle-node.ps1
```

按脚本实际输出目录检查 EmbeddedServer 中的 Node、src 和 dashboard 版本。不要执行正式发布或安装覆盖操作。先运行独立 Debug 产物，检查托盘、完整窗口、关窗驻留、同步范围、退出/重启、DPAPI 当前用户绑定、URL scheme 和开机启动。`TokenTrackerPersonal.exe` 及安装器 AppId 与官方版分离。本轮已在 macOS 上完成跨平台 publish 与安装器编译；这些构建和 Wine 冒烟不能代替 Windows 实机操作。

## 坚果云与真实双机

两端应用设置中安全填写同一个同步根目录及各自设备名；不要复制原始 AI 对话目录或 machineId 配置。A/B 各产生可辨认的测试用量，双向同步后核对设备、项目、会话与金额。对同一项目用不同本地路径，确认归并；不同仓库同名保持独立；归并/拆分、隐藏/取消隐藏应两端收敛且总量不变。重复同步、退出重开、断网恢复、旧备份恢复不能翻倍。全部设备/本机/指定设备数字在状态栏、托盘与网页应一致；失败应保持已存历史并显示错误。

真实网盘只做非破坏性测试，使用独立测试同步目录；不清理用户已有网盘数据。全部完成后再把 ACCEPTANCE.md 的对应项改为通过。

## GitHub 下载

本轮授权发布标签为 `personal-v1.4.11`，目标 [GitHub Release](https://github.com/CYRYGBG/TokenTracker/releases/tag/personal-v1.4.11)。macOS Apple Silicon 选择 DMG；Windows x64 选择 Setup.exe。二者均内含 Node 运行时，Windows 安装器含 WebView2 离线运行时。安装前可用同页 SHA256SUMS.txt 校验。macOS 打开 DMG 后拖入 Applications；WebDAV 凭据只在应用内填写。

## 避免本机出现重复应用图标

安装后日常只从 /Applications/TokenTrackerPersonal.app 启动。构建脚本将未安装的 .app 保留在 dist/personal-build.noindex，交付目录 dist/reviewed 只保留安装器与报告；DMG 临时目录完成后自动清理。不要从旧 dist/personal 目录运行。已有旧开发副本可先正常退出、注销对应应用登记，再移入不参与索引的备份目录；不要删除统计数据目录。

## 1.4.12 及后续更新

1. 从自己的 [GitHub Releases](https://github.com/CYRYGBG/TokenTracker/releases/latest) 下载：Apple Silicon Mac 用 `TokenTrackerPersonal-macOS-arm64.dmg`，Windows x64 用 `TokenTrackerPersonal-Windows-x64-Setup.exe`。
2. 1.4.11 首次升级：先在状态栏/托盘菜单正常退出。Mac 打开 DMG，将个人版拖进 Applications 并选择替换，随后弹出镜像、从 Applications 打开；Windows 运行新版 Setup，安装至原个人版目录。无需先卸载，不删除个人数据目录。
3. 从 1.4.12 开始，在「设置 → App → 检查更新」或原生菜单中检查；自动更新默认关闭，可在同页开启，启用后在启动及运行中每六小时检查。只接受自己的个人稳定发布，不进入官方更新渠道。网络、校验或权限失败时保留安装及数据，可重试或用同一发布页手动覆盖安装。
4. 自己继续开发时，递增版本并同步受管版本文件，测试/构建后发布 `personal-vX.Y.Z`（非草稿、非预发布）。每个发布同时附上上述两个固定文件名和 `SHA256SUMS.txt`；其中按标准 sha256sum 格式列出安装包哈希。设置为 latest。不要覆盖已发布标签或遗漏校验文件，否则更新器会拒绝安装。
5. 五小时额度：在「设置 → App」开启菜单栏统计，为第一个或第二个位置选择「Codex 5 小时限额」或「Claude 5 小时限额」；也可在状态栏右键菜单配置。横线表示本机无法取得对应账号额度，先在对应工具登录后刷新限额页；额度页中被主动隐藏的工具不会展示。

macOS 当前为 ad-hoc 签名、未公证；Windows 安装包未签名。Windows 实机升级、真实坚果云和物理双机仍需对应环境验证。
