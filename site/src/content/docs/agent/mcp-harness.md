---
title: "MCP / Agent Harness 集成"
description: "前端 chat 引擎（embedded AI SDK Gateway）：工具调用与 HITL 审批、KOS 三层开关、notion-agent-cli 只读会话现状、桌面+远程共用引擎架构、外部 agent 调 CLI 契约与 MCP 工具定义规格。"
---

这一节讲 MailAgent 的 **agent 集成面**：前端 chat 面板里那个会调工具的多轮 agent（Agent Harness），它怎么接外部 LLM、怎么接 KOS 跨域知识图，以及外部 agent / MCP 客户端如何把 `mailagent` CLI 当工具调用。

:::note[两条不同的 LLM 路径，别混]
**Agent Harness** = 用户在 chat 面板跟 LLM 多轮对话、LLM 自驱调工具。
**LLM Agent**（本地 LLM 接管 Notion Custom Agent 做邮件分类）是另一条单轮路径，不在本页。
:::

## Agent 工具调用（Embedded AI SDK Gateway）

Chat 面板的多轮工具调用引擎 = **embedded AI SDK Gateway**（`frontend/src/ai-gateway/`，随 Electron main 进程常驻，监听 loopback）：

1. **Tool calling**：读工具恒注册（`email_search` / `email_get` / `email_body` / `email_list_thread` / `email_search_fulltext` / `email_search_attachments` / `kos_query` / `report_list` / `report_get`）；写工具按 tier 分层且需人审批（preview：`email_flag` / `email_archive` / `email_pin` / `email_resync`；edit：`email_draft_reply` / `email_prepare_send`）。完整清单以 `frontend/src/ai-gateway/tools/index.ts`（`buildGatewayTools`）为准 —— 旧文档提过的 `get_ai_fields` / `attachment_list` 已随引擎归一删除，不再存在。
2. **Multi-turn loop**：`ai` SDK 的多步循环（`maxSteps` / cost gate），模型自然终止或耗尽预算终止。
3. **HITL 审批卡**：write tier 工具触发 assistant-ui 原生审批卡（**preview** = 只读预览 / **edit** = 可编辑字段 / **blocking** = 发送类恒人审，无自动放行）；旧的 `ConfirmToolDialog` 组件已随 legacy 渲染层删除。
4. **跨邮件检索**：`email_search_fulltext` 接后端 FTS5 `email_body_fts`。
5. **Audit**：每个 tool_use 仍写 `chat_tool_call` 表（status / duration / user_edited_input）。

**关键约束**：

- 工具调用只发生在唯一引擎；`notion-agent` 会话现为历史只读回放（新对话不再走它），不涉及 tool_use。
- prompt cache 双 breakpoint（system 末 + tools 末）保护命中率。
- 写操作必须经审批卡确认；send 恒人审，无例外。
- 会话中止时清理未决审批，防 deadlock。

:::note[历史注记]
2026-07 前，自研 `MAILAGENT_AGENT_HARNESS` flag 曾可关闭多轮 agent；S3（引擎归一）后该 flag 与自研 harness 引擎一并删除，工具调用恒由 embedded AI SDK Gateway 提供，无 flag 可关闭或回退。
:::

## KOS 三层开关（跨域知识图）

MailAgent 接入用户已有的 **Jarvis KOS v2**（gbrain fork，`kos.chenge.ink`）作为第 4 个消费者。集成分三层，**全默认 OFF**，按层独立启用：

| 开关 | 默认 | 作用 |
|---|---|---|
| `MAILAGENT_KOS_INGEST_ENABLED` | `false` | **Producer**：mail-sync 邮件 sync 完后台异步推 KOS `/ingest`（path `mail/{internal_id}` + `scope:mail-agent`），KOS 自动抽实体并入主图 |
| `MAILAGENT_KOS_CONSUMER_ENABLED` | `false` | **Consumer**：chat agent 的 `kos_query` / `kos_digest` 工具调跨域知识 |
| `MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED` | `false` | **L1 hot block**：chat 开场注入当前邮件发件人的 KOS digest 到 system block（带 cache_control）|

配套凭据（OAuth 2.1 client_credentials）：`KOS_MCP_BASE` / `KOS_OAUTH_CLIENT_ID` / `KOS_OAUTH_CLIENT_SECRET`；producer 阈值 `KOS_INGEST_PRIORITY_FLOOR=normal`（不推 low 优先级，防图谱噪声）。

