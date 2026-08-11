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

### 日历同步

| event_type | 触发 | data 字段 |
|---|---|---|
| `calendar.synced` | `CalendarSyncWorker` reconcile 落库有实际变化（upsert/软删 > 0；无变化不发） | `{calendar: str, upserted: int, soft_deleted: int}` |

### Matter Attention

| event_type | 触发 | data 字段 |
|---|---|---|
| `matter.attention` | `MatterAgendaWorker` 单次 tick 内有 episode 新开、关闭、升档或 snooze 到期 | `{matter_ids: number[]}`；每 tick 最多一条聚合失效事件 |
| `matter.notify` | worker 判定 open episode 符合 owner 通知级别且尚未收到投递 ACK | `{matter_id, public_id, matter_title, signal_id, kind, severity, why}`；`last_notified_at` 只由 `/notified` ACK 写入 |

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
