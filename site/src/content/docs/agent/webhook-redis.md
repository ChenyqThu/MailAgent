---
title: "Webhook / Redis 集成"
description: "远程 webhook-server（FastAPI :8100）：Notion Automation → Redis → 本地 consumer 的 8 类指令、BLPOP 消费、deploy-webhook.sh 部署、Openclaw 飞书回调。"
---

webhook-server 是部署在远程 VPS 上的一个 FastAPI 服务（端口 `8100`），充当 **Notion / Openclaw / 飞书 → 本机 MailAgent** 的事件中转。它把外部指令推入 Redis 队列，本机 MailAgent 用 `BLPOP` 消费执行，结果再写回 Redis 供轮询。

:::tip[一句话]
外部系统 `POST /api/command` → webhook-server `LPUSH mailagent:{db_id}:events` → 本机 `BLPOP` 消费 → 执行（建草稿 / 改 flag / 查邮件）→ 结果写回 Redis（TTL 1h）。
:::

:::danger[EWS 2026-10-01 关停 —— 迁移警告]
webhook-server 触发的所有 Mail.app 写操作（建草稿 / 改 flag / 归档），在生产 davmail 模式下最终落到 **DavMail 6.7 经 EWS 桥接 Exchange**。Microsoft 已公布 **Exchange Web Services for Office 365 于 2026-10-01 关停**，DavMail 6.7 main 仍依赖 EWS、Graph 路线图（[Issue #404](https://github.com/mguessan/davmail/issues/404)）未 merge。

关停后的双轨应对方案（Path A: DavMail Graph 模式 / Path B: 原生 Graph SDK 重写）见 **`docs/reference/architecture/roadmap-post-cutover.md` §5.1**。AppleScript fallback 路径始终可用，作为 last-resort 兜底。
:::

## 服务信息

| 项 | 值 |
|---|---|
| 部署位置 | 远程 VPS `170.106.181.89`（`ubuntu@`，SSH 公钥 `~/.ssh/id_ed25519`）|
| 项目路径 | `/opt/MailAgent/webhook-server` |
| 内部端口 | `8100`（FastAPI）|
| PM2 进程名 | `mailagent-webhook` |
| Redis DB | `2`（MailAgent 专用）|
| 鉴权 | `X-Webhook-Token: <WEBHOOK_SECRET>` 或 `Authorization: Bearer <WEBHOOK_SECRET>` |

:::note[域名]
本文档示例里的 `https://<webhook-host>` 指 webhook-server 的对外域名（运维侧配置项）。这与终端用户访问的远程 web 界面 `mail.chenge.ink/app`（serve-api + CF Access）是**两个不同的服务**，别混。
:::

## 架构流程

```
Openclaw / Notion Automation / 外部系统
    │  POST /api/command  (或 /webhook/notion?event=…)
    ▼
┌──────────────────────────┐
│  Webhook Server          │  远程 VPS :8100
│  (FastAPI + Redis)       │
└──────┬───────────────────┘
       │ LPUSH mailagent:{db_id}:events
       ▼
┌──────────────────────────┐
│  Redis  (DB 2)           │  队列 + 结果存储 (TTL 3600s)
└──────┬───────────────────┘
       │ BLPOP（本机消费）
       ▼
┌──────────────────────────┐
│  本机 MailAgent (macOS)   │  src/events/redis_consumer.py
│  EventHandlers           │  → Mail.app 草稿 / flag / 查询
│  └─ publish_result       │  → SET mailagent:results:{event_id}
└──────────────────────────┘
       │ 结果写回 Redis
       ▼
   GET /api/command/{event_id}/result?wait=30  ← 调用方轮询
```

## 接口一览

| 方法 | 路径 | 用途 | 鉴权 |
|---|---|---|---|
| `POST` | `/api/command` | 发送指令（flat JSON，调用方主动）| 是 |
| `GET` | `/api/command/{event_id}/result` | 查询指令执行结果（支持长轮询）| 是 |
| `POST` | `/webhook/notion?event=<type>` | 接收 Notion Automation 原始页面 JSON | 是 |
| `GET` | `/api/events/stream` | SSE 实时事件流（见 [SSE 事件流](/agent/sse/)）| 是 |
| `GET` | `/health` | 健康检查 | 否 |
| `GET` | `/admin/stats` | 队列统计 | 是 |

## 8 类指令（`command` 字段）

`/api/command` 的 body 是 flat JSON，`database_id` + `command` 必填，其余字段自动透传为 properties。本机 `EventHandlers` 按 `command` 分派：

| command | 用途 | 必需字段 |
|---|---|---|
| `create_draft` | 创建 Mail.app 回复草稿 | `reply_suggestion` |
| `flag_changed` | 同步旗标/已读到 Mail.app | `message_id` + `is_read`/`is_flagged` |
| `ai_reviewed` | AI 审核完成 → 飞书通知 + 标旗 | `message_id` + `ai_action` + `ai_priority` |
| `completed` | 标记已完成 → 移除 Mail.app 旗标 | `message_id` |
| `query_mail` | 搜索邮件元数据 | 至少一个筛选条件 |
| `fetch_mail_content` | 获取邮件完整正文（AppleScript ~1–3s/封）| `internal_id` |
| `search_email_bodies` | FTS5 正文全文搜索 | `query` |
| `page_updated` | Notion 页面属性变更回流 | `page_id` |

:::caution[ID 体系：始终优先 internal_id]
回调里有四种 ID：`internal_id`（Mail.app SQLite ROWID = AppleScript id，整数）/ `message_id`（RFC 2822，字符串）/ `page_id`（Notion UUID）/ `database_id`（Notion UUID）。操作 Mail.app 时 **`whose id is <internal_id>` ~1s**，而 **`whose message id is "<message_id>"` ~100s**。永远优先 `internal_id`，仅在它为 `null`（邮件已删）时 fallback 到 `message_id`。
:::

## 调用样例

### 创建 Reply All 草稿并等结果

```bash
TOKEN="$WEBHOOK_SECRET"
DB_ID="2df15375830d8094bf5ce86930c89843"

# Step 1: 发送指令
RESPONSE=$(curl -s -X POST https://<webhook-host>/api/command \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Token: $TOKEN" \
  -d "{
    \"database_id\": \"$DB_ID\",
    \"command\": \"create_draft\",
    \"message_id\": \"MWHPR05MB3390...@namprd05.prod.outlook.com\",
    \"reply_suggestion\": \"Hi Neil,\n\nThank you for the feedback.\n\n**Key points:**\n- Will address the perf issue\n- Timeline: next sprint\n\nBest regards\",
    \"mailbox\": \"收件箱\",
    \"mode\": \"reply-all\"
  }")

EVENT_ID=$(echo "$RESPONSE" | jq -r '.event_id')

# Step 2: 长轮询等结果（最多 30s）
curl -s "https://<webhook-host>/api/command/$EVENT_ID/result?wait=30" \
  -H "X-Webhook-Token: $TOKEN"
# {"status":"success","success":true,"method":"reply_all_internal_id"}
```

`create_draft` 的 `mode` 取 `reply-all`（默认）/ `reply` / `new`；`reply_suggestion` 支持 Markdown 富文本（自动转 HTML 粘进 Mail.app）。

### 搜索 Mail.app 全量邮件（含未同步）

`query_mail` 的 `source` 决定搜索范围：`syncstore`（仅已同步，<10ms）/ `mail`（Mail.app 全量 ~24000 封，<150ms）。

```bash
curl -s -X POST https://<webhook-host>/api/command \
  -H "Content-Type: application/json" -H "X-Webhook-Token: $TOKEN" \
  -d "{
    \"database_id\": \"$DB_ID\",
    \"command\": \"query_mail\",
    \"source\": \"mail\",
    \"from\": \"patrick\",
    \"date_from\": \"2025-06-01\",
    \"date_to\": \"2025-06-30\"
  }"
```

### 查询结果的响应形态

```jsonc
// 尚未执行
{"status": "pending"}

// 成功（create_draft）
{"status": "success", "success": true, "method": "reply_all_internal_id"}

// 失败
{"status": "error", "error": "no reply_suggestion"}
```

`method` 取值：`reply_all_internal_id`（快 ~1s）/ `reply_all_message_id`（慢 ~100s fallback）/ `reply_*` / `new` / `standalone_fallback`（回复模式找不到原始邮件，降级新建）。结果在 Redis 保留 **1 小时**（TTL 3600s），过期后返回 `pending`。

## `/api/command` vs `/webhook/notion`

| 特性 | `/api/command` | `/webhook/notion` |
|---|---|---|
| 调用方 | Openclaw / 外部系统 | Notion Automation |
| 请求体 | flat JSON | Notion 原始页面对象 |
| 字段解析 | 直接透传 | 自动从 Notion properties 提取 |
| 事件类型 | `command` 字段 | `?event=` query 参数 |
| 结果回传 | 支持（`/result` 端点）| 不支持 |

## Openclaw 飞书回调链路

MailAgent 通过飞书应用机器人推送重要邮件卡片（Critical/Urgent 触发），卡片含交互按钮，点击后回调到 Openclaw 处理。三条触发路径：

1. **飞书卡片 → Jarvis-mail (Openclaw)**：飞书按钮回调 → Openclaw → spawn jarvis-mail → iTerm2 执行 `create_reply_draft.sh` → 截图回传飞书。
2. **Notion 按钮 → Webhook → 本机**：Notion `创建草稿` 按钮 → `/webhook/notion?event=create_draft` → Redis → 本机 handler → 更新 Notion Processing Status。
3. **Openclaw → `/api/command` → Redis → 本机**：Openclaw 直接 HTTP POST 指令（推荐，无需跨 agent spawn 脚本）。

**飞书卡片按钮 action**：`enhance_reply`（AI 检索上下文生成高质量回复，始终显示）/ `create_draft`（基于建议直接建草稿，仅有 `reply_suggestion` 时显示）/ 打开 Notion（URL 跳转）。

**Processing Status 生命周期**：

```
未处理 → AI Reviewed → 已同步 → 草稿已创建 → 已完成
                                    ↑
                          Notion 按钮 / 飞书回调触发
```

回调字段有长度截断：`ai_summary` ≤ 500 字符、`reply_suggestion` ≤ 800 字符。安全建议：用飞书 Encrypt Key 验签、对 `page_id` 二次验证、`internal_id` 做 null check。

## 部署

webhook-server 一键部署脚本（本机执行，推送到远程 VPS）：

```bash
./scripts/deploy-webhook.sh
```

或手动：

```bash
git push                                    # 本机推代码
ssh ubuntu@170.106.181.89 \
  'cd /opt/MailAgent/webhook-server && git pull && pm2 restart mailagent-webhook'
```

### 部署后必须验证

不要假设部署成功 —— Pydantic schema 变更、handler 未注册、依赖缺失都可能静默失败。

```bash
ssh ubuntu@170.106.181.89 'pm2 status mailagent-webhook'        # online?
curl -s https://<webhook-host>/health | jq .                    # {"status":"ok","redis":"connected"}
ssh ubuntu@170.106.181.89 'pm2 logs mailagent-webhook --lines 30 --nostream'  # 无 error
curl -s https://<webhook-host>/admin/stats -H "X-Webhook-Token: $WEBHOOK_SECRET" | jq .  # 队列 pending 正常
```

本机侧确认 Redis consumer 已连接、handler 已注册（见[运维 / 健康检查](/agent/ops/)）。

---

## 深入了解

- [`docs/reference/integrations/webhook-api.md`](https://github.com/)（全部 endpoint + 字段表 + 调用样例）
- [`docs/reference/integrations/openclaw-callback-guide.md`](https://github.com/)（飞书卡片回调开发指南 + `create_reply_draft.sh` 参数）
- [`docs/reference/architecture/roadmap-post-cutover.md`](https://github.com/) §5.1（EWS 2026-10 关停双轨方案）
- 同站：[SSE 事件流](/agent/sse/) · [运维 / 健康检查](/agent/ops/)
