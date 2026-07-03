# DavMail 写路径 trace + Notion 反向链路（B1）退役决策依据

> 常青参考。本文固化「每个写操作在 davmail 模式下的端到端路径」与「Notion webhook
> → 反写邮箱（B1）」反向链路的现状证据，作为**未来是否退役 B1 的人工决策依据**。
> 来源：task `06-18-custom-ai-harness-agent` Phase C 调查（只读 trace，零行为变更）。

## 0. 生产配置快照（决定一切判定的前提）

`.env`（生产）：
- `MAILAGENT_BACKEND=davmail`（主路径）
- `MAILAGENT_OUTBOX_ENABLED=true`
- `REDIS_EVENTS_ENABLED=true`

**代码默认值**（`src/config.py`）：~~`MAILAGENT_OUTBOX_ENABLED` 默认 `false`~~ → **E2 灰度收口（2026-07-03）后该开关已退役，outbox 恒启用**（Field 删除、FanoutWorker 无条件启动；`.env` 残留键被 pydantic `extra="ignore"` 静默忽略）。`REDIS_EVENTS_ENABLED` 默认 `false` 不变。收口依据：off 安装态下前端直写 `mail_write.set_flags` 恒入队但 FanoutWorker 不跑 = 入队无人消费的静默半坏组合（onboarding 生成 .env 不写 OUTBOX 键，所有打包安装均踩）——恒启用是修复不是行为变更。

**决定性架构事实**：davmail 模式下 `arm = self`（`src/mail/backend/davmail_backend.py:276`，DavMailBackend 把自己当 AppleScript 机械臂兼容层），`src/mail/new_watcher.py:144` `self.arm = backend.arm` → `MailAppFanout` / `NotionToMailSync` / `EventHandlers` 注入的 `arm` 全是 DavMailBackend。故所有名为「AppleScript」的反向写 leg（`arm.set_flag_by_id` 等）**实际路由到 IMAP STORE**（`davmail_backend.py:1078→683→_store_flag→IMAP UID STORE`）。`grep osascript src/mail/backend/davmail_backend.py` = **0**。

## 1. 写 op × 路径 trace 表

### A. 前端直写（renderer→IPC→serve-api→`src/services/mail_write.py`，backend-agnostic）

| 写 op | service 入口 | execution leg（davmail） | 经 AppleScript? | 碰 Notion? |
|---|---|---|---|---|
| flag / mark-read | `set_flags` | SQLite intent + outbox dual-target（mailapp+notion）；mailapp leg → IMAP STORE | 否（davmail）/ 是（applescript fallback） | 是（notion outbox leg 异步 PATCH mirror） |
| archive | `archive` → `imap_folder_reader.archive_inbox_message` | IMAP MOVE，**davmail-only 强制**（非 davmail 直接 raise） | 否 | 是（异步 mirror，non-fatal） |
| move | `move_to_folder` → `move_by_message_id` | IMAP MOVE | 否 | 是（异步 mirror，non-fatal） |
| draft | `compose_draft` → `backend.append_draft` | davmail: IMAP APPEND；applescript: `create_reply_draft.sh` GUI | 仅 applescript fallback | 否 |
| send | `send` → `backend.send_email` | davmail: SMTP；applescript fallback **也走 SMTP**（`create_reply_draft.sh` 无 send 能力） | 否（两条都 SMTP） | 否 |
| delete(draft) | `delete_draft` → `reader.delete_message` | IMAP \\Deleted + EXPUNGE | 否 | 否 |

> 注：旧规划文档里「mail_write.py applescript 分支行号」已过时 —— 当前前端写路径**已完全 backend 抽象化**，fallback 由注入的 backend 自己决定，`mail_write.py` 无 AppleScript 直调分支。

### B. Notion webhook 反向（webhook-server→Redis→`src/events/handlers.py`，outbox=on 主路径）

| 写 op（event） | handler | execution leg（davmail, outbox=on） | 经 AppleScript? | 碰 Notion? |
|---|---|---|---|---|
| flag_changed | `handle_flag_changed` → outbox enqueue(target=mailapp) | FanoutWorker→`MailAppFanout.execute`→`arm.set_flag_by_id`→**IMAP STORE** | 否 | 否（防回环，只 mailapp） |
| ai_reviewed | `handle_ai_reviewed` → outbox(mailapp) + 飞书 | 同上 IMAP STORE | 否 | mirror 状态机直调 `update_page_mail_sync_status` |
| completed | `handle_completed` → outbox(取消 flag) | IMAP STORE -FLAGS | 否 | 否 |
| create_draft | `handle_create_draft` → davmail IMAP APPEND / applescript sh | 仅 applescript fallback | 否 |
| reverse_sync poll | `reverse_sync.py` → `_enqueue_outbox` | IMAP STORE | 否 | mirror status 直调 |

