# 附录 B：最小数据模型变更

## B.1 原则

- 继续使用现有数据库边界；
- 不建立 Operation/WorkItem 数据库；
- Session 来源进入 `ai_chat.db`；
- Agent/Trigger 配置继续留在现有 Agent Store；
- 邮件和日历继续留在 `sync_store.db`；
- 所有变更 additive 或 JSON v2 兼容。

## B.2 `ai_chat_sessions` 新列

```sql
ALTER TABLE ai_chat_sessions ADD COLUMN trigger_id TEXT;
ALTER TABLE ai_chat_sessions ADD COLUMN trigger_kind TEXT;
ALTER TABLE ai_chat_sessions ADD COLUMN trigger_fired_at INTEGER;
ALTER TABLE ai_chat_sessions ADD COLUMN parent_session_id INTEGER;
ALTER TABLE ai_chat_sessions ADD COLUMN parent_tool_call_id TEXT;
ALTER TABLE ai_chat_sessions ADD COLUMN invoked_by TEXT;
```

建议索引：

```sql
CREATE INDEX IF NOT EXISTS idx_chat_sessions_agent_updated
  ON ai_chat_sessions(agent_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_trigger_fired
  ON ai_chat_sessions(trigger_id, trigger_fired_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_parent
  ON ai_chat_sessions(parent_session_id, created_at ASC);
```

`parent_session_id` 可不加 FK，避免删除父 Session 时级联删除子运行。删除父会话后子会话仍是独立审计记录。

## B.3 Follow-up Queue

```sql
CREATE TABLE IF NOT EXISTS chat_queued_input (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  run_id TEXT,
  mode TEXT NOT NULL DEFAULT 'follow_up',
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  claimed_at INTEGER,
  delivered_message_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (mode IN ('follow_up', 'steering')),
  CHECK (status IN ('queued', 'claimed', 'sent', 'canceled', 'restored')),
  FOREIGN KEY (session_id) REFERENCES ai_chat_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_queued_input_dispatch
  ON chat_queued_input(session_id, status, created_at ASC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_queued_input_delivery
  ON chat_queued_input(delivered_message_id)
  WHERE delivered_message_id IS NOT NULL;
```

Claim 必须在事务中：

```sql
UPDATE chat_queued_input
SET status='claimed', claimed_at=?, updated_at=?
WHERE id=? AND status IN ('queued','restored');
```

只有 affected row = 1 的 dispatcher 获胜。

## B.4 Compact

第一版不建表，使用 `ai_chat_messages`：

```text
role='system'
content=<summary>
metadata=<CompactMessageMetadata JSON>
ui_message_json=<Compact Card UIMessage>
```

如后续查询性能不足，再加生成列或独立索引，不提前建设。

## B.5 Agent Trigger v2

继续使用现有 `trigger_json`：

```json
{
  "v": 2,
  "triggers": []
}
```

不需要 schema migration。保存时验证：

- id 唯一；
- id 合法；
- enabled boolean；
- kind 已知；
- 至少一条可执行条件（对应 Trigger 要求）；
- 时区合法；
- Regex 合法和长度受限；
- leadSeconds 有界。

## B.6 Agent Description

在现有 Agent 配置行增加 `description` 字段的两种方案：

优先：如果 `report_agent` 已有 description/metadata 可复用则复用；否则 additive column：

```sql
ALTER TABLE report_agent ADD COLUMN description TEXT;
```

限制建议 500–1000 字符。

## B.7 Skill Draft

优先扩展现有 quarantine/skill store。如果需独立记录：

```sql
CREATE TABLE IF NOT EXISTS agent_skill_draft (
  id TEXT PRIMARY KEY,
  name TEXT,
  status TEXT NOT NULL,
  root_path TEXT NOT NULL,
  manifest_json TEXT,
  validation_json TEXT,
  source_session_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (status IN ('draft','valid','invalid','published','discarded'))
);
```

文件内容保存在本地草稿目录，DB 不存大文本。

## B.8 Skill Trust

```sql
CREATE TABLE IF NOT EXISTS agent_skill_trust (
  id TEXT PRIMARY KEY,
  skill_name TEXT NOT NULL,
  package_hash TEXT NOT NULL,
  entrypoint TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  trusted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE(skill_name, package_hash, entrypoint)
);
```

执行前：

- 读取当前 package hash；
- 匹配 entrypoint；
- 验证 policy；
- 若 hash 不同则不命中。

## B.9 Agent Call Idempotency

可复用 `parent_tool_call_id` +目标 Agent 唯一约束。若 Session 创建发生在 job enqueue 前，建议有独立 invocation key：

```text
agent-call:<parent_session_id>:<parent_tool_call_id>
```

写进 async job params 或既有 idempotency 字段；重复 Tool resume 返回同一 job/session。

## B.10 固定运行常量（非用户配置）

```text
CUSTOM_AGENT_CALL_WAIT_MS = 180_000
CALENDAR_TRIGGER_COALESCE_MS = 60_000
NORMAL_APPROVAL_TTL_MS = 86_400_000
HIGH_RISK_OUTBOUND_APPROVAL_TTL_MS = 7_200_000
COMPACT_WARN_RATIO = 0.80
COMPACT_AUTO_RATIO = 0.90
COMPACT_TARGET_RATIO = 0.25
COMPACT_TARGET_ABSOLUTE_CAP_TOKENS = 65_536
```

这些常量第一版不暴露为用户设置。Calendar 业务内容 hash 排除纯开始/结束时间字段；时间变化仅更新 before-start 调度。
