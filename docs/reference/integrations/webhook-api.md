# MailAgent Webhook Server API 文档

## 服务信息

| 项目 | 值 |
|------|-----|
| 域名 | `https://mailagent.chenge.ink` |
| 内部端口 | `8100` |
| 认证方式 | `X-Webhook-Token` Header 或 `Authorization: Bearer <token>` |
| Redis DB | `2`（MailAgent 专用） |

---

## 认证

所有接口（除 `/health`）均需认证。支持两种方式：

```
X-Webhook-Token: <WEBHOOK_SECRET>
```

或

```
Authorization: Bearer <WEBHOOK_SECRET>
```

---

## 接口一览

| 方法 | 路径 | 用途 |
|------|------|------|
| `POST` | `/api/command` | 发送指令（创建草稿等） |
| `GET` | `/api/command/{event_id}/result` | 查询指令执行结果 |
| `POST` | `/webhook/notion` | 接收 Notion Automation webhook |
| `GET` | `/health` | 健康检查（无需认证） |
| `GET` | `/admin/stats` | 队列统计 |

---

## 1. 发送指令

### `POST /api/command`

向本地 MailAgent 发送指令。指令推入 Redis 队列，由对应 `database_id` 的 MailAgent 实例消费执行。

#### 请求

```
POST https://mailagent.chenge.ink/api/command
Content-Type: application/json
X-Webhook-Token: <WEBHOOK_SECRET>
```

#### 请求体

Flat JSON，`database_id` 和 `command` 为必填，其余字段自动透传为 `properties`。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `database_id` | string | **是** | Notion 数据库 ID（支持带/不带连字符） |
| `command` | string | **是** | 指令类型，见下方支持的指令列表 |
| `page_id` | string | 否 | Notion 页面 ID |
| *其余字段* | any | 否 | 自动放入 `properties`，按指令类型传参 |

#### 支持的指令

| command | 说明 | 必需字段 |
|---------|------|---------|
| `create_draft` | 创建 Mail.app 回复草稿 | `reply_suggestion` |
| `flag_changed` | 同步旗标/已读状态到 Mail.app | `message_id` + `is_read`/`is_flagged` |
| `ai_reviewed` | AI 审核完成 → 飞书通知 + 标旗 | `message_id` + `ai_action` + `ai_priority` |
| `completed` | 标记已完成 → 移除 Mail.app 旗标 | `message_id` |
| `query_mail` | 搜索邮件元数据 | 至少一个筛选条件 |
| `fetch_mail_content` | 获取邮件完整正文 | `internal_id` |

#### `query_mail` 字段

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `source` | string | 否 | `syncstore` | 数据源：`syncstore`（仅已同步邮件）/ `mail`（Mail.app 全量邮件） |
| `query` | string | 否 | | 全文模糊搜索（匹配 subject + sender + sender_name） |
| `from` | string | 否 | | 发件人筛选（LIKE 匹配 sender 或 sender_name） |
| `subject` | string | 否 | | 主题筛选（LIKE 匹配） |
| `date_from` | string | 否 | | 起始日期 `YYYY-MM-DD` |
| `date_to` | string | 否 | | 截止日期 `YYYY-MM-DD` |
| `mailbox` | string | 否 | | 邮箱名（`收件箱` / `发件箱`） |
| `is_flagged` | bool | 否 | | 旗标状态 |
| `is_read` | bool | 否 | | 已读状态 |
| `has_notion` | bool | 否 | | 是否已同步到 Notion（仅 `syncstore` 模式） |
| `limit` | int | 否 | `10` | 最大返回数量（上限 50） |
| `offset` | int | 否 | `0` | 分页偏移 |

**`source` 参数说明**：

| source | 搜索范围 | 性能 | 适用场景 |
|--------|---------|------|---------|
| `syncstore` | 仅已同步到 Notion 的邮件（~2700 封） | <10ms | 查找已知邮件的 Notion 页面 |
| `mail` | Mail.app 全部邮件（~24000 封） | <150ms | **搜索历史邮件、未同步邮件** |

