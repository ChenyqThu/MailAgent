---
title: "Skill Delivery API（对外交付）"
description: "把 MailAgent 能力交给第三方 agent：scoped Bearer key（serve-api 第四条腿）+ Python 权威 Skill manifest + REST GET /api/skills 取 manifest + POST /api/skills/invoke 调用 + confirmation gate + 首批 5 skill 表。"
---

前面几页讲的是外部 agent 怎么把 `mailagent` **CLI** 当工具调。这一页讲另一条更干净的交付面：**Skill Delivery API** —— 你的 agent 不碰 CLI、不碰本机文件，拿一把按权限收敛的 Bearer key，经 **REST** 或 [**MCP**](/agent/mcp-setup/) 直接调 MailAgent 的邮件、搜索、报告、日历能力。

:::note[一句话]
对外只交付一层 **Skill**。能力来自 **Python 权威 manifest 单一真源**（`src/skills/`），REST / MCP / skill pack 三面都从它派生。你的 agent 自带 loop，MailAgent 只负责按 scope 给工具。
:::

## 形态总览

```
外部 agent（自带 loop：Claude Code / OpenClaw / 任意 MCP client）
  → MCP stdio (mailagent-mcp)  ─┐
  → REST  /api/skills(+invoke) ─┼─ scoped Bearer key → src/skills registry
                                │     → handler 调 services / EmailRepository /
                                └─       ReportStore / run_report_once / notion_agent
```

`$BASE` 取决于你打哪个 serve-api：

- 本机：`http://127.0.0.1:8200`
- 远程：`https://mail.chenge.ink`（CF Access 后）

## 鉴权：scoped Bearer key

Skill 路由（`/api/skills*`）是 serve-api 的**第四条鉴权腿**，顺序 **dev bypass → local token → bearer → CF Access**。关键约束：

- Bearer key **只在 `/api/skills*` 认**。其余写端点对 agent key 天然 `401` —— 越权 by construction 不可达。
- key 只存 sha256 hash，明文（前缀 `mak_`）**仅 create / rotate 返回一次**，存好。
- 坏 / 撤销 / 过期 key → **`403` fail-closed**，不回落 CF Access。
- scope 默认最小（只读）；`report:run` / `email:write` / `notion_agent:invoke` 须单独授权。

### 申请 key（本机，需 CLI auth）

```bash
# handoff preset = email:read + attachment:read + report:read + report:run
mailagent api-key create --preset handoff

# 纯只读
mailagent api-key create --preset readonly

# 细粒度：自己点 scope
mailagent api-key create --scopes email:read,attachment:read
```

明文 `mak_…` 仅此一次显示。key 生命周期管理：

```bash
mailagent api-key list      # 列已发 key（只见 metadata，不见明文）
mailagent api-key rotate    # 轮换（返回新明文，旧的失效）
mailagent api-key revoke    # 撤销 → 之后该 key 一律 403
```

:::caution[key 注入走环境变量]
`mak_…` 从 secret store 注入环境变量，不 hardcode、不进 repo、不写进 tool arguments。CI / agent runner 一律 `MAILAGENT_AGENT_KEY` 环境变量从 secret store 取。
:::

## 取 manifest：GET /api/skills

manifest 是 v1 结构，**按你这把 key 的 scope 过滤** —— 只读 key 看不到写 / 发类 tool。

```bash
curl -H "Authorization: Bearer mak_…" $BASE/api/skills
```

每个 tool 的字段：

```
name / input_schema / output_schema / confirmation_tier /
side_effect (read|write|external_call|send) / auth_scopes /
mcp_exposed / handler{kind,target} / timeout_ms
```

## 调用：POST /api/skills/invoke

统一 envelope `{skill, tool, input?, confirm?}`。服务端的 gate 链：

```
scope gate（缺 scope → 403）
  → confirmation gate（confirmation_tier='edit' 必须 confirm:true）
    → 输入校验
      → dispatch handler
```

读类工具直接调：

```bash
curl -H "Authorization: Bearer mak_…" -H 'Content-Type: application/json' \
  -X POST $BASE/api/skills/invoke \
  -d '{"skill":"search","tool":"email_search","input":{"q":"redis timeout"}}'
```

写 / 发类工具（`confirmation_tier='edit'`，发信 / 草稿**永远** edit）必须显式带 `confirm:true`，否则 gate 拦下：

```bash
# 不带 confirm → 被 confirmation gate 拦
curl -H "Authorization: Bearer mak_…" -H 'Content-Type: application/json' \
  -X POST $BASE/api/skills/invoke \
  -d '{"skill":"email","tool":"email_send","input":{ ... },"confirm":true}'
```

每次 agent 调用都写审计（`agent_api_key_audit`）+ 刷 `last_used_at`。

## 首批 skills / tools

| skill | tools | scope |
|---|---|---|
| `email` | `email_get` / `email_body` / `email_thread`（读）· `email_send`（send，edit tier，默认不授）| `email:read` / `email:write` |
| `search` | `email_search` / `attachment_search` | `email:read` / `attachment:read` |
| `report` | `report_list` / `report_get` / `report_run` | `report:read` / `report:run` |
| `calendar` | `calendar_events` / `calendar_event_get` | `calendar:read` |
| `notion_agent` | `notion_agent_chat`（subprocess，`mcp_exposed=false`，默认关）| `notion_agent:invoke` |

`--preset handoff` 给的就是最常用的交接组合：`email:read, attachment:read, report:read, report:run` —— 让 agent 能读邮件 / 读附件 / 拉报告 / 触发报告生成，但碰不到发信和写操作。

## 三步快速接入

```bash
# 1. 申请 scoped key（本机，需 CLI auth）。明文 mak_… 仅此一次显示
mailagent api-key create --preset handoff

# 2. 取 manifest（只见 scope 内 tool）
curl -H "Authorization: Bearer mak_…" $BASE/api/skills

# 3. 调一个只读 tool
curl -H "Authorization: Bearer mak_…" -H 'Content-Type: application/json' \
  -X POST $BASE/api/skills/invoke \
  -d '{"skill":"search","tool":"email_search","input":{"q":"redis timeout"}}'
```

要接 MCP client（Claude Desktop / Code）而不是裸 REST，见 [MCP 接入与 skill pack](/agent/mcp-setup/)。

## 深入了解

- [MCP 接入与 skill pack](/agent/mcp-setup/) — `mailagent-mcp` 启动 + Claude 配置 + skill pack 自检
- [写命令鉴权契约](/agent/auth/) — CLI 侧的读写分权（与 Skill key 是两套独立鉴权）
- [JSON Schema 契约](/agent/json-schema/) — wrapper object 字段语义
- 设计真源：[`docs/reference/llm-agent/skill-delivery-api.md`](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/llm-agent/skill-delivery-api.md)
