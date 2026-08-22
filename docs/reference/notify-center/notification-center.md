# 统一通知中心（task 08-20-notification-center，M1+M2）

> 常青参考：描述通知中心「现在如何」。过程产物（PRD / 技术设计 / 执行计划 / 调研）在
> `.trellis/tasks/08-20-notification-center/`（local-only）；design.md 里的 M3 是**未来
> 计划**，本文只写 M1/M2 已落地的现状，两者不要混读。

## 1. 定位

一个 app 内统一的持久化通知面：TitleBar 铃铛入口 + 面板列表，承接「后台任务完成后的通知」
——区别于 3 秒自动消失的 toast、以及可能被移除的灵动岛卡片。数据模型泛化自
`matter_attention`（见 [`../matters/matters-architecture.md`](../matters/matters-architecture.md)）：
条目状态机 `open/snoozed/resolved/dismissed` + `severity` + `dedupe_key` 去重计次，新增
`read_at` 作为与 `state` 正交的独立轴（「看过了」≠「处理完了」，Mark all as read 只动
`read_at`）。

设计基线：**先落库、SSE 只当刷新信号**——各信源经 `NotifyCenter.publish()` 写入
`notification` 表，commit 后发一条 `notification.changed` 作为「去 refetch」的提示；断线/
重启后前端一次 `GET /api/notifications` 就能回放，不依赖事件补发。

M1 范围：3 个信源（agent run 终态、维护族 job 终态、系统告警）+ 铃铛 + 面板 All 列表 +
未读数 + Mark all as read + 单条已读跳转。

M2 范围（已落地）：全量信源补齐（agents/matters/reports/contacts/kos 域 + 系统告警缺口五类
+ Electron main 两类，见 §6）+ snooze/resolve 动作端点 + 5 tab 面板 + hover 菜单 + 铃铛
critical 红点档 + 六型 deep-link + macOS 原生通知 fanout（§7）。`AgentPendingBadge` /
`SystemAlertBadge` 收编进铃铛仍未做，留到 dogfood 后（见 §10）。

## 2. 数据模型：`notification` 表（v68）

DDL 单源 = `src/mail/sync_store.py::NOTIFICATION_TABLE_DDLS` / `NOTIFICATION_INDEX_DDLS`
（独立常量组，放在 `CONTACT_SUGGESTION_INDEX_DDLS` 之后）。🔴 **不进**
`MATTER_*_DDLS` / `CONTACT_*_DDLS`——那两组被各自域的多个旧迁移块对老库整组重放，混进去
等于给中间版本各加一个新炸点（v52 索引教训）；本组只从 v68 块执行一次。

| 列 | 语义 |
|---|---|
| `id` | 行主键，也是 wire 层动作的 id（`POST /{id}/read`），单一 id space |
| `category` | 四值：`action_required` / `reviews` / `results` / `system`（面板 tab 映射） |
| `source` | 信源标识（`agent_run` / `job` / `davmail` 等），自由字符串不进 CHECK——加信源不迁库 |
| `severity` | `info` / `warn` / `critical`，与 `MatterAttentionSeverity` 同值域 |
| `state` | `open` / `snoozed` / `resolved` / `dismissed`。🔴 **已读不在这里**，见 `read_at` |
| `dedupe_key` | 去重键，各信源自定（如 `agent_run:{job_id}`）。活跃期（`state IN ('open','snoozed')`）内唯一，由 partial unique 索引 `uq_notification_active_dedupe` 兜底 |
| `recurrence_no` | 第几次触发；`resolved` 之后再来会开新行、计数从上一代 +1 续接（不是重置） |
| `title` / `body` | 落库文案，后端生成的中文；`payload_json` 含 deep-link（`{"link": {...}}`，见 §7） |
| `first_created_at` / `last_event_at` | 毫秒整数（与 matters 同款 `clock_ms`，不是 `time.time()` 秒） |
| `read_at` | 已读独立轴，`NULL` = 未读；计次更新会清回 `NULL`（又发生了，该再看见） |
| `snoozed_until` / `resolved_at` / `dismissed_at` | 关闭/延后时间戳 |

