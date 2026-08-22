# 统一通知中心（task 08-20-notification-center，M1）

> 常青参考：描述通知中心「现在如何」。过程产物（PRD / 技术设计 / 执行计划 / 调研）在
> `.trellis/tasks/08-20-notification-center/`（local-only）；design.md 里的 M2/M3 是**未来
> 计划**，本文只写 M1 已落地的现状，两者不要混读。

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
未读数 + Mark all as read + 单条已读跳转。snooze/resolve 的表结构与 CAS 语义已就位，UI 与
剩余信源是 M2（见 §9）。

## 2. 数据模型：`notification` 表（v68）

DDL 单源 = `src/mail/sync_store.py::NOTIFICATION_TABLE_DDLS` / `NOTIFICATION_INDEX_DDLS`
（独立常量组，放在 `CONTACT_SUGGESTION_INDEX_DDLS` 之后）。🔴 **不进**
`MATTER_*_DDLS` / `CONTACT_*_DDLS`——那两组被各自域的多个旧迁移块对老库整组重放，混进去
等于给中间版本各加一个新炸点（v52 索引教训）；本组只从 v68 块执行一次。

| 列 | 语义 |
|---|---|
| `id` | 行主键，也是 wire 层动作的 id（`POST /{id}/read`），单一 id space |
| `category` | 四值：`action_required` / `reviews` / `results` / `system`（面板 tab 映射，M1 面板未渲染 tab 行） |
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
（M1 无 snooze UI，代价为零）。

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
| `GET /api/notifications/unread-count` | `{total, byCategory}`，四类目恒全（服务端补零） |
| `POST /api/notifications/read-all` | body `{category?}`，天然幂等，返回 `{updated}` |
| `POST /api/notifications/{id}/read` | 单条已读，天然幂等，返回单条投影 |

单条投影（camelCase wire）：`id / category / source / severity / state / title / body /
payload / recurrenceNo / firstCreatedAt / lastEventAt / readAt / snoozedUntil / resolvedAt /
dismissedAt`。🔴 `dedupe_key` **有意不上线**——服务端去重实现细节，无消费点不开字段。
`snooze` / `resolve` / `publish`（Electron main 侧 internal face）三个端点是 M2。

## 6. 已接信源（M1，三条）

| 信源 | 挂点 | category | severity | dedupe_key |
|---|---|---|---|---|
| agent run 终态 completed/failed | `src/agents/run_worker.py::_announce_terminal`（判定后经 `_publish_notification` 双写，与灵动岛卡片并存不替代） | results（`contact_governance` job → reviews：那是「待审阅的建议」不是运行结果） | completed=info；failed=warn | 成功 `agent_run:{job_id}`；失败 `agent_run_failed:{agent_id}`（同 agent 连败合并计次） |
| 维护族 job 终态（resync/backfill 等） | `src/sync/job_worker.py::_notify_terminal`（`_execute` 正常终态与 runner crash 两条路径各一处挂点） | results | succeeded/aborted=info；failed/partial_failure=warn | `job:{job_type}:{job_id}` |
| 系统告警 episode（4 key） | `src/service.py::_check_and_alert` 各 ENTER/ESCALATE/RECOVER 分支旁调用 `_notify_alert_episode` | system | `service_unhealthy`=critical；`dead_letters`/`radar_unavailable`/`outbox_backlog`=warn | `alert:{episode_key}` |
| DavMail watchdog critical | `src/mail/davmail_watchdog.py::_evaluate_alerts` 经 `_notify_davmail_alert` / `_notify_davmail_resolve` | system | critical | `alert:davmail:{sub}`，sub ∈ imap_down/smtp_down/login_degraded/token_critical/oauth_failure |

**读态纪律**：agent run 的完成/失败文案经 `derive_agent_run_state`（`src/agents/run_state.py`）
单源判定；`paused_*` / `skipped` 状态**两条通知都不发**（审批卡链路已经 announce，防止同一件
事发两张卡），这也意味着 `succeeded && outcome='paused_handoff'` 不会被误落成 completed 通知。
job 侧文案读 `status` 字段而不是 SSE 事件名——`partial_failure` / `aborted` 都走 `job.done`
事件，但文案分别是「部分失败」「已中止」。

