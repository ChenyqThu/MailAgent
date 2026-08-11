# Session、跨 Session 查询与 Context Compact

## 1. Session 是核心工作记录

MailAgent 近期继续以 Session 为中心：

- 人工会话；
- 邮件锚定会话；
- 飞书会话；
- Custom Agent 自动运行；
- 主 Agent 委派子 Agent。

不增加 WorkItem 或 Operation 平台。

## 2. 当前 Session 字段

已有：

```text
id
email_id / anchor_type / anchor_id
backend_kind / backend_model
title / archived
created_at / updated_at
origin
agent_id / agent_job_id
last_read_at
pinned_at / starred
```

## 3. 建议新增来源字段

```text
trigger_id TEXT NULL
trigger_kind TEXT NULL
trigger_fired_at INTEGER NULL
parent_session_id INTEGER NULL
parent_tool_call_id TEXT NULL
invoked_by TEXT NULL
```

语义：

- `created_at`：Session 创建时间；
- `trigger_fired_at`：业务事件发生时间；
- `parent_*`：委派来源；
- `invoked_by`：`main_agent | user`。

`agent_job_id` 继续关联权威运行状态。

## 4. Agent 是否知道自己的 ID

当前权限上下文知道 `agent_id`，模型不知道。新增 Trusted Identity Block 后，模型可以：

- 查“我自己的最近运行”；
- 在报告中记录生成 Agent；
- 使用 agent_id 过滤 Session；
- 引用当前 Session。

## 5. 通用组合查询

扩展 `chat_session_list/search/get` 或新增底层统一查询：

```ts
interface SessionQuery {
  query?: string;
  origin?: string;
  agentId?: string;
  agentJobId?: string;
  triggerId?: string;
  triggerKind?: string;
  createdAfter?: number;
  createdBefore?: number;
  archived?: boolean;
  starred?: boolean;
  limit?: number;
}
```

查询路径：

- 无 query：结构化 SQL；
- 有 query：FTS 命中，再套结构化过滤；
- 短 query：保留 LIKE fallback。

## 6. 运行状态投影

查询 `origin='agent'` Session 时，根据 `agent_job_id` 返回：

```text
run_state
outcome
approval_state
finished_at
error
```

不复制进 Session 表，避免双状态漂移。

## 7. 历史权限

### 7.1 自己的运行

Custom Agent 默认能查自己的 Session：服务端强制加 `agent_id = currentAgentId`。

### 7.2 所有 Session

只有 `Knowledge and sessions = on` 时，Agent 才能查用户其他历史。

### 7.3 其他 Agent

通过 `agent_catalog_list/get` 发现 ID；Catalog 不暴露完整 Prompt 或敏感权限。

## 8. Compact 数据模型

推荐继续使用 `ai_chat_messages`，不新建大型子系统。

Compact Message：

```text
role = system
content = summary markdown
status = complete
metadata.kind = compact
metadata.compacted_through_message_id
metadata.first_kept_message_id
metadata.tokens_before
metadata.estimated_tokens_after
metadata.model
metadata.created_reason = manual | threshold | overflow
```

`ui_message_json` 保存 Compact 卡片。

## 9. Compact 有效性

最新一条有效 Compact 决定上下文边界。

若用户之后编辑/删除历史导致边界不再可信：

- 标记 Compact invalid；
- 回退完整历史或重新 Compact；
- 不静默使用错误摘要。

## 10. 自动阈值

```text
<80%      正常
80%–89%   提示接近上限
>=90%     本轮结束后自动 Compact
Overflow  紧急分块 Compact + 重试一次
```

比例只在模型 context window 已知时计算。不设置 85% 二级提醒。压缩后模型输入目标默认取 context window 的 25%，允许落在 20%–30% 区间，并以 64K tokens 作为整体绝对上限。

## 11. Compact UI

卡片显示：

```text
已压缩上下文
覆盖消息 #12–#86
压缩前 91K
压缩后估计 28K
模型 ...
原因：手动/自动/溢出恢复
```

可展开摘要全文。

Compact 运行期间：

- 显示明确状态；
- 可 Stop；
- 完成后提示；
- 失败不改变当前上下文边界。

## 12. 未读红点

三层：

```text
主导航 Agents：存在任意未读 Agent Session
Agent 行：该 Agent 未读数
Session 行：未读点
```

只有真正打开 Session 时更新 `last_read_at`。

等待审批使用橙色/警告状态，不与普通未读混淆。