值域单源 = **零依赖叶子模块** `src/notify/center_models.py`（只含常量与 `_SEVERITY_RANK`
纯函数，不 import SyncStore / 任何重模块）；CHECK 子句经 `sql_check_clause()` 生成，不手抄
字符串。TS 镜像 `frontend/src/shared/api/types/notifications.ts` 的字符串 union 由跨语言闸
`tests/config/test_notification_enum_parity.py` 锁死（抽取失败必须红，有 canary 用例）。

**snooze 到期唤醒是读侧口径**，不是后台 tick：`NotifyCenter` 内的
`_OPEN_PREDICATE`——`state='open'` 或 `state='snoozed' AND snoozed_until<=now`——是
list/unread_count 判定「视同 open」的唯一片段，各查询共用，没有 worker 把过期的 `snoozed`
行写回 `open`。代价是到期瞬间没有事件，未读数要等下次 refetch 或 60s 兜底轮询才刷新
（延迟上限 60s，snooze UI 已随 M2 落地）。

## 3. 写面：`NotifyCenter`（`src/notify/center.py`）

发布入口单源（PRD 基线 4）：各信源一律经 `NotifyCenter(db_path).publish(...)`，禁止各处
自拼 INSERT。构造只收 `db_path`（挂点手里通常只有 repo 的 db 路径，`SyncStore()` 构造会跑
全量迁移梯子不能随手 new）；per-call `sqlite3.connect` + `BEGIN IMMEDIATE`，全部方法同步，
async 调用方自行 `await asyncio.to_thread(...)`。

| 方法 | 语义 |
|---|---|
| `publish(category, source, title, dedupe_key, ...)` | 无活跃行开新行；有活跃行**计次更新**（`recurrence_no+1`、`read_at` 清 `NULL`、`severity` 只升不降、`state` 不动——snoozed 保持 snoozed，到期唤醒交给读口径） |
| `resolve_by_dedupe(dedupe_key)` | 关闭该 key 的活跃行 → `resolved`；无活跃行返回 0 不抛（告警 RECOVER 可能先于 ENTER 到达重启后的进程） |
| `mark_read` / `mark_all_read` | 天然幂等；`mark_all_read` 用「请求处理时刻」`now` 做边界（`last_event_at<=now`），并发涌入的新行不会被顺手标掉 |
| `snooze` / `resolve` | CAS：`WHERE id=? AND state IN ('open','snoozed')`，命中失败区分 404/`E_INVALID_STATE` |
| `list` / `unread_count` | 读面，`_OPEN_PREDICATE` 单源口径 |
| `emit_changed` | commit 后手动 flush 一条 `notification.changed`（批量写场景用） |

三条硬纪律：
- **commit 之后才 `safe_publish`**——事务内发会让前端 refetch 读到旧值（`matters/service.py`
  + `job_worker.py` 双先例）。
- **事件 data 只有 `category`**，绝不携带行 id 或业务实体（防回加闸，见 §4）。
- **`NotifyCenter` 本身正常 `raise`**（单测友好），「通知路径绝不影响业务终态」的
  try/except 吞异常纪律在**挂点侧**，不在这个模块里。

## 4. SSE：`notification.changed`

```python
safe_publish("notification.changed", data={"category": category}, source="notify-center")
```

payload 只当 invalidation hint，不携带行 id / 业务数据（`matter.attention` 曾发内部数字
id、前端对不上被迫全量失效的教训——本事件干脆不发 id）。事件登记在
[`../integrations/sse-events.md`](../integrations/sse-events.md)。

前端消费：`useEventBridge.ts` 收到该事件后调用 `components/notifications/notificationMutation.ts`
的 `refreshNotifications(client)`（唯一失效出口，`invalidateQueries({queryKey: qk.notifications.all()})`），
写操作成功后也主动调用同一个函数（不依赖事件回环）。三条传输路都是 fire-and-forget、可能丢
（`inprocess_bus.py` 硬纪律）——兜底见 §7 的面板 refetch + 60s 轮询。

## 5. REST 端点（`src/api/routers/notifications.py`）

无 flag 门控，整段挂 `verify_cf_access`（与 `matters.router` 同口径）。

