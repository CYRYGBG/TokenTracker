# WebDAV 多设备同步设计（SYNC_DESIGN）

> fork 的同步架构权威文档。术语"设备"= 一台运行本工具的 Mac/Windows 机器（machineId，复用上游 `src/lib/machine-id.js`）。
> 实现模块：`src/lib/webdav/`（传输与调度）、`src/lib/sync-store/`（导出/导入/合并）。对 `sync.js`/`local-api.js` 只做最小接入。

## 1. 设计原则

1. **每设备只写自己的目录**，其他设备只读。无共享可写文件 → 无写写冲突。
2. **整行 upsert、永不删除**：沿用上游 queue.jsonl 已验证的"最后一条 per key 胜"读端语义与云端 ingest 幂等语义。缺失的 key ≠ 删除（源记录不可用/被删不抹历史）。
3. **导入数据与本机采集结构性隔离**：导出器只读本机 `queue.jsonl`/`project.queue.jsonl`/`session.queue.jsonl` 及本设备长期明细；导入存储在独立目录 `webdav/imports/`，导出器永不读它 → 导入数据不可能再次被当作本机用量导出。
4. **不按本机时钟判新旧**：优先级 = (设备内单调 sequence, 内容规则)；时间戳仅作展示。
5. **不假设 WebDAV 可选能力**：条件写（If-Match）不依赖；以"只写新文件名（不可变版本）"实现原子发布。逐项探测（OPTIONS/PROPFIND）并记录服务端能力。
6. **有变化才传输**：内容哈希比对，未变化周期零上传；下载侧只取 sequence 大于已导入的新文件。

## 2. WebDAV 文件布局

```
<同步目录>/tokentracker-fork/
  devices/
    <machineId>/
      device.json                 # {format, name, platform, app_version, updated_at}（设备改名随导出更新）
      buckets-base-<seq>.jsonl    # 全量快照：该设备小时桶当前真值（去重后）
      buckets-seg-<seq>.jsonl     # 增量段：自 since_seq 以来变化的整行（upsert 语义）
      projects-base-<seq>.jsonl   # 项目×source×小时 桶（同上）
      projects-seg-<seq>.jsonl
      sessions-base-<seq>.jsonl   # 脱敏会话明细（整记录 upsert by session_hash）
      sessions-seg-<seq>.jsonl
      prefs-base-<seq>.jsonl      # 偏好事件快照（隐藏/别名/价格/支出）
      prefs-seg-<seq>.jsonl       # 当前实现为完整 upsert 集，不使用隐式删除
```

- 设备发现 = PROFIND `devices/`（无需共享清单文件）。
- **sequence**：每设备单调递增整数，每次导出 +1；本地状态与服务器自身目录双向校验（取 max），防重装/备份恢复导致回退。
- **文件自校验**：首行 header `{"fork_sync":1,"kind","device","seq","since_seq","rows","sha256"}`（sha256 为载荷哈希）+ 载荷行 + 尾行 `{"end":true}`。导入校验行数与哈希，检测半文件/截断；损坏文件跳过并在状态中报告，不中断其他设备导入。
- **压缩**：v1 明文 JSONL（个人量级 MB 级；调试友好）；格式预留 `content-encoding` 字段，后续可平滑加 gzip/zstd（zstd 已是依赖）。
- **有界历史**：设备压缩出新 base 后，可删除自己 ≤ base seq 的旧 seg 与超出保留数（默认 3）的旧 base。这是设备对**自己**文件的整理，不属于"破坏性删除"；任何设备不删他人文件；本地数据清零不触发远端清空。

## 3. 数据语义（字段与合并规则）

### 3.1 buckets（小时桶，来源 `queue.jsonl` 去重视图）

行 = 上游桶行原样 + `device` 字段：`{source, model, hour_start(半小时UTC), input_tokens, cached_input_tokens, cache_creation_input_tokens, output_tokens, reasoning_output_tokens, total_tokens, billable_total_tokens, total_cost_usd, conversation_count, usage_precision?, device}`。`kind: account_session_state`（TRAE CN）控制记录随桶导出（见 3.4）。

**合并（"全部设备"视图）**：
- **per-device source（绝大多数工具）**：跨设备**求和**——两台机器各自真实消耗了 Token。
- **account-level source（cursor、trae-cn，清单以 `src/lib/source-metadata.js` 为准）**：跨设备**去重**，沿用 `src/lib/account-usage-dedup.js` 语义：cursor 按 `(source, hour_start)` + model 分组整行取 MAX（total_tokens 最大→updated_at 最新→device 字典序）；trae-cn 先按会话状态 LWW（`snapshot_verified_at` 严格大于才替换，等值保首条）再聚合。多机读同一账号不翻倍。
- 同设备内 key 覆盖：最新 sequence 的整行替换（含合法向下修正）。