**筛选条件均可选，组合使用**。至少提供一个筛选条件。

**返回结构**（通过 `/api/command/{event_id}/result` 获取）：

`source=syncstore` 返回：

```json
{
  "status": "success",
  "source": "syncstore",
  "total": 42,
  "limit": 10,
  "offset": 0,
  "emails": [
    {
      "internal_id": 48197,
      "message_id": "<xxx@outlook.com>",
      "subject": "Re: OKR Discussion",
      "sender": "alice@company.com",
      "sender_name": "Alice Wang",
      "date_received": "2026-03-05 14:30:00",
      "mailbox": "收件箱",
      "is_read": true,
      "is_flagged": false,
      "notion_page_id": "31a15375830d81798e75fcfce933808b",
      "notion_url": "https://www.notion.so/31a15375830d81798e75fcfce933808b"
    }
  ]
}
```

`source=mail` 返回（注意：无 `message_id` 字段，有 `sync_status` 和 `notion_page_id` 如果已同步）：

```json
{
  "status": "success",
  "source": "mail",
  "total": 1769,
  "limit": 10,
  "offset": 0,
  "emails": [
    {
      "internal_id": 35201,
      "subject": "答复: 6.0页面还原问题",
      "sender": "xie.juyi@tp-link.com",
      "sender_name": "谢居怡",
      "date_received": "2025-06-30 23:49:50",
      "mailbox": "收件箱",
      "is_read": true,
      "is_flagged": false,
      "sync_status": "skipped",
      "notion_page_id": null,
      "notion_url": null
    }
  ]
}
```

#### `fetch_mail_content` 字段

通过 AppleScript 获取邮件完整正文（~1-3s/封）。用于 `query_mail` 初筛定位后，获取特定邮件的详细内容。

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `internal_id` | int | **是** | | 邮件内部 ID（从 `query_mail` 结果获取） |
| `mailbox` | string | 否 | | 邮箱名（指定可加速查询） |
| `format` | string | 否 | `full` | 返回格式：`full` / `text` |

**返回格式对比**：

| format | 返回字段 | 适用场景 |
|--------|---------|---------|
| `full` | internal_id, message_id, subject, sender, date, content(纯文本全文), html(HTML全文), is_read, is_flagged, thread_id, notion_page_id, notion_url | 完整邮件内容 |
| `text` | internal_id, subject, sender, date, content(纯文本全文) | 仅需文本正文 |

**`full` 格式返回结构**：

```json
{
  "status": "success",
  "internal_id": 48086,
  "message_id": "<FR3P281MB2204...@FR3P281MB2204.DEUP281.PROD.OUTLOOK.COM>",
  "subject": "AW: Catch Up meeting SaaS 2026 Plan",
  "sender": "Patrick Hirscher <patrick.hirscher@tp-link.com>",
  "date": "2026-03-04T23:56:09",
  "content": "Hi Lucien,\n\nperfect that sounds like a plan...",
  "html": "<html><body><p>Hi Lucien,</p>...</body></html>",
  "is_read": true,
  "is_flagged": false,
  "thread_id": "FR3P281MB2204...",
  "notion_page_id": "31a15375830d81798e75fcfce933808b",
  "notion_url": "https://www.notion.so/31a15375830d81798e75fcfce933808b"
}
```

**错误返回**：

```json
{
  "status": "error",
  "error": "Failed to fetch email 99999. Mail.app may not be running or email was deleted."
}
```

#### `create_draft` 字段

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `reply_suggestion` | string | **是** | | 回复正文（支持 Markdown 富文本） |
| `message_id` | string | 推荐 | | RFC 2822 Message-ID，用于查找 internal_id |
| `mailbox` | string | 否 | `收件箱` | `收件箱` 或 `发件箱` |
| `mode` | string | 否 | `reply-all` | `reply-all` / `reply` / `new` |
| `extra_to` | string | 否 | | 额外收件人（逗号分隔） |
| `extra_cc` | string | 否 | | 额外抄送（逗号分隔，自动过滤自己） |
| `to` | string | new 模式 | | 收件人邮箱（new 模式必填） |
| `to_email` | string | 否 | | 同 `to`，别名 |
| `subject` | string | new 模式 | | 邮件主题（new 模式必填） |

