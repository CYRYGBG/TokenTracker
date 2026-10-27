TokenTracker 个人同步版，基于上游统计引擎，保留用量、项目、会话与额度分析，通过自己的 WebDAV 同步设备统计。

## 下载与安装

| 设备 | 下载文件 | 安装方式 |
| --- | --- | --- |
| macOS Apple Silicon（M 系列 / arm64） | `TokenTrackerPersonal-macOS-arm64.dmg` | 打开 DMG，将应用拖入 Applications |
| Windows x64 | `TokenTrackerPersonal-Windows-x64-Setup.exe` | 双击安装程序，按向导安装 |

两端均自带 Node 运行时，无需安装开发环境。Windows 安装程序包含 WebView2 离线运行时。macOS Intel / Windows ARM 安装包不在本次附件中。

## 本版功能

- WebDAV 同步设备、用量、项目、会话和偏好；网盘应用密码保存在平台安全存储中。
- 长期保留已采集历史；归档回填、临时读取失败后重试、本地采集缺口诊断。
- 本机 / 全部 / 指定设备范围；项目归并与拆分、会话隐藏及恢复。
- 价格来源和刷新、自定义单价、实际支出记录、统计备份与恢复。
- 移除官方 TokenTracker 账号、付费云同步、排行榜、宠物及遥测；新增页面沿用官方组件与主题。
- 修复 macOS 设置通向已删除小组件页，以及退出后自有 Node 残留。

## 使用说明

启动后从菜单栏 / 托盘进入；WebDAV 在“同步与设备”页面配置。只同步统计明细，不同步对话正文、代码或原始会话目录。个人数据目录与官方版隔离，不会自动导入官方版旧目录；已有历史可用原有导出/导入功能迁移。缺少原始日志或历史明细证据时不会补造记录。

## 验证与限制

- Node 回归：3683 通过、17 跳过、0 失败；Dashboard：1256 通过，类型、文案、架构、版本校验及生产构建通过。
- 最终 macOS DMG 已实测页面、原生指标设置、关窗驻留、重开、正常退出及自有后台进程清理；Keychain 临时测试凭据读写、隔离与删除通过。
- Windows 已完成自包含构建、安装器编译与 Wine 内运行时冒烟；Windows 实机安装/托盘/DPAPI 尚未实测。
- WebDAV 已通过隔离双设备与故障夹具测试；真实坚果云和 Mac↔Windows 双机仍需实测。
- macOS 为本地 ad-hoc 签名，未做 Apple 公证；Windows 安装器未做商业代码签名，系统可能提示无法验证发布者。
- 旧账本差异未逐会话核对；不以不完整重扫清除历史，也不直接取新旧最大值。

## SHA-256

下载 `SHA256SUMS.txt` 核对安装文件完整性：

```
92065a8703f3793acb025fddc5c57a327f19cc2e23d8901b1a401397376e895e  TokenTrackerPersonal-macOS-arm64.dmg
803f6cea03579c0938a7cb610dc3c4f77ea59a2727a56a2bc56542e6899e0c4e  TokenTrackerPersonal-Windows-x64-Setup.exe
```

源码快照在独立发布分支，沿用应用内部版本 1.4.11，Release 标签为 personal-v1.4.11。本次只发布到个人 fork 的 GitHub Releases，不发布 npm 或原作者渠道。

Source snapshot: [a99edf0d4f54](https://github.com/CYRYGBG/TokenTracker/tree/a99edf0d4f54a8ed358614154917ef471c75a420).