### 3.2 projects（项目×小时桶，来源 `project.queue.jsonl` 去重视图）

行 = `{project_key(canonical owner/repo), project_ref(规范化的 git remote URL，导出前防御性校验不得含凭证), source, hour_start, token 列, conversation_count, device}`。
- 跨设备求和；同项目在两台机器上的用量都计入项目合计。
- **项目身份**：canonical `owner/repo`（`canonicalizeProjectRef` 已去凭证、统一 ssh/https）。不同项目同名不合并（身份是 URL，不是名字）。无 git 的会话/项目：设备本地键 `local:<machineId>:<basename>`，保持独立；用户可通过别名手动合并（3.5）。

### 3.3 sessions（脱敏会话明细，来源 `session.queue.jsonl`）

**导出白名单**（其余字段一律不导出）：`session_hash, session_id, parent_session_id, forked_from_id, source, project_key(导出时解析的 canonical 键或本地键), model, model_usage, usage_buckets, started_at, ended_at, duration_ms, active_ms, turns, edit_turns, retry_turns, subagent_calls, subagent_types, tokens, total_tokens, cost_usd, cost_source, cost_is_partial, cost_per_edit, productive, first_pass, one_shot, tokens_per_edit, performance`。
**明确不导出**：`title` 中由用户本地命名的内容按【待用户确认】处理前的默认：agent 自撰标题导出（属"会话标题"允许字段），`project_ref`(cwd 绝对路径)、resume 命令、任何本地绝对路径、agent_nickname 中的路径类信息不导出。设置中提供"标题不同步"开关（默认同步，因属白名单内元数据；文档说明敏感性）。
- key = `session_hash`（sha256(source\0id)，跨设备稳定）；整记录替换（最新 sequence 胜，含向下修正——修订在导入日志记录）。
- 会话所属 canonical project：导出时对记录内 cwd 调 `resolveProjectMetaForPath` 解析（导出层新增，不改上游 sidecar 写入）。
- 上游 sidecar 会因源文件消失而丢行——fork 的 sessions 导出以**本设备已导出的并集**为基线（导出器状态记录已导 session_hash 集合；源文件消失的会话不再出现在新快照，但导入端"缺失≠删除"语义保住历史）。满足"源删除不抹历史"。

### 3.4 account-level 会话状态（TRAE CN）

`kind:"account_session_state"` 行随 buckets 导出；导入端按 `(user_id, source, session_id)` LWW（`snapshot_verified_at` 严格大于替换），然后聚合出账号级桶。与上游 JS/SQL 双实现语义一致（`test/account-usage-dedup.test.js` 钉死）。

### 3.5 prefs（偏好事件日志）

事件行：`{id, device, seq, action, target, payload}`；action 包括 hide/unhide、project_alias_add/remove、custom_price_set/remove、expense_set/remove。
- 导入合并：每类 target 取 `(Lamport seq, device, event id)` 最大的事件。新增事件序号大于已观察的本机及导入事件，不按机器时钟排新旧。隐藏集 = 最终 hide 状态的并集。
- **隐藏语义**：只影响默认列表展示（读取层过滤），不扣减总用量/费用/项目汇总；`?include_hidden=1` 显示；unhide 可逆；绝不向源 AI 工具发删除指令。
- **项目别名**：`{alias_to: canonical_key}`；读取层映射后聚合；保留原键来源（拆分=移除别名，各键恢复独立）。
- **自定义价格**：按 `(provider_scope?, model)` 的费率条目；随偏好同步（无凭证）；凭证类设置永不同步。
- prefs 事件文件不压缩、只追加（每设备最多保留最近 1 个 base + 近期 seg；事件量小）。

### 3.6 设备恢复/重装/序号回退

- 设备导出前 `PROPFIND` 自己目录取服务器最大 seq，`next_seq = max(本地, 服务器) + 1`。
- 检测到本地 seq < 服务器 seq（重装/旧备份恢复）→ 本次导出强制**全量 base**（不做 delta），并以状态标记 `rebased`；该设备旧设备名/数据不受影响。
- 同 seq 不同内容（极端竞态）→ 导入端报 `snapshot_conflict`（沿用 local-usage-transfer 语义），保留已导入值并surface到状态面板，不静默覆盖。

## 4. 与本地读取/展示的集成

