---
title: "SSE 事件流"
description: "本地 :9200 in-process SSE 事件流 / 远程 webhook-server /api/events/stream：事件类型、payload schema、订阅 cookbook、断线重连语义。"
---

MailAgent 暴露一条 **Server-Sent Events（SSE）** 事件流，让 agent / 看板 / 外部观察者**免轮询**实时收到「新邮件已同步 / AI 处理完成 / flag 变更 / outbox 派发」等事件。这是 Sprint 15 Stage 2 引入的实时推送通道，替代了之前的长轮询 `/api/command/{event_id}/result?wait=30`。

:::tip[一句话]
mail-sync 进程把事件 publish 到 Redis pub/sub channel `mailagent:events:v1`；SSE endpoint 订阅同 channel 转发给客户端。**at-most-once** 语义——断线漏掉的事件要靠 `mailagent email list` 等读命令补。
:::

## 两个 endpoint：本地 in-process vs 远程 webhook-server

| | 本地 serve-api | 远程 webhook-server |
|---|---|---|
| 地址 | `http://127.0.0.1:9200`（in-process，随 serve-api 起）| `https://<webhook-host>/api/events/stream` |
| 路径 | SSE stream endpoint | `GET /api/events/stream` |
| 鉴权 | 本地 token（`X-MailAgent-Local-Token`）| `X-Webhook-Token` 或 `Authorization: Bearer <WEBHOOK_SECRET>` |
| 适用 | 桌面 app / 本机 agent / CLI 脚本 | 远程看板 / 跨机观察者 |

两者订阅同一个 Redis channel，事件 payload 完全一致。下面以远程 `/api/events/stream` 为例（本地 9200 把 host 换成 `127.0.0.1:9200`、鉴权换成本地 token 即可）。

## 鉴权

远程与 `/api/command` 完全一致：

```
X-Webhook-Token: <WEBHOOK_SECRET>
```

或

```
Authorization: Bearer <WEBHOOK_SECRET>
```

无认证 → 401。`WEBHOOK_SECRET=""`（未配 secret）时所有客户端都能连。

每 **15s** 发一条 `event: ping` 心跳，防 nginx / Cloudflare 30–60s 默认 idle timeout 把长连接掐掉。

## Payload schema

每条 SSE message 的 `data` 是一行 JSON：

```jsonc
{
  "event_type": "email.synced",        // 见下方事件类型表
  "ts": 1716096000.123,                // unix epoch float
  "internal_id": 53675,                // 邮件级事件；非邮件级可能为 null
  "data": {                            // 事件特定 payload
    "notion_page_id": "page-uuid-abc"
  },
  "source": "new_watcher"              // 事件来源标识，见下表
}
```

**`source` 取值**（既是 outbox 入队来源，也是 SSE 事件来源）：

| source | 触发处 | 含义 |
|---|---|---|
| `cli` | `mailagent email flag` | 前端 IPC / CLI 写入 |
| `notion_webhook` | `handle_flag_changed` / `handle_completed` | Notion 端用户手改 property，automation 触发 |
| `ai_reviewed_handler` | `handle_ai_reviewed` | AI 审核完成后系统主动派发（mailapp + notion 双 target）|
| `reverse_sync_poll` | `NotionToMailSync.sync_single_page` | 30s 轮询的 webhook 兜底 |
| `outbox` | `OutboxRepository.mark_done/failed` | outbox 自身状态变更 |
| `sync_store` | `SyncStore.mark_synced_v3 / _update_for_retry` | 邮件级事件 |
| `new_watcher` | `_sync_single_email_v3` | 新邮件 sync 成功 |
| `llm_agent` | `LLMProcessingStore.mark_success/failed` | LLM 处理完成 |

## 事件类型

### 邮件生命周期

| event_type | 触发 | `data` 字段 |
|---|---|---|
| `email.synced` | `SyncStore.mark_synced_v3` 成功 | `{notion_page_id}` |
| `email.failed` | 写入 `fetch_failed`/`failed` status | `{status, retry_count, next_retry_at, error}` |
| `email.dead_letter` | 重试达上限，进 dead_letter | `{retry_count, error}` |

### Outbox 派发（Sprint 15 SSoT inversion）

| event_type | 触发 | `data` 字段 |
|---|---|---|
| `outbox.enqueued` | `OutboxRepository.enqueue` 新 INSERT（不含合并到 pending）| `{outbox_id, op_type, target, source}` |
| `outbox.done` | `mark_done` | `{outbox_id}` |
| `outbox.failed` | `mark_failed` 未达 dead_letter | `{outbox_id, attempts, last_error, next_retry_at}` |
| `outbox.dead_letter` | `mark_failed` 达 max_attempts | `{outbox_id, attempts, last_error}` |