**结论**：davmail + outbox=on 下，所有反向写 op 的 Mail.app leg 都是 IMAP STORE/APPEND，**无一条经真 AppleScript**，无隐藏 Notion 阻塞写（Notion mirror 是 dual-target 异步 outbox 或 non-fatal 旁路）。

## 2. Reverse path B1 现状判定

**B1（Notion webhook → Redis → Mail.app 反向链路）= 「仍在用，但 davmail 下已无 AppleScript hop（leg 已是 IMAP）」。**

链路：Notion Automation → `webhook-server/app.py` `/webhook/notion?event=flag_changed` → `redis_pool.lpush` → 本地 `RedisConsumer`（`src/service.py`，仅 `REDIS_EVENTS_ENABLED=true` 启动）→ `handlers.handle_*` → outbox → FanoutWorker → `MailAppFanout.execute` → `arm.set_flag_by_id` → davmail IMAP STORE。

- **不是死代码**：生产三开关全开，链路从 VPS 到本地 IMAP 完整通。
- **不是 davmail 下冗余 AppleScript**：AppleScript leg 在 davmail 下已被 `arm=self` 替换成 IMAP。
- **真正可议的是产品语义层**：「Notion 改 Processing Status → 反写邮箱 flag」这条价值，在 v4 SQLite SSoT + 前端直写（`mail_write.set_flags` 自己 dual-target 写 mailapp+notion）成熟后是否仍需要 —— 这是**产品决策**，非技术死活。
- **消费者依赖未完全确认**：`/webhook/notion` 由 Notion Automation 触发，`/api/command` 由 **Openclaw / 外部系统**触发。退役前必须确认这两类外部触发方是否仍在发 flag_changed/ai_reviewed/completed。**仓库内无法确认外部系统现状 → 人工决策点。**

## 3. B2 —— `outbox_repo=None` 灰度回退分支（~~不删~~ → **已删，E2 2026-07-03**）

> **状态更新（E2 灰度收口）**：本节「不删」判定的前提（代码默认 outbox=off → 分支是灰度回退路径）已被 E2 的灰度永久化推翻——开关退役、outbox 恒启用后这些分支成为真死代码，已删除；`outbox_repo` 在 handlers/reverse_sync 构造时必传（None → TypeError）。ai_reviewed 的 Notion 直调 else 分支**保留**（`internal_id=None` 时 outbox 无键可入，属 outbox=on 一直可达路径，非灰度回退）。以下为历史 trace 原文。

`src/events/handlers.py`（flag_changed / ai_reviewed / completed 老路径）+ `src/mail/reverse_sync.py`（reverse poll 老路径）中存在 `if outbox_repo is None:` 直调 `arm` 的分支。

- 仅 `outbox_repo is None` 才走，生产 `MAILAGENT_OUTBOX_ENABLED=true` 永远注入 outbox_repo（`src/service.py`）→ **生产不可达**。
- **但代码默认 `MAILAGENT_OUTBOX_ENABLED=false`**（`config.py:486`）→ 这些分支是「outbox 关闭时的灰度回退路径」（CLAUDE.md 关键开关表载：`false 时 handler + reverse_sync 退回老 AppleScript 直调`），**非纯死代码**。
- **处置 = 标 deprecation 注释，不删**（删会动到默认配置下的回退路径；待灰度永久化、确认 outbox=on 成为唯一支持配置后再清）。

## 4. Legacy residual（BASE-1 = serve-api `run_cli` 业务残留 4 个）（→ **已全部退役，E2 2026-07-03**）

> **状态更新（E2 子包 C）**：4 个残留已清零——#1 update-flag HTTP 端点删除（CLI 命令本体保留，灵动岛 fork lineage 不受影响）；#2/#3 dead-letter retry/cleanup 迁 `AdminService` 进程内直调；#4 selftest 迁 `LlmService.selftest()`。`src/api/cli_runner.py` 整文件删除（连带消除 E0 发现的打包态 E_NO_BIN latent 缺陷——硬编码开发机 venv 路径在打包 app 里必挂）。以下为历史 trace 原文。

