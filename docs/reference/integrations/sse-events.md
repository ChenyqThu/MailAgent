# SSE 事件流 — `/api/events/stream`

Sprint 15 Stage 2 实时推送通道。mail-sync 进程通过 `src/events/publisher.py`
把各类事件 publish 到 Redis pub/sub channel `mailagent:events:v1`；
webhook-server 的 `GET /api/events/stream` SSE endpoint 订阅同 channel，
转发给前端 / 看板 / 外部观察者，替代之前的长轮询 `/api/command/{event_id}/result?wait=30`。

## 鉴权

与 `/api/command` 完全一致：

- Header: `X-Webhook-Token: <WEBHOOK_SECRET>`
- 或 Header: `Authorization: Bearer <WEBHOOK_SECRET>`

无认证 → 401。 `WEBHOOK_SECRET=""`（即未配 secret）时所有客户端都能连。

## 连接示例

```bash
# curl 长连接（-N 关 buffering）
curl -N -H "X-Webhook-Token: $WEBHOOK_SECRET" \
     https://mailagent.chenge.ink/api/events/stream

# 浏览器 EventSource
const es = new EventSource('/api/events/stream', {
  headers: {'X-Webhook-Token': token},  // 注意：浏览器 EventSource 不支持自定义 header；
                                          // 实际生产用 fetch + ReadableStream 或反代加上 header
});
es.addEventListener('mailagent', e => {
  const data = JSON.parse(e.data);
  console.log(data.event_type, data.internal_id, data.data);
});
```

每 15s 发一条 `event: ping` 心跳，防 nginx / Cloudflare 30-60s 默认 idle timeout。

## Payload schema

每条 SSE message data 是一行 JSON：

```jsonc
{
  "event_type": "email.synced",                // 见下表
  "ts": 1716096000.123,                        // unix epoch float
  "internal_id": 53675,                        // 邮件级事件; 非邮件级可能 null
  "data": {                                    // 事件特定 payload (见下)
    "notion_page_id": "page-uuid-abc"
  },
  "source": "new_watcher"                      // 见 source 取值表
}
```

**Source 取值**（outbox 入队来源标识 + SSE 事件来源）:

| source | 触发处 | 含义 |
|---|---|---|
| `cli` | `mailagent email flag` 命令 | 前端 IPC fork CLI 写入 |
| `notion_webhook` | `handle_flag_changed` / `handle_completed` | Notion 端用户手改 property, automation 触发 |
| `ai_reviewed_handler` | `handle_ai_reviewed` | AI 完成审核后系统主动派发 (mailapp + notion 双 target) |
| `reverse_sync_poll` | `NotionToMailSync.sync_single_page` | 30s 轮询的 webhook 兜底 (Sprint 15 hotfix 2 起统一走 outbox) |
| `outbox` | `OutboxRepository.mark_done/failed` | outbox 自身状态变更 SSE 事件 |
| `sync_store` | `SyncStore.mark_synced_v3 / _update_for_retry` | 邮件级事件 |
| `new_watcher` | `_sync_single_email_v3` | 新邮件 sync 成功 |
| `llm_agent` | `LLMProcessingStore.mark_success/failed` | LLM 处理完成 |

## 事件类型

### 邮件生命周期

| event_type | 触发 | data 字段 |
|---|---|---|
| `email.new` | `new_watcher` 三处 `save_email` 成功（主 poll / inbox-reconcile 补抓 / 草稿对账新增）——**入库即发**，不等 AI/Notion 管线 | 单封: `{mailbox}` + `internal_id`；一轮多封聚合一条批量 wire: `internal_id=null` + `{internal_ids: number[]≤200, ids_truncated, mailboxes}`（与 issue #58 入向已读回收同契约）。初始同步 `initial_sync.py` 不经过这些调用点 ⇒ 不发 |
| `email.synced` | `SyncStore.mark_synced_v3` 调用成功 | `{notion_page_id: str}` |
| `email.failed` | `SyncStore._update_for_retry` 写入 fetch_failed/failed status | `{status, retry_count, next_retry_at, error}` |
| `email.dead_letter` | 邮件重试达到上限，进 dead_letter | `{retry_count, error}` |

### Outbox 派发

| event_type | 触发 | data 字段 |
|---|---|---|
| `outbox.enqueued` | `OutboxRepository.enqueue` 新 INSERT (不含合并到 pending) | `{outbox_id, op_type, target, source}` |
| `outbox.done` | `OutboxRepository.mark_done` | `{outbox_id}` |
| `outbox.failed` | `OutboxRepository.mark_failed` 未达 dead_letter | `{outbox_id, attempts, last_error, next_retry_at}` |
| `outbox.dead_letter` | `OutboxRepository.mark_failed` 达到 max_attempts | `{outbox_id, attempts, last_error}` |