### LLM 处理

| event_type | 触发 | `data` 字段 |
|---|---|---|
| `llm.success` | `LLMProcessingStore.mark_success` | `{model, input_tokens, output_tokens, latency_ms}` |
| `llm.failed` | `mark_failed` 重试中 | `{retry_count, next_retry_at, error}` |
| `llm.gave_up` | `mark_failed` 达上限 | `{retry_count, error}` |

## 订阅 cookbook

### curl（长连接，调试用）

```bash
# -N 关 buffering，否则 curl 会攒着不吐
curl -N -H "X-Webhook-Token: $WEBHOOK_SECRET" \
     https://<webhook-host>/api/events/stream
```

### Python（反应 new-email / ai-complete / flag-changed）

`httpx` 流式读，逐行解析 SSE `data:` 行。这是 agent 端最常用的形态——盯住事件流，命中关心的 `event_type` 就触发下游动作：

```python
import json
import httpx

WANT = {"email.synced", "llm.success", "outbox.enqueued"}

def stream_events(base_url: str, token: str):
    headers = {"X-Webhook-Token": token, "Accept": "text/event-stream"}
    # timeout=None 让连接长开
    with httpx.stream("GET", f"{base_url}/api/events/stream",
                      headers=headers, timeout=None) as resp:
        resp.raise_for_status()
        for line in resp.iter_lines():
            if not line or not line.startswith("data:"):
                continue                       # 跳过空行 / event: 行 / ping
            payload = line[len("data:"):].strip()
            try:
                evt = json.loads(payload)
            except json.JSONDecodeError:
                continue                       # ping 心跳无 JSON body
            if evt.get("event_type") in WANT:
                handle(evt)

def handle(evt: dict):
    et, iid = evt["event_type"], evt.get("internal_id")
    if et == "email.synced":
        print(f"new mail synced: {iid} → {evt['data']['notion_page_id']}")
    elif et == "llm.success":
        print(f"AI done: {iid} ({evt['data']['model']})")
    elif et == "outbox.enqueued":
        print(f"outbox intent: {evt['data']['op_type']} → {evt['data']['target']}")
```

### 浏览器（`EventSource`）

```js
// 注意：原生 EventSource 不支持自定义 header。生产里要么把 token 放反代层注入，
// 要么改用 fetch + ReadableStream 自己读流。
const es = new EventSource('/api/events/stream')
es.addEventListener('mailagent', (e) => {
  const evt = JSON.parse(e.data)
  console.log(evt.event_type, evt.internal_id, evt.data)
})
```

## 断线 / 重连语义

服务端**不保留**历史事件 —— **at-most-once**。客户端断连后重连，漏掉的事件**不会补发**，要走读命令对账：

| 漏掉的 | 用什么补 |
|---|---|
| 邮件级状态 | `mailagent email list` / `mailagent email get` |
| outbox 队列状态 | `mailagent admin queue-depth` |
| LLM 处理统计 | `mailagent llm stats` |

- `EventSource` 客户端默认自动重连（指数退避），重连不丢心跳。
- **没有事件序号 / 幂等 key** —— 客户端不能 dedup。如果你的下游动作非幂等，自己用 `(event_type, internal_id, ts)` 做去重缓存。

## 故障注意

- mail-sync publish 是同步 fire-and-forget，**Redis 不可达不阻塞主链路**（silent fail，见 `src/events/publisher.py:safe_publish`）。所以"事件流空了"不代表同步停了——可能只是 Redis 断了，邮件仍在落 SQLite。
- SSE endpoint 在 Redis 不可达时订阅失败，客户端会一直收 `ping` 心跳直到 timeout —— **收到 ping ≠ 收到业务事件**，别把心跳当存活证明。
- 要确认事件是否真发出，用 `mailagent admin stats` 的 watcher section（`emails_synced` 计数）交叉验证。

## Redis 流量预估

每同步一封邮件触发 ~2 个事件（`email.synced` + outbox enabled 时 `outbox.enqueued` ×2）。每天 ~500 邮件 → ~2000 events/day，Redis pub/sub 流量可忽略。

---

## 深入了解

- [`docs/reference/integrations/sse-events.md`](https://github.com/)（事件流完整规格）
- [Webhook / Redis 集成](/agent/webhook-redis/)（远程 webhook-server + Notion Automation 链路）
- [运维 / 健康检查](/agent/ops/)（用读命令对账漏掉的事件）