| # | 位置 | 命令 | Phase C 处置 |
|---|---|---|---|
| 1 | `src/api/routers/email.py:647` | `notion update-flag` | **标 deprecated**（HTTP wrapper 前端已 D1 改道 outbox `email:flag`，无活跃前端消费者）。**CLI 命令本体不动** —— 仍被灵动岛 `src/notify/island_response.py` fork 复用（另一条不经 serve-api `run_cli` 的 fork lineage）。 |
| 2 | `src/api/routers/admin.py` | dead-letter retry | 可选下沉（非本次） |
| 3 | `src/api/routers/admin.py` | cleanup-dead-letter | 可选下沉（非本次） |
| 4 | `src/api/routers/llm.py` | `llm selftest` | 可选下沉（非本次） |

- `src/events/` `src/services/` 内**无 `run_cli`**；`invoke_skill` 主路径 no-fork（`src/api/routers/skills.py` BASE-1 注释明示）。

## 5. AppleScript fallback 链（**不能删**，已确认完好）

| 路径 | 性质 |
|---|---|
| `AppleScriptBackend` 全套（`src/mail/backend/applescript_backend.py`，含真 `AppleScriptArm`） | `MAILAGENT_BACKEND=applescript` 时 PRIMARY + davmail 不可用时 emergency fallback。**保留** |
| LLM 取正文 fallback（`src/services/llm_service.py` `_maybe_davmail_backend`：davmail probe 失败→AppleScriptArm fetch） | davmail probe 失败回退，warn-only 不崩服务。**保留** |
| ~~handlers/reverse_sync `outbox_repo=None` 老路径~~ | ~~灰度回退（§3）~~ **已删（E2 2026-07-03，见 §3 状态更新）**——AppleScript fallback 不受影响：outbox 与 backend 正交，applescript 模式下 FanoutWorker→MailAppFanout 拿到的 backend 即 AppleScriptBackend |

> 反直觉点：`AppleScriptBackend.send_email` 和 davmail send **都走 SMTP**（cfg SMTP 端口指向 DavMail JVM）—— send op 没有真正的「osascript 发信」fallback。

## 6. B1 退役决策选项（供人工拍板 —— **本次未做**）

技术上 davmail 反向写已无 AppleScript hop（IMAP STORE），故决策本质不是「清 AppleScript」，而是「**Notion 作为反向触发源（B1）是否仍保留**」。

- **选项 A —— 关 `outbox_repo=None` 死分支**：删/标 §3 的灰度死分支，不动链路本体。低风险；代价 = 放弃 outbox=off 的 AppleScript 兜底逃生口（davmail 下回退也是 IMAP，价值近零）。
- **选项 B —— 退役整条 B1**：webhook-server 停止 enqueue 写 op 类事件 + RedisConsumer 对应 handler 仅记日志。**中-高风险**，跨进程/跨 VPS blast radius；**必须先确认无外部消费者依赖**（Notion Automation 按钮、Openclaw `/api/command`、webhook-server dashboard）。**这是 goal 标记的人工介入点。**
- **选项 C —— 保留现状 + 注释**：本次采用（trace 固化 + §3 deprecation 注释，零行为变更）。

### 需人工确认项（退役 B1 前的 STOP 点）
1. Openclaw / webhook-server `/api/command` 是否仍发 flag_changed/ai_reviewed/completed 写事件？
2. Notion 数据库是否还有 Automation 配 `Send Webhook → ?event=flag_changed/completed`？
3. 灵动岛 fork 链（`island_response.py`）依赖 `mailagent notion update-flag` CLI —— 退役 serve-api HTTP wrapper(§4 #1) 不影响它，但若未来删 CLI 命令本体需一并迁移。

> 证据文件：`src/service.py`、`src/services/mail_write.py`、`src/events/handlers.py`、`src/mail/reverse_sync.py`、`src/sync/{fanout,mailapp_fanout}.py`、`src/mail/backend/{base,davmail_backend,applescript_backend,imap_folder_reader}.py`、`src/mail/new_watcher.py`、`src/services/llm_service.py`、`src/notify/island_response.py`、`src/api/routers/{email,admin,llm}.py`、`webhook-server/app.py`、`.env`、`src/config.py`。