| 端点 | 语义 |
|---|---|
| `GET /api/notifications` | `category?` / `state`（默认 `open`，含到期 snoozed）/ `unreadOnly?` / `limit`(1-100,默认50) / `offset`。`meta` 带 `count/total/limit/offset/unread`；非法枚举 400 `E_INVALID_ARG` |
| `GET /api/notifications/unread-count` | `{total, byCategory, bySeverity}`——三轴出自**同一条** GROUP BY，口径按构造一致；`bySeverity` 是铃铛 critical 红点档的数据源 |
| `POST /api/notifications/read-all` | body `{category?}`，天然幂等，返回 `{updated}` |
| `POST /api/notifications/{id}/read` | 单条已读，天然幂等，返回单条投影 |
| `POST /api/notifications/{id}/snooze` | `mutation` 信封 + `until`(epoch ms) / `preset`（仅 `3d`，复用 `matters.SNOOZE_3D_MS`）二选一 + `Idempotency-Key` header 一致校验；CAS 只许活跃行，已关条目 409 `E_INVALID_STATE` |
| `POST /api/notifications/{id}/resolve` | `mutation` 信封同上；CAS 同 snooze；resolve 不动 `read_at`（resolve 与已读是两个独立轴） |
| `POST /api/notifications/publish` | **internal face**，独立子路由挂 `verify_local_token`（不接受 CF JWT），主 router 的 `verify_cf_access` 不适用；body **snake_case**（本仓分工：请求体 snake_case、响应与 query camelCase）；Electron main 侧信源专用 |

单条投影（camelCase wire）：`id / category / source / severity / state / title / body /
payload / recurrenceNo / firstCreatedAt / lastEventAt / readAt / snoozedUntil / resolvedAt /
dismissedAt`。🔴 `dedupe_key` **有意不上线**——服务端去重实现细节，无消费点不开字段。
通知中心**没有事件账本**：`Idempotency-Key` 只是「同一次动作」的一致性标识，重放安全由
core 的 CAS 兜底（同 `until` 的 snooze 重放落到同一终态；已关条目二次 resolve 被拒）。

## 6. 已接信源（M1 四条 + M2 十四条）

### M1

| 信源 | 挂点 | category | severity | dedupe_key |
|---|---|---|---|---|
| agent run 终态 completed/failed | `src/agents/run_worker.py::_announce_terminal`（判定后经 `_publish_notification` 双写，与灵动岛卡片并存不替代） | results（`contact_governance` job → reviews：那是「待审阅的建议」不是运行结果） | completed=info；failed=warn | 成功 `agent_run:{job_id}`；失败 `agent_run_failed:{agent_id}`（同 agent 连败合并计次） |
| 维护族 job 终态（resync/backfill 等） | `src/sync/job_worker.py::_notify_terminal`（`_execute` 正常终态与 runner crash 两条路径各一处挂点） | results | succeeded/aborted=info；failed/partial_failure=warn | `job:{job_type}:{job_id}` |
| 系统告警 episode（4 key） | `src/service.py::_check_and_alert` 各 ENTER/ESCALATE/RECOVER 分支旁调用 `_notify_alert_episode` | system | `service_unhealthy`=critical；`dead_letters`/`radar_unavailable`/`outbox_backlog`=warn | `alert:{episode_key}` |
| DavMail watchdog critical | `src/mail/davmail_watchdog.py::_evaluate_alerts` 经 `_notify_davmail_alert` / `_notify_davmail_resolve` | system | critical | `alert:davmail:{sub}`，sub ∈ imap_down/smtp_down/login_degraded/token_critical/oauth_failure |

**读态纪律**：agent run 的完成/失败文案经 `derive_agent_run_state`（`src/agents/run_state.py`）
单源判定；job 侧文案读 `status` 字段而不是 SSE 事件名——`partial_failure` / `aborted` 都走
`job.done` 事件，但文案分别是「部分失败」「已中止」。

### M2