**Markdown 富文本支持**：`reply_suggestion` 中的 Markdown 格式会自动转为 HTML 粘贴到 Mail.app，支持：
- **加粗** (`**text**`)、*斜体* (`*text*`)、`行内代码`
- 无序列表 (`- item`)
- 引用 (`> quote`)
- 表格 (`| A | B |`)

#### 响应

```json
{
  "ok": true,
  "queue": "mailagent:2df15375830d8094:events",
  "event_id": "cmd_1772909109795_54026fc6"
}
```

| 字段 | 说明 |
|------|------|
| `ok` | 是否成功推入队列 |
| `queue` | Redis 队列名 |
| `event_id` | 指令唯一 ID，用于查询执行结果 |

#### 错误响应

| HTTP 状态码 | 说明 |
|------------|------|
| `400` | 缺少 `database_id` 或 `command` |
| `401` | 认证失败 |

---

## 2. 查询指令执行结果

### `GET /api/command/{event_id}/result`

查询指令的执行结果。支持长轮询，等待本地 MailAgent 执行完成后返回。

#### 请求

```
GET https://mailagent.chenge.ink/api/command/{event_id}/result?wait=30
X-Webhook-Token: <WEBHOOK_SECRET>
```

#### 参数

| 参数 | 位置 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `event_id` | path | string | **必填** | `POST /api/command` 返回的 `event_id` |
| `wait` | query | int | `0` | 长轮询等待秒数（0-60），0 表示立即返回 |

#### 响应

**尚未执行完成**：

```json
{"status": "pending"}
```

**执行成功**（`create_draft` 示例）：

```json
{
  "status": "success",
  "success": true,
  "method": "reply_all_internal_id"
}
```

**执行成功 + 截图**：

```json
{
  "status": "success",
  "success": true,
  "method": "reply_all_internal_id",
  "screenshot_path": "/tmp/mail-drafts/draft_20260307_021816.png"
}
```

**执行失败**：

```json
{
  "status": "error",
  "error": "no reply_suggestion"
}
```

#### `method` 值说明

| method | 含义 |
|--------|------|
| `reply_all_internal_id` | Reply All，通过 internal_id 定位（快速 ~1s） |
| `reply_all_message_id` | Reply All，fallback 到 message_id（慢 ~100s） |
| `reply_internal_id` | Reply，通过 internal_id 定位 |
| `reply_message_id` | Reply，fallback 到 message_id |
| `new` | 新建模式 |
| `standalone_fallback` | 回复模式找不到原始邮件，降级为新建 |

#### 注意事项

- 结果在 Redis 中保留 **1 小时**（TTL 3600s），过期后返回 `pending`
- 建议 `wait=30`，草稿创建通常 5-10 秒完成
- 长轮询期间服务器每秒检查一次 Redis

---

## 3. 完整调用示例

### 示例 1: 创建 Reply All 草稿（等待结果）

```bash
TOKEN="your_webhook_secret"
DB_ID="2df15375830d8094bf5ce86930c89843"

# Step 1: 发送指令
RESPONSE=$(curl -s -X POST https://mailagent.chenge.ink/api/command \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Token: $TOKEN" \
  -d "{
    \"database_id\": \"$DB_ID\",
    \"command\": \"create_draft\",
    \"page_id\": \"31b15375-830d-8102-afe4-cd7693979fc5\",
    \"message_id\": \"MWHPR05MB3390A1B2C3@namprd05.prod.outlook.com\",
    \"reply_suggestion\": \"Hi Neil,\n\nThank you for the detailed feedback.\n\n**Key points:**\n- We will address the performance issue\n- Timeline: next sprint\n\nBest regards\",
    \"mailbox\": \"收件箱\",
    \"mode\": \"reply-all\"
  }")

EVENT_ID=$(echo "$RESPONSE" | jq -r '.event_id')
echo "Event ID: $EVENT_ID"

# Step 2: 等待执行结果（最多 30 秒）
RESULT=$(curl -s "https://mailagent.chenge.ink/api/command/$EVENT_ID/result?wait=30" \
  -H "X-Webhook-Token: $TOKEN")

echo "$RESULT"
# {"status":"success","success":true,"method":"reply_all_internal_id"}
```