### LLM 处理

| event_type | 触发 | data 字段 |
|---|---|---|
| `llm.success` | `LLMProcessingStore.mark_success` | `{model, input_tokens, output_tokens, latency_ms}` |
| `llm.failed` | `mark_failed` 重试中 | `{retry_count, next_retry_at, error}` |
| `llm.gave_up` | `mark_failed` 达上限 | `{retry_count, error}` |

### 文件夹

| event_type | 触发 | data 字段 |
|---|---|---|
| `folder.changed` | `MailWriteService` folder CRUD/cleanup（create/rename/delete/cleanup_local_folder）+ `SyncStore` folder_pref 写（upsert/rename/delete，仅真动了行才发） | `{action: 'create'\|'rename'\|'delete'\|'cleanup'\|'pref'\|'pref_rename'\|'pref_delete', imap_name}` |

> 历史：`folder.synced` 已死 —— 发布方 `src/folder_sync/` 退役后前端订阅空转半年，
> perf-sse-realtime 批把订阅改名 `folder.changed` 并补齐发布点。

### 日历同步

| event_type | 触发 | data 字段 |
|---|---|---|
| `calendar.synced` | ① `CalendarSyncWorker` reconcile 落库有实际变化（upsert/软删 > 0；无变化不发）② REST 写面 `src/api/routers/calendar.py`（create/update/delete/rsvp 成功后 + sync-trigger 整轮聚合、有变化才发）。⚠️ REST 写走 CalDAV，本地 SQLite 行要等下轮 reconcile —— 事件只是失效 hint | `{calendar: str, upserted: int, soft_deleted: int}` |

### 通讯录

| event_type | 触发 | data 字段 |
|---|---|---|
| `contact.changed` | ① 扫描 tick `scanner.run_scan`（processed>0 才发，一轮聚合一条）② 画像 `profile.py` 三个 finish 点（ok/skipped/failed，事务提交后）③ 建议采纳/忽略端点（governance adopt + profile suggestion adopt/ignore） | `{scope: 'scan'\|'profile'\|'governance_adopt'\|'profile_suggestion', contact_ids?: number[]}`（scan 不带 id —— 一轮触到几十人）|

### Run 生命周期

| event_type | 触发 | data 字段 |
|---|---|---|
| `agent.run.changed` | `run_queue.enqueue_agent_run`（queued）/ `AgentRunWorker`（running + 终态）/ agent-runs API（审批结算 + cancel）。matter_followup job **不发**本事件（走 `matter.run.changed`） | `{job_id, status, agent_id?}` —— invalidation hint，前端刷 agent-runs 计数/列表 + agentUnread |
| `matter.run.changed` | `MatterRunService` lifecycle 迁移（enqueue 新行 / mark_started / finish_run 终态 / cancel），事务提交后发；幂等重放与 coalesce 不发 | `{public_id: str, run_id: int}`（🔴 public_id 硬规则，见下）|

> `chat.run.changed`（chat run 起止）**尚未落地**：chat run 注册表活在 AI SDK gateway
> （Node 进程内存，`frontend/src/ai-gateway/activeRuns.ts`），Python 侧无迁移点可挂；
> 落地需 gateway → `POST 127.0.0.1:9200/api/events/publish`（`_local_token_ok` 同道鉴权）。
> 现状缓解：run 结束已有 `chat:turn-persisted` IPC 广播（事件驱动），run/active 探针仅在
> run 活跃期间轮询（Electron 有广播时 30s，web 3s）。

### Matter

| event_type | 触发 | data 字段 |
|---|---|---|
| `matter.changed` | `MatterService._transaction()` 在**事务提交后**，本次落了至少一条 `matter_event` 的每个事项各一条 | `{public_id: str}`（`MAT-0012`）|
| `matter.attention` | `MatterAgendaWorker` 单次 tick 内有 episode 新开、关闭、升档或 snooze 到期 | `{matter_ids: number[], public_ids: string[]}`；每 tick 最多一条聚合失效事件。`public_ids` 是 perf-sse-realtime 批补的（映射失败时为 `[]`，消费端回落全量失效）；`matter_ids`（内部数字主键）保留一版不删 |
| `matter.notify` | worker 判定 open episode 符合 owner 通知级别且尚未写投递水位（`last_notified_at IS NULL`） | `{matter_id, public_id, matter_title, signal_id, kind, severity, why}`；`last_notified_at` 由 worker 同轮自 ack 写入（NC publish 落库成功后；`needs_review` 无条件）。macOS 弹窗走 `notification.changed` 的 fanout，本事件只供 renderer 刷 attention 面 |
| `matter.item.dispatch.changed` | 行动项派发（`matter_item_dispatch`）每次执行态迁移：派发 / 回答 / 取消 / 交付 / 失败，事务提交后发；幂等重放不发（无新行） | `{public_id: str, dispatch_id: int, item_id: int}`。与 `matter.run.changed` 是两条独立账本：那个是 per-事项的定时跟进 run，这个是 per-行动项的一次派发 |