| 信源 | 挂点 | category | severity | dedupe_key |
|---|---|---|---|---|
| agent run 暂停待审批 | `run_worker.py::_publish_paused_notification`（`derive_agent_run_state=='paused_pending'` 时；终态到达先 `resolve_by_dedupe` 归档再发终态通知） | action_required | warn | `agent_run_paused:{job_id}`（逐条，不合并——用户要能逐条点） |
| matter_followup 硬失败且无提案 | `run_worker.py::_publish_matter_failure`（三个失败调用点单点判定：`update_id_for_run` 有值=已有提案→不发） | results | warn | `matter_followup_failed:{matter_id}` |
| matter 提案（`UPDATE_PROPOSED`） | `matters/run_service.py::_publish_update_notification`，事务 **commit 后**调用（同事务内调会与 `NotifyCenter` 的 `BEGIN IMMEDIATE` 死锁） | reviews | info | `matter_update:{update_id}` |
| matter attention 信号 | `matters/worker.py::_publish_attention_notification`，与 `safe_publish('matter.notify')` **并列写入**、不碰 `last_notified_at` 水位；`needs_review` 跳过不发（已由上一行的提案通知覆盖）；一轮批量末尾只 `emit_changed` 一次 | action_required | 直通 signal severity（认不出的值 fail-safe 记 warn） | `matter_attention:{signal_id}` |
| worker crash / crash-loop | `src/utils/supervise.py::supervise`（`notify_center` 可选参数，20 个顶层 worker 共用；一次性任务失败也走 crash 分支） | system | crash=warn；crash-loop 停摆=critical | `alert:worker_crash:{name}` / `alert:worker_crashloop:{name}` |
| IM 飞书对话 bot 失联 | `src/im/worker.py::_notify_unavailable`（与飞书 episode 同构，第二个 `nc.` 前缀 tracker 各记水位——飞书失联时它是唯一出口） | system | ≥5min=warn，≥30min 升 critical（severity 只升不降） | `alert:im_feishu_unavailable`（一条条目，不开第二条） |
| DavMail 自动重启停摆 / 自动恢复失败 | `davmail_watchdog.py`，复用 M1 的 `_notify_davmail_alert` / `_notify_davmail_resolve` | system | critical | `alert:davmail:restart_storm` / `alert:davmail:auto_restart_failed` |
| Redis 事件消费断连 | `service.py::_check_and_alert` 第 5 项，并入 `_notify_alert_episode`（飞书侧维持原样，无 episode） | system | warn | `alert:redis_disconnected` |
| 项目周报自动同步失败/恢复 | `mail/new_watcher.py::_notify_project_progress`，判据是 `summary.status`（不是有没有抛异常——多数失败路径正常返回） | results | warn | `project_progress_sync_failed` |
| 报告生成四终态 + 孤儿回收 | `reports/worker.py::_notify_report_terminal` / `_notify_reclaimed`；`ready` 带 error（LLM 降级）单独文案但仍 severity=info（降级也有产出） | results | empty/ready=info；failed=warn | `report:{report_id}`（同 slot 重跑计次）；孤儿回收聚合 `report:reclaim_stale` |
| 通讯录治理建议新增 | `contacts/governance.py::notify_pending_suggestion`，调用方（`contact_agent.py` / `profile.py`）必须在写事务 **commit 之后**调用（同事务内调用实测 30s busy_timeout 死锁，已钉回归测试） | reviews | info | `contact_suggestion:pending`（队列常驻聚合计次，body 报当前 pending 数） |
| KOS 推送放弃（`status='dead'`） | `kos/ingest_log.py::_notify_dead` | system | warn | `kos_ingest:dead`（聚合计次） |
| 应用更新已下载就绪 | Electron main `handlers/updater.ts`（`update-downloaded` 监听内），经 `publishNotificationToCenter` loopback | system | info | `app_update:{version}`（重启后 re-download 再触发由 dedupe 吸收） |
| chat 对话完成（headless 非 agent 会话，dormant） | `ai_gateway_lifecycle.ts::persistTurn` → `notification_fanout.ts::maybeNotifyChatRunFinished` | results | info | `chat_session:{sessionId}:finished`（详见 §9 决策③，生产近乎不触发） |

**告警「各记水位」**：通知中心用**第二个** `AlertEpisodeTracker`（key 加 `nc.` 前缀，状态落
`sync_state['alert.nc.*']`），与飞书告警的水位完全独立——飞书侧 commit 挂「投递成功」（网络
可能失败要重发），通知中心侧 commit 挂「落库成功」（表本身就是收件箱）。飞书链路的
evaluate/commit 代码一行未动。两处入口 guard 从「无 alerter 直接 return」放宽为
`if not self.alerter and self._notify_center is None: return`（`service.py` /
`davmail_watchdog.py` 各一处），段内每个 `await self.alerter.alert_*` 调用点补了
`if self.alerter` 守卫——默认安装（`ALERT_ENABLED=false`）此前连判定都不跑，系统告警在铃铛
里恒为空，这正是本专项要修的断链。IM 飞书 worker 同款模式独立成第二个 `nc.` tracker
（不与 `service.py` 那份共享，避免不同信源互相 SILENT）。