- 本机用量：现有读端不动（`readQueueData`/`readProjectQueueData`/session 端点）。
- 导入视图：新读取器遍历 `webdav/imports/<machineId>/`（导入时已合并成每设备单一视图文件），提供 `all`（默认）与按设备过滤。
- 账户级 source 的跨设备去重在读取层聚合时应用（3.1）。
- API：`/api/webdav/status`（配置/上次成功/失败原因/各设备导入 seq 与更新时间）、`/api/webdav/test`（连接测试）、`/api/webdav/sync-now`、设置读写端点。usage/sessions/projects 系列端点增加 `device=local|all|<machineId>` 与 `include_hidden` 参数；**异步导入失败时响应携带 `partial: true` 与失败设备清单，绝不静默退化为仅本机**。
- macOS 状态栏 / Windows 托盘 / 完整窗口共用同一本地 API → 统计范围天然一致；设备切换器是 dashboard 与原生面板共用的 API 参数。

## 5. 传输与调度

- **WebDAV 客户端**（`src/lib/webdav/client.js`，基于 undici fetch）：OPTIONS（能力探测：DAV class、支持的方法）、PROPFIND depth1（列目录）、GET、PUT、MKCOL（建目录，405=已存在视为成功）、DELETE（仅自身文件整理）、MOVE（上传临时名→正式名；不支持则直接 PUT 最终名——文件自校验兜底半文件）。
- **请求超时**：单次请求默认 180 秒，覆盖等待响应与下载正文；自动/手动同步及连接测试一致。整轮同步可包含多个文件，不设 30 秒总时限。超时按 WEBDAV_TIMEOUT 保存实际时限与操作类型，失败不提交不完整下载，沿用退避和单轮互斥。
- **上传原子性**：默认 `PUT devices/<id>/<name>.part` → `MOVE` 到正式名。MOVE 失败（部分服务不支持跨/同名 MOVE）→ 回退直接 PUT 正式名（导入端哈希校验处理截断）。
- **调度**（serve 进程内，`src/lib/webdav/scheduler.js`）：默认每 5 分钟检查（个人用量变化节奏分钟级；坚果云对高频请求有限流，5 分钟 + 仅变化上传把请求量压到每周期 1 次 PROPFIND/设备）；本地 `tracker sync` 完成后 30s 防抖触发一次提前检查；系统唤醒/网络恢复触发；失败指数退避 1m→5m→15m→60m 封顶；认证失败暂停自动重试并surface状态（手动重试不受限）。关窗留驻状态栏/托盘继续同步；退出应用即停（不承诺关机续传）。
- **离线/故障**：本地采集与查看完全不依赖同步成功；待导出内容在本机 sync-store 状态中持久（成功前不丢）；重试自然补传。
- **限流（429/503）**：退避 + 尊重 Retry-After。
- **代理**：沿用 `src/lib/proxy-env.js`/`proxy-settings.js` 的全局代理设置。

## 6. 凭证与安全

- 设置项：服务地址（仅允许 `https://`，例外本地测试显式豁免）、用户名、应用密码、同步目录、设备名称、启用开关。
- **应用密码存储**：macOS Keychain（`security` CLI，service `tokentracker-fork-webdav`）；Windows DPAPI（CurrentUser 范围 ProtectedData）。不写入 config.json/日志/可同步文件。`config.json` 仅存非秘密字段。
- 传输强制 HTTPS；无应用层内容加密（用户明确决定，不再追问）。
- 同步内容经 3.3 白名单；导出前防御性扫描：project_ref/标题字段中若检出 `user:pass@`、`token=`、已知凭证形态则拒绝导出该行并记录诊断。
- 本地 API 安全校验保留；WebDAV 端点同受本地接口防护约束。

## 7. 本地文件与状态

```
~/.tokentracker-personal/tracker/webdav/
  config.json          # 非秘密设置（url、username、目录、设备名、启用、周期）
  state.json           # 本设备导出状态：per-doc seq/内容哈希/已导 session_hash 集、退避、上次成功/失败
  imports/
    <machineId>/
      device.json      # 导入侧缓存的对方设备信息
      buckets.jsonl    # 该设备合并视图（导入时原子重写）
      projects.jsonl
      sessions.jsonl
      prefs.jsonl
      applied.json     # 已应用 seq 链（base_seq + 各 seg since_seq→seq）、修订日志摘要
```

- 导入幂等：重复应用同 seg 无副作用（upsert by key + seq 门槛）。
- 导入合并视图原子重写（`atomic-json.js` 模式），损坏时从远端 base 重建。
- **恢复点**：远端 base 即恢复点；本地误删可重放。`applied.json` 保证不重复应用。

## 8. 版本与兼容