🔴 **matter 系事件的 payload 一律用 public_id**（前端缓存键用的就是它 ⇒ 可定向失效）。
`matter.attention` 曾只发内部数字主键 `matter.id`（前端对不上 ⇒ 被迫按形状全量失效，
踩坑活证据）；perf-sse-realtime 批起它增发 `public_ids`，消费端优先定向失效、拿不到才
回落全量。新增 matter 事件一律跟 `matter.changed` / `matter.run.changed` 走 public_id。

### 通知中心

| event_type | 触发 | data 字段 |
|---|---|---|
| `notification.changed` | `NotifyCenter`（`src/notify/center.py`）各写方法（publish / resolve_by_dedupe / mark_read / mark_all_read / snooze / resolve）commit 之后 | `{category?: string}` —— 仅定位提示，批量 flush 时可省略。🔴 **payload 不携带任何行 id、不携带业务实体**（`matter.attention` 曾只发内部数字 id 前端对不上、被迫全量失效的教训见上，本事件干脆不发 id；防回加闸见前端 `notification.changed` publish 单测）|

> 前端契约：`frontend/src/shared/api/types/events.ts` 的 `SSE_EVENT_TYPES` 与后端
> `safe_publish` 字面量集合恒等，一致性闸
> `frontend/tests/shared/api/sseEventTypes.contract.test.ts`（从 Python 源码抽取，
> 抽取失败必红）。新增/退役事件 = 后端发布点 + TS 数组 + 本文档表三处同步。

`matter.changed` 的语义边界：
- 判据是「真的落了一条 `matter_event`」 —— 幂等重放不落事件 ⇒ **不发**
- 一次事务里改多次同一事项 ⇒ **只发一条**
- 事务回滚 ⇒ **不发**（发布点在 commit 之后：事件先到、DB 后提交会让前端 refetch 读到旧值）
- payload **只有 public_id**，不带 kind、不带业务数据 —— 它是 invalidation hint，
  真数据来自前端随后的 refetch

## 跨进程投递（loopback）

前端 SSE 连的是 **`serve` 进程**的 9200，而所有 REST 写落在 **`serve-api` 进程**（8200）。
serve-api 里没有 sse_server，其 `InProcessEventBus` 从未 `bind_loop()`。

`safe_publish` 因此有三条路：

| 条件 | 走哪 |
|---|---|
| `redis_url` 在场 | Redis publish（远程 web / 外部 Redis 部署，字节级不变）|
| 无 Redis，且本进程有 sse_server（serve）| 进程内总线，直接 fanout |
| 无 Redis，且本进程没有 sse_server（serve-api / CLI）| **loopback**：POST `127.0.0.1:9200/api/events/publish`，由 serve 侧重新 publish |

`POST /api/events/publish`（`src/sse_server.py`）与 SSE 流同一道 `_local_token_ok` 鉴权，
bind 127.0.0.1。投递端 `src/events/loopback.py` 是 fire-and-forget（单线程 executor +
有界队列 256 + 1s 超时 + 绝不抛）—— **serve 没起时写操作照常成功，只是没有实时刷新**。

> 2026-08-18 之前第三条路是 no-op（`inprocess_bus.py` 曾把它记为「已知盲区、未选型」），
> 症状是 serve-api 里的任何写前端都要切走切回才看得到。

## 客户端断线 / 重连

服务端 **不保留** 历史事件 — at-most-once 语义。客户端断连后重连漏掉的事件需要
通过其他路径补：
- 邮件级状态：`mailagent email list` / `email get`
- Outbox 队列状态：`mailagent admin queue-depth`（Sprint 15 Stage 4 加）
- LLM 处理统计：`mailagent llm stats`

EventSource 客户端默认会自动重连（指数退避），重连不丢心跳。

## Redis 流量预估

每次 mail-sync 同步一封邮件触发 ~2 个事件（email.synced + outbox.enqueued ×2 当
outbox enabled）。每天 ~500 邮件 → ~2000 events/day → Redis pub/sub 流量可忽略。

## 故障注意

- mail-sync 进程 publish 是同步 fire-and-forget，redis 不可达不阻塞主链路（silent fail，详 `src/events/publisher.py:safe_publish`）
- webhook-server SSE endpoint redis 不可达 → 401 不返回（rely on `_check_auth`），订阅失败客户端会一直收 ping 心跳直到 timeout
- 没有事件序号 / 幂等 key，客户端不能 dedup