`MAILAGENT_ASYNC_JOBS_ENABLED` 已随本专项翻默认 `true`（结束 C1 灰度，2026-08），维护族 job
挂点在默认安装下即可触发；CLI 直跑的长任务不经 `JobWorker`，不产生这类通知。

## 7. 前端（`frontend/src/shared/components/notifications/`）

- **铃铛** `NotificationBellBadge.tsx`：挂 TitleBar 右簇（`AgentPendingBadge` / `SystemAlertBadge`
  之后）。恒渲染，未读为 0 时是素图标按钮，未读 > 0 升级成 accent 计数徽标（配方照
  `SystemAlertBadge`，上限 `99+`）；未读数请求未完成/失败时不显示计数点（不闪假 0）。
  面板用 `createPortal` 送到 `document.body`（逃 TitleBar `backdrop-filter` 层叠上下文）。
- **未读数** `useNotificationUnreadCount`（`hooks.ts`）：`staleTime=4s` + `refetchInterval=60s`
  兜底轮询——SSE 是主通道，60s 只是断线/远程 web 构建（`HttpApi.onEvent` 恒 no-op）的保险丝，
  🔴 不是 5s（那是 perf epic 正在消灭的轮询风暴模板）。
- **面板** `NotificationPanel.tsx`：Header（未读 chip + Mark all as read）+ tab 行（All + 四
  category，`SegmentedControl`——`ui/tabs` 的 `layoutId` 全局唯一会与 Settings 双实例冲突，
  改用它）+ 列表 + 空态。tab 值域从 `NOTIFICATION_CATEGORY_VALUES` **派生**
  （`notificationModel.ts::NOTIFICATION_TAB_IDS`），不手抄第二份；per-tab 未读数与铃铛徽标
  同一条 `unread-count` 查询（react-query 去重，口径不会漂）。列表按 `last_event_at DESC`
  前端按本地时区分组（`groupByDay`，判据是「当地零点之差」而非除以 86400000，吸收夏令时
  误差），组头「今天/昨天/更早」。点击条目 = 先 `mark_read` 再按 deep-link 跳转；hover 出
  `⋯` → `Popmenu`（`portal` 档，列表容器 `overflow-y-auto` 会裁掉行内 absolute 菜单）→
  Snooze（三档：1 小时 / 明天早上 8 点 / 3 天后，**前端**按本地时区日期分量换算成显式
  epoch ms 再传给服务端——`tomorrow`/`threeDays` 跨夏令时那天用日期分量运算吸收误差，
  不是加固定毫秒）/ 标记已处理。
- **铃铛红点档**：`bellBadgeState()` 读 `unread-count.bySeverity`，未读里有 `critical` →
  红点（`SystemAlertBadge` 的 fail 配方），否则 accent 计数点。
- **deep-link** `navigation.ts::resolveNotificationLink`：判别 union 的单源解析器，支持六
  型——`session`（跳会话）/ `route`（白名单仅 `/agents`、`/admin/kanban`；🔴 `/settings`
  **不在**白名单，KOS dead 通知的 `/settings?tab=integrations` link 因此点击只标已读不跳转，
  见 §10）/ `report`（store-intent `useReportNavigation`，`ReportsTab` 挂载时消费）/
  `contact_queue`（`useContactNavigation` 的第二条轴，打开 `ContactAgentDrawer`）/ `matter`
  （现成 `useMatterNavigation`）/ `updater_restart`（直调 `api.updater.quitAndInstall()`，
  内建 `state!=='downloaded'` 守卫防误退出）。未知 type / 字段缺失 / 不在白名单 → 返回
  `null`，条目点击只标已读不跳转（前向兼容新版后端加的新 link 型）。