- `fork_sync: 1`。导入器遇更高 `format` → 拒读该文件并报告"需升级客户端"，不影响其他文件/设备。
- 文档类型可独立演进（buckets v1 + sessions v2 共存可行）：每文档 kind 独立版本。
- 与上游 `local-usage-transfer` v1 快照互不兼容（那是官方云导入通道）；保留其现有本地导入导出功能不动。

## 9. 与"实际支出/自定义价格"的关系

自定义价格经 prefs 同步（无凭证）；价格表本体（LiteLLM/curated/seed）不走 WebDAV，各设备自行拉取（见 REQUIREMENTS §5 与 M4 计划）。手动费用记录【默认：本机录入 + 随 prefs 同步（含金额、日期、周期、备注；不含任何凭证）】。

## 10. 测试策略

- 单元：格式读写/校验和/半文件检测；合并规则（求和 vs 账号级去重 vs LWW）；别名与隐藏；序号回退/重装 rebased；幂等重放。
- 集成：内存 WebDAV 模拟服务（本地 http server，支持/不支持 MOVE、注入 429/401/半文件/慢响应）+ 两份隔离 HOME 的设备数据双向同步一致性。
- 故障注入：断网中途、清单与内容不一致、旧 base 晚到、并发读。
- 真实坚果云实测：需用户在应用设置中填入应用密码后进行（不在聊天中传密码）。

## 11. 2026-10-27 实现修订（优先于上文早期中间设计）

- 每文档 kind 独立递增序号。当前 seg 携带该 kind 的完整 upsert 集，仍校验 since_seq 前驱；缺失键永不表示删除。prefs 也使用 base/seg 文件名，Lamport 事件保持稳定 ID。保留 3 个 base；只有自己成功发布新 base 后才整理自己的旧文件。
- 本机长期明细在 `fork-history/session-groups.json` / `sessions.json`，不是只靠临时 sidecar 或已导出的索引。`wire-<kind>.json` 保留自己已发布的并集，不读取其他设备导入。自己的远端恢复完成后，API 读取恢复快照；input_hashes 区分旧本地备份与之后真正改变的本机记录。
- 导入改为每设备每 kind 单个 `<kind>.json`，一次原子提交 `{seq,hash,rows}`。避免 JSONL 与 applied.json 分开写时中断产生不一致；可读取旧版 JSONL + journal 迁移。文件名/header/device/kind/seq 一致性和行白名单均验证。
- 相同 seq 的校验用于冲突检测。服务端有 ETag 时缓存收据，未变化不重复取内容；无 ETag 时复核当前高水位文件，牺牲少量读取来检测同版本内容被改写。零变化周期不会上传 device.json。
- 传输只允许 HTTPS（明确的本地协议夹具除外），不跟随重定向转发认证。系统凭证账号按 URL+用户名哈希绑定；macOS/Windows 失败不降级为明文。旧版按用户名保存的密码需用户在设置中重新录入；没有自动读取/迁移真实密码。
- 手动与后台共用调度器，并使用现有 openLock 跨进程互斥。轮询 5 分钟，队列或偏好变化 30 秒防抖；失败遵守 Retry-After 与指数退避，401/403 暂停。未配置 WebDAV 时不报告同步失败。serve 内独立采集会话元数据，不依赖网页挂载。
- 本机/全部/指定设备是持久的 API 范围。错误时返回 partial/failed_devices，保留已导入历史；原生通过 X-TokenTracker-Account-View 兼容读取同一范围，不回退成另一范围数字。
- 项目用上游 git remote 解析（去凭证、统一 SSH/HTTPS），GitHub 的键兼容 owner/repo；其他主机保留主机部分。无 Git 身份使用设备+本地路径哈希，不能仅按 basename 合并。API 上的项目别名可逆，保留原始来源。
- 会话标题按用户确认的允许元数据处理，有不上传开关。关闭开关不承诺擦除已经存在的历史 base 或用户备份。远端、恢复后无源会话不返回本机恢复命令。
- fork-costs 保存首次观察的估值依据与版本；真实历史价格不可得时仍明确为估算。手动价格刷新只重载价格表，显式重估才改汇总估值。费用事件按稳定付款 ID 收敛；充值不计消费，货币分开，估值与支出分开。
- 元数据备份独立于同步，最多 64 MB；每设备文档自校验及外层摘要，不含密码/正文/本地路径。恢复只补缺失记录，保留现有记录与设备身份。校验和提供完整性检测，不声称认证来源或应用层加密。
- `bin/personal.js` 设置 TOKENTRACKER_PERSONAL=1，使用独立数据目录和 CLI 名称。兼容引擎入口仍保留旧默认，禁止在真实旧目录做破坏性验收。