**Consumer 工具**（silent tier，category=meta）：

| 工具 | 调谁 | 用途 |
|---|---|---|
| `kos_query` | KOS `tools/call` query | 跨域检索：人物 / 公司 / 邮件 / 会议 / 手记。"Bob 上次提的 X / Acme 项目最近怎么样 / 我跟这供应商的历史" |

**降级**：KOS 不可达时工具返 `ok:false` + stable error code（`E_KOS_NOT_CONFIGURED` / `E_KOS_NETWORK` / `E_KOS_RATE_LIMIT` 等），LLM 自然 fallback 到本地 FTS5（`email_search_fulltext` / `email_search_attachments`）。**LLM 不调 ingest** —— 写入路径由 mail-sync 后端独占，防 chat 路径把幻觉"事实"塞进图谱。

## 引擎架构（一份 embedded gateway，本地+远程共用）

chat 引擎唯一实现 = **embedded AI SDK Gateway**：一个 Node HTTP server（`frontend/src/ai-gateway/server.ts`），随桌面 Electron main 进程常驻启动，监听 loopback（默认端口 8300）。V2.1（B-pure-unified）阶段设想的 `frontend/src/shared/chat/`（`HttpChatPlatform` / `custom_api` / `notion_agent_http` 多后端抽象）已随 2026-07 S3（引擎归一）整体删除——不再有第二套引擎实现。

- **桌面**：Electron main 进程直接启动并持有这个 gateway，renderer 走 loopback fetch。
- **远程 web**（`mail.chenge.ink/app`）：serve-api（FastAPI 8200）的 `ai_gateway_proxy.py` 用 httpx 做流式反向代理，把请求转发到同一个 loopback gateway —— 远程侧**没有**独立的第二套引擎逻辑，只是一层反代。
- **后端服务**：serve-api 仍承担鉴权、chat 持久化端点、`GET /api/chat/config`（运行配置快照，供 gateway 启动前 TTL 缓存预取）等非引擎职责；`POST /api/chat/notion-agent`（asyncio spawn CLI）端点代码仍在，但当前无前端调用方（见下）。

**鉴权两条腿**：本地 electron renderer 由 main 进程 `webRequest` 拦截 loopback 注入本地 token（token 留 main 不进 renderer）；远程 browser 走 CF Access cookie。

:::caution[flag 命名误导]
`MAILAGENT_REMOTE_ACCESS_ENABLED` 名为「远程访问」，**实为本地 daemon / serve-api 总开关**。本地 chat / 写都依赖它，`=false` **连本地 chat / 写都挂**（非仅关远程）。默认起。
:::

## notion-agent-cli：现状（历史只读，非活跃引擎）

notion-agent-cli 曾是与 custom-api 并列的第二个 chat 后端实现；S3 后它不再参与任何实时对话 —— `/api/chat/notion-agent`（流式）与 `/api/chat/notion-agent-once`（非流式）两个端点在 serve-api 里仍存在，但前端零调用方。现存的 notion-agent 相关功能收窄为：

- **Settings 页配置读取**：账户 / 模型 / agent 列表（`/notion-agent/config`、`/notion-agent/models`、`/notion-agent/agents`）。
- **历史会话只读回放**：过去用 notion-agent 后端跑的会话经 `ReadOnlyTranscript` 组件读数据库行展示，不可继续对话。

notion-agent-cli 本身的调用契约（serve-api 历史复刻的就是这个，供归档参考）：

```bash
notion-agent chat "<prompt>" --json --stream
# exit code: 75=RATE_LIMIT  77=AUTH  127=NOT_INSTALLED  0=OK
```

## 外部 agent 调 CLI 契约

不走前端 chat 时，外部 agent / MCP 客户端把 `mailagent` CLI 当工具调用。契约：