- 失效出口：`notificationMutation.ts::refreshNotifications`，query key 树
  `qk.notifications.{all,list,unreadCount}`（`queryKeys.ts`）——通知相关新顶层 key 一律加进
  这一个文件，不在调用点各写一份 `invalidateQueries`。
- **macOS 原生通知 fanout**（`frontend/src/electron/main/notification_fanout.ts`，owner 拍板
  的删灵动岛前置补位）：订阅 SSE `notification.changed`（事件不带内容）→ 400ms debounce 合并
  连发 → `GET /api/notifications?unreadOnly=true` 拉最近 20 条 → 内存 `lastEventAt` 水位过滤
  （注册时刻初始化，启动前的存量未读不弹，防重启轰炸）→ 只对
  `severity==='critical' || category==='action_required'` 弹系统通知（其余类目铃铛徽标已
  呈现）→ 点击聚焦主窗并经 `resolveNotificationLink` 深跳。`(id, recurrenceNo)` 组成的
  `seen` set 防同轮重弹。

## 8. 无灰度开关

**不存在** `MAILAGENT_NOTIFY_CENTER` 之类的 flag（owner 2026-08-20 拍板：确定要做的功能直接
默认生效，不做灰度开关）。落地形状：写侧挂点无短路直接 publish（异常仍被挂点 try 吞）；REST
端点恒在无 `_require_flag`；铃铛恒渲染；v68 迁移恒跑。**回滚 = revert 对应实施步骤的代码
提交**——`notification` 表与已有数据保留不删，老代码对新表零感知。

## 9. 关键决策记录

1. **事务内 publish 与 `NotifyCenter` 的 `BEGIN IMMEDIATE` 会结构性死锁。** `NotifyCenter`
   per-call 开独立连接、自己 `BEGIN IMMEDIATE`；若在调用方尚未提交的写事务内调用，两把锁
   循环等待——不是「窗口小所以问题不大」，是必死锁。matter 提案（`run_service.py`）与
   通讯录治理建议（`contacts/governance.py` / `profile.py`）都踩过：前者变异测试实测
   `database is locked`，后者实测卡满 30s busy_timeout 且通知丢失（已钉死锁回归测试）。
   统一处置：`create_suggestion` / `_publish_update_notification` **不**在内部发布，改为
   调用方在 `with ... transaction()` 块退出（commit 完成）之后再调用。
2. **`needs_review` attention 信号在通知中心侧去重，交给 reviews 条目。** 提案落库
   （`_publish_update_notification`）与 `needs_review` 关注信号（`_publish_attention_notification`）
   面向同一个「有新提案待审阅」事件；`matters/worker.py` 判 `kind==NEEDS_REVIEW` 直接跳过
   不发 action_required 条目，去重后审阅统一走 reviews（带 matter 链接更精准）。macOS
   `matter.notify` 链不受影响，仍按原样并列写入。
3. **chat 完成通知只接 headless 非 agent 会话，现状 dormant。** 真正的「渲染进程已断开」
   信号（`clientGone`）未穿进 `PersistTurnInput`，判定退化为 `turn.runId == null`
   （headless persist）；再排除 `session.origin === 'agent'`——那类会话终态已由
   `run_worker.py` 的 M1 信源覆盖，照字面接会双发。两层收窄后本挂点在生产近乎不触发，
   是有意保守；待 gateway 核心把 detached 信号穿进 `PersistTurnInput` 后再放宽。
4. **paused 待办的归档点在 approval-state 端点，不在 run 终态路径。** 审批结算走
   `POST /api/agent-runs/{id}/approval-state` 后 run 不再回到 `_announce_terminal`，
   `agent_run_paused:{job_id}` 待办会永远挂着；`set_approval_state` 在 `code` 落到
   `ok`/`idempotent` 两个终态出口后统一调用 `resolve_by_dedupe`（幂等，吞异常）。

## 10. 已知遗留

- **`ContactAgentDrawer` 深链 tab 不复位**：`contact_queue` link 只置位
  `useContactNavigation.queueRequested` → `setAgentOpen(true)`，抽屉内部 tab 是独立
  `useState<AgentTab>('queue')`，若抽屉已挂载且用户之前切到过「运行记录」tab，再次点通知
  只会打开抽屉而不会把 tab 切回「待审建议」。修复约 3 行（tab 状态需响应 `queueRequested`），
  留到后续批次。