### 示例 2: 带额外收件人的草稿

```bash
curl -s -X POST https://mailagent.chenge.ink/api/command \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Token: $TOKEN" \
  -d "{
    \"database_id\": \"$DB_ID\",
    \"command\": \"create_draft\",
    \"message_id\": \"MWHPR05MB3390...\",
    \"reply_suggestion\": \"Hi team, please review the attached.\",
    \"mode\": \"reply-all\",
    \"extra_to\": \"alice@tp-link.com,bob@tp-link.com\",
    \"extra_cc\": \"manager@tp-link.com\"
  }"
```

### 示例 3: 新建邮件（不关联原始邮件）

```bash
curl -s -X POST https://mailagent.chenge.ink/api/command \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Token: $TOKEN" \
  -d "{
    \"database_id\": \"$DB_ID\",
    \"command\": \"create_draft\",
    \"mode\": \"new\",
    \"to\": \"neil.mabini@tp-link.com\",
    \"subject\": \"MAC Group Follow-up\",
    \"reply_suggestion\": \"Hi Neil,\n\nFollowing up on our discussion...\",
    \"extra_cc\": \"echo.liu@tp-link.com\"
  }"
```

### 示例 4: 标记已完成（移除旗标）

```bash
curl -s -X POST https://mailagent.chenge.ink/api/command \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Token: $TOKEN" \
  -d "{
    \"database_id\": \"$DB_ID\",
    \"command\": \"completed\",
    \"message_id\": \"MWHPR05MB3390...\"
  }"
```

### 示例 5: 搜索已同步邮件（query_mail，默认模式）

```bash
# 搜索包含 "OKR" 的已同步邮件
RESPONSE=$(curl -s -X POST https://mailagent.chenge.ink/api/command \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Token: $TOKEN" \
  -d "{
    \"database_id\": \"$DB_ID\",
    \"command\": \"query_mail\",
    \"subject\": \"OKR\",
    \"limit\": 5
  }")

EVENT_ID=$(echo "$RESPONSE" | jq -r '.event_id')

# 等待结果
curl -s "https://mailagent.chenge.ink/api/command/$EVENT_ID/result?wait=10" \
  -H "X-Webhook-Token: $TOKEN"
# {"status":"success","source":"syncstore","total":3,"limit":5,"offset":0,"emails":[...]}
```

### 示例 6: 搜索 Mail.app 全量邮件（query_mail source=mail）

```bash
# 搜索 Mail.app 所有邮件（包括未同步到 Notion 的历史邮件）
RESPONSE=$(curl -s -X POST https://mailagent.chenge.ink/api/command \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Token: $TOKEN" \
  -d "{
    \"database_id\": \"$DB_ID\",
    \"command\": \"query_mail\",
    \"source\": \"mail\",
    \"query\": \"SaaS\",
    \"limit\": 10
  }")

EVENT_ID=$(echo "$RESPONSE" | jq -r '.event_id')

curl -s "https://mailagent.chenge.ink/api/command/$EVENT_ID/result?wait=10" \
  -H "X-Webhook-Token: $TOKEN"
# {"status":"success","source":"mail","total":61,"limit":10,"offset":0,"emails":[...]}
```