- **统一 wrapper JSON**：所有命令 `-o json` 输出 `{ status, schema_version, data | error, meta }`（见 [JSON Schema 契约](/agent/json-schema/)）。
- **退出码分流**：0 成功 / 1 业务失败 / 2 参数错 / 4 鉴权 / 6 partial / 7 aborted / 8 max-failures / 9 PM2 冲突 / 130 二次 SIGINT（见 [退出码契约](/agent/exit-codes/)）。
- **读免 auth、写要 token**：读命令（get/list/body/search/stats/health）无鉴权；写命令需 `MAILAGENT_CLI_API_KEY`（见 [写命令鉴权契约](/agent/auth/)）。
- **中文字面量**：`--mailbox 收件箱` / `--processing-status '已完成'` 等值是中文字面量，英文环境也需传中文字符串。
- **resource-first**：`mailagent <noun> <verb> [<id>] [flags]` 始终成立，可枚举、tab 补全友好。

最小端到端环（读→写）：

```bash
KEY="$MAILAGENT_CLI_API_KEY"
# 1. health gate
mailagent -o json admin health | jq -e '.data.healthy' >/dev/null || exit 1
# 2. 搜到目标
ID=$(mailagent -o json email search "redis timeout" --limit 1 | jq '.data[0].internal_id')
# 3. 读正文
mailagent -o json email body "$ID" | jq -r '.data.content'
# 4. 写：标旗（dry-run 先看 plan，再真跑）
mailagent email flag "$ID" --is-flagged --dry-run -o json
mailagent email flag "$ID" --is-flagged --api-key "$KEY" -o json
```

## MCP 工具定义规格（若把 CLI 暴露为 MCP 工具）

若要把 `mailagent` 命令包成 MCP server 供 MCP 客户端调用，每个工具的定义草图：参数 schema 直接复用 `docs/cli-schema/` 的输入约束，工具描述取命令 help，工具结果即 CLI 的 wrapper JSON。

```jsonc
// MCP tool definition 草图：email_search
{
  "name": "mailagent_email_search",
  "description": "FTS5 全文搜索邮件（正文+附件）。query 支持 DSL：from:/subject:/is:/has:/OR/否定/中文前缀通配。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query":   { "type": "string", "description": "DSL query 字符串" },
      "mailbox": { "type": "string", "description": "中文字面量，如 收件箱 / 发件箱" },
      "limit":   { "type": "integer", "default": 50, "maximum": 200 }
    },
    "required": ["query"],
    "additionalProperties": false
  }
}
```

```jsonc
// 一次 tool_call 的形态（MCP 客户端 → server → CLI）
{ "name": "mailagent_email_search",
  "arguments": { "query": "redis OR timeout is:unread", "mailbox": "收件箱", "limit": 20 } }

// server 内部执行：
//   mailagent -o json email search "redis OR timeout is:unread" --mailbox 收件箱 --limit 20
// tool 返回（即 CLI stdout 的 wrapper JSON）：
{ "status": "success", "schema_version": 1,
  "data": [ { "internal_id": 53675, "subject": "…", "snippet": "…<mark>redis</mark>…", "rank": -2.34 } ],
  "meta": { "duration_ms": 23, "count": 1 } }
```

规格要点：

- **工具粒度 = 命令粒度**：一个 `mailagent <group> <action>` 对应一个 MCP tool，名字 `mailagent_<group>_<action>`。
- **inputSchema 复用契约**：参数枚举/范围抄 `docs/cli-schema/<command>.schema.json` 的输入约束（如 `limit` 上限、`mailbox` 中文值）。
- **写工具暴露需谨慎**：写命令要求 token，MCP server 应从 env 注入 `MAILAGENT_CLI_API_KEY`，**绝不**把 key 进 tool arguments；破坏性命令（delete/cleanup/archive）默认不暴露或强制 `--dry-run`。
- **结果即契约**：tool result 直接返回 CLI 的 wrapper JSON，客户端按 `status` 分流。

---

## 深入了解

- [`docs/reference/llm-agent/agent-harness-kos.md`](https://github.com/)（harness ship 状态 + KOS 三层 PR 拆分）
- [`docs/reference/llm-agent/kos-integration-design.md`](https://github.com/)（KOS client / producer / consumer / error 矩阵）
- [`docs/reference/remote-chat-report/remote-chat-report-architecture.md`](https://github.com/)（B-pure-unified：ChatPlatform / serve-api / 鉴权两条腿）
- 同站：[写命令鉴权契约](/agent/auth/) · [JSON Schema 契约](/agent/json-schema/) · [10 大命令组参考](/agent/commands/)