- **crash 类通知无自动 resolve**：`supervise.py` 只在 crash / crash-loop 时 `publish`，worker
  按 `healthy_after_sec`（默认 300s）重置崩溃计数、恢复健康后**没有**对应的
  `resolve_by_dedupe` 调用——条目要靠用户在面板手动点「标记已处理」清掉。
- **`chat_run` 信源现状 dormant**：见 §9 决策③，判据收窄后生产近乎不产生这类通知。
- **KOS dead 通知的 deep-link 实际不可跳转**：`kos/ingest_log.py` 发的 link 是
  `{type:'route', to:'/settings', search:{tab:'integrations'}}`，但前端白名单
  `NOTIFICATION_ROUTE_TARGETS` 只有 `/agents`、`/admin/kanban`（`/settings` 未加入，
  `notificationNavigation.test.ts` 已显式钉死这一断言）——点击这类通知只会标记已读，不会
  跳转到设置页；需要时补白名单一行即可。

## 11. 展望（M3，计划中，未落地）

灵动岛 `_post_announce`、macOS 系统通知、飞书告警降级为 publish 之后的 fanout 投影；轮询
徽标改事件驱动；`AgentPendingBadge` / `SystemAlertBadge` 收编进铃铛（保留红点权重逻辑，
先并行一版 dogfood 再摘除旧徽标）。M3 依赖 `08-20-perf-sse-realtime` 的事件补发面。

## 12. 测试与闸

- `tests/notify/test_center.py`——`NotifyCenter` 写面/读面单测（dedupe 计次、severity 单调、
  snooze 读口径、mark_all_read 时刻边界、事件 data 键集防回加闸）。
- `tests/mail/test_notification_v68_center.py`——v68 迁移：新库列集合断言 + 老库（v67）
  重放幂等。
- `tests/config/test_notification_enum_parity.py`——`center_models.py` ↔
  `types/notifications.ts` 枚举跨语言闸（含抽取失败必红的 canary 用例）。
- `tests/api/test_notifications_api.py`——REST 端点契约（含 M2 snooze/resolve/publish）。
- M2 信源各自的挂点单测分散在域内：`tests/agents/test_run_worker*.py`、
  `tests/matters/test_matter_agenda_worker.py` / `test_matter_run_service.py`、
  `tests/utils/test_supervise.py`、`tests/im/test_worker.py`、
  `tests/mail/test_davmail_watchdog.py`、`tests/notify/test_service_alert_checks.py`、
  `tests/mail/test_project_progress_hook.py`、`tests/reports/test_reports.py`、
  `tests/contacts/test_governance.py`（含死锁回归用例）、`tests/kos/test_ingest_reliability.py`。
- `frontend/tests/main/notification_fanout.test.ts`——macOS fanout（水位/去重/档位）；
  `frontend/tests/shared/NotificationPanel.test.tsx` / `notificationNavigation.test.ts` /
  `notificationModel.test.ts` / `notificationsLocaleParity.test.ts`——面板交互与六型
  deep-link。
- `frontend/tests/main/db_version_consistency.test.ts`——`EXPECTED_DB_VERSION` 与
  `SyncStore.DB_VERSION` 恒等闸。

## 13. 运维

```bash
# 未读数（铃铛徽标口径；到期 snoozed 视同 open）
sqlite3 data/sync_store.db "
  SELECT category, COUNT(*) FROM notification
  WHERE read_at IS NULL
    AND (state='open' OR (state='snoozed' AND snoozed_until <= strftime('%s','now')*1000))
  GROUP BY category"

# 反复触发排查（recurrence_no 高 = 某个信源在骚扰）
sqlite3 data/sync_store.db "
  SELECT dedupe_key, recurrence_no, category, severity, title
  FROM notification WHERE state IN ('open','snoozed')
  ORDER BY recurrence_no DESC LIMIT 20"

# 状态分布
sqlite3 data/sync_store.db "SELECT state, COUNT(*) FROM notification GROUP BY state"
```

活库路径是 userData 而非仓库 `data/`（`~/Library/Application Support/mailagent-frontend/data/sync_store.db`），
打包 app 排查时用这条路径。