```bash
# 搜索 2025 年 6 月某人发的邮件
curl -s -X POST https://mailagent.chenge.ink/api/command \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Token: $TOKEN" \
  -d "{
    \"database_id\": \"$DB_ID\",
    \"command\": \"query_mail\",
    \"source\": \"mail\",
    \"from\": \"patrick\",
    \"date_from\": \"2025-06-01\",
    \"date_to\": \"2025-06-30\"
  }"
```

### 示例 7: 获取邮件正文（fetch_mail_content）

```bash
# 从 query_mail 结果中拿到 internal_id，获取完整正文
RESPONSE=$(curl -s -X POST https://mailagent.chenge.ink/api/command \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Token: $TOKEN" \
  -d "{
    \"database_id\": \"$DB_ID\",
    \"command\": \"fetch_mail_content\",
    \"internal_id\": 48086,
    \"mailbox\": \"收件箱\",
    \"format\": \"full\"
  }")

EVENT_ID=$(echo "$RESPONSE" | jq -r '.event_id')

# 等待结果（AppleScript 获取 ~1-3s）
curl -s "https://mailagent.chenge.ink/api/command/$EVENT_ID/result?wait=10" \
  -H "X-Webhook-Token: $TOKEN"
# {"status":"success","internal_id":48086,"subject":"AW: Catch Up meeting...","content":"Hi Lucien,...","html":"<html>..."}
```

### 示例 8: Fire-and-forget（不等待结果）

```bash
# 只发送，不查询结果
curl -s -X POST https://mailagent.chenge.ink/api/command \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Token: $TOKEN" \
  -d "{
    \"database_id\": \"$DB_ID\",
    \"command\": \"create_draft\",
    \"message_id\": \"MWHPR05MB3390...\",
    \"reply_suggestion\": \"Thanks, noted.\"
  }"
# 返回 {"ok":true,"event_id":"cmd_xxx"} 即表示已入队
```

---

## 4. Notion Webhook（内部接口）

### `POST /webhook/notion?event=<type>`

接收 Notion Automation 的 webhook 回调。Notion 发送原始页面 JSON，服务器自动解析 properties。

**与 `/api/command` 的区别**：

| 特性 | `/api/command` | `/webhook/notion` |
|------|---------------|-------------------|
| 调用方 | Openclaw / 外部系统 | Notion Automation |
| 请求体 | Flat JSON | Notion 原始页面对象 |
| 字段解析 | 直接透传 | 自动从 Notion properties 提取 |
| 事件类型 | `command` 字段 | `?event=` Query 参数 |
| 结果回传 | 支持（`/result` 端点） | 不支持 |

---

## 5. 辅助接口

### `GET /health`

健康检查（无需认证）。

```json
{"status": "ok", "redis": "connected"}
```

### `GET /admin/stats`

队列统计（需认证）。

```json
{
  "queues": {
    "2df15375830d8094": {
      "queue": "mailagent:2df15375830d8094:events",
      "pending": 3
    }
  },
  "total_queues": 1
}
```

---

## 6. 架构流程

```
Openclaw / 外部系统
    │
    │ POST /api/command
    ▼
┌──────────────────────┐
│  Webhook Server      │ mailagent.chenge.ink
│  (FastAPI + Redis)   │
└──────┬───────────────┘
       │ LPUSH mailagent:{db_id}:events
       ▼
┌──────────────────────┐
│  Redis               │ DB 2
│  队列 + 结果存储      │
└──────┬───────────────┘
       │ BLPOP (本地消费)
       ▼
┌──────────────────────┐
│  本地 MailAgent       │ macOS
│  EventHandlers       │
│  ├─ create_draft.sh  │ → Mail.app 草稿
│  ├─ flag sync        │ → Mail.app 旗标
│  └─ publish_result   │ → SET mailagent:results:{id}
└──────────────────────┘
       │
       │ 结果写入 Redis
       ▼
┌──────────────────────┐
│  Webhook Server      │
│  GET /result?wait=30 │ ← Openclaw 轮询
└──────────────────────┘
```