**告警「各记水位」**：通知中心用**第二个** `AlertEpisodeTracker`（key 加 `nc.` 前缀，状态落
`sync_state['alert.nc.*']`），与飞书告警的水位完全独立——飞书侧 commit 挂「投递成功」（网络
可能失败要重发），通知中心侧 commit 挂「落库成功」（表本身就是收件箱）。飞书链路的
evaluate/commit 代码一行未动。两处入口 guard 从「无 alerter 直接 return」放宽为
`if not self.alerter and self._notify_center is None: return`（`service.py` /
`davmail_watchdog.py` 各一处），段内每个 `await self.alerter.alert_*` 调用点补了
`if self.alerter` 守卫——默认安装（`ALERT_ENABLED=false`）此前连判定都不跑，系统告警在铃铛
里恒为空，这正是本专项要修的断链。

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
- **面板** `NotificationPanel.tsx`：Header（未读 chip + Mark all as read）+ 列表 + 空态。
  M1 只渲染 All（不出 tab 行）；列表按 `last_event_at DESC` 前端按本地时区分组
  （`notificationModel.ts::groupByDay`，判据是「当地零点之差」而非除以 86400000，吸收夏令时
  误差），组头「今天/昨天/更早」。点击条目 = 先 `mark_read` 再按 deep-link 跳转。
- **deep-link** `navigation.ts::resolveNotificationLink`：判别 union 的单源解析器，M1 支持
  两型——`{type:'session', sessionId}`（跳会话）与
  `{type:'route', to, search?}`（白名单仅 `/agents`、`/admin/kanban`，M1 三信源真会发的目标）。
  未知 type / 字段缺失 / 不在白名单 → 返回 `null`，条目点击只标已读不跳转（前向兼容新版
  后端加的新 link 型）。
- 失效出口：`notificationMutation.ts::refreshNotifications`，query key 树
  `qk.notifications.{all,list,unreadCount}`（`queryKeys.ts`）——通知相关新顶层 key 一律加进
  这一个文件，不在调用点各写一份 `invalidateQueries`。

## 8. 无灰度开关

**不存在** `MAILAGENT_NOTIFY_CENTER` 之类的 flag（owner 2026-08-20 拍板：确定要做的功能直接
默认生效，不做灰度开关）。落地形状：写侧挂点无短路直接 publish（异常仍被挂点 try 吞）；REST
端点恒在无 `_require_flag`；铃铛恒渲染；v68 迁移恒跑。**回滚 = revert 对应实施步骤的代码
提交**——`notification` 表与已有数据保留不删，老代码对新表零感知。

## 9. 展望（M2/M3，计划中，未落地）

- **M2**：`snooze`/`resolve` REST 端点 + hover 菜单（Popmenu）+ 5 tab（All/Action
  Required/Reviews/Results/System）+ per-tab 未读数；信源补齐（报告生成完成、matter 提案与
  attention notify、通讯录治理建议、KOS 推送放弃）；Electron main 侧信源（应用更新就绪、chat
  detached run 完成）经 `POST /api/notifications/publish`（`verify_local_token`）接入；
  `AgentPendingBadge` / `SystemAlertBadge` 收编进铃铛。
- **M3**：灵动岛 `_post_announce`、macOS 系统通知、飞书告警降级为 publish 之后的 fanout
  投影；轮询徽标改事件驱动（依赖 `08-20-perf-sse-realtime` 的事件补发面）。

## 10. 测试与闸

- `tests/notify/test_center.py`——`NotifyCenter` 写面/读面单测（dedupe 计次、severity 单调、
  snooze 读口径、mark_all_read 时刻边界、事件 data 键集防回加闸）。
- `tests/mail/test_notification_v68_center.py`——v68 迁移：新库列集合断言 + 老库（v67）
  重放幂等。
- `tests/config/test_notification_enum_parity.py`——`center_models.py` ↔
  `types/notifications.ts` 枚举跨语言闸（含抽取失败必红的 canary 用例）。
- `tests/api/test_notifications_api.py`——REST 端点契约。
- `frontend/tests/main/db_version_consistency.test.ts`——`EXPECTED_DB_VERSION` 与
  `SyncStore.DB_VERSION` 恒等闸。

## 11. 运维

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
