---
title: "MCP / Agent Harness 集成"
description: "前端 chat 多轮 agent harness：MAILAGENT_AGENT_HARNESS、KOS 三层开关、notion-agent-cli 后端、ChatPlatform 抽象、外部 agent 调 CLI 契约与 MCP 工具定义规格。"
---

这一节讲 MailAgent 的 **agent 集成面**：前端 chat 面板里那个会调工具的多轮 agent（Agent Harness），它怎么接外部 LLM、怎么接 KOS 跨域知识图，以及外部 agent / MCP 客户端如何把 `mailagent` CLI 当工具调用。

:::note[两条不同的 LLM 路径，别混]
**Agent Harness** = 用户在 chat 面板跟 LLM 多轮对话、LLM 自驱调工具。
**LLM Agent**（本地 LLM 接管 Notion Custom Agent 做邮件分类）是另一条单轮路径，不在本页。
:::

## Agent Harness（MAILAGENT_AGENT_HARNESS）

总开关 `MAILAGENT_AGENT_HARNESS`（默认 `false`）。开启 + 选 Custom AI 后端后，chat 面板获得：

1. **Tool calling**：LLM 自驱调内建工具（读：`email_search` / `get` / `body` / `list_thread` / `search_fulltext` / `get_ai_fields` / `attachment_list`；写：`email_flag` / `email_archive` / `email_draft_reply`）。
2. **Multi-turn loop**：harness 自循环（`maxIter` / `maxCostUsd` gate），`end_turn` 终止。
3. **ConfirmToolDialog**：write tier 工具弹确认对话框（preview = 只读 JSON / edit = 可编辑 textarea），用户编辑的值生效给 LLM 下一轮看到 —— **无 silent send**。
4. **跨邮件检索**：`email_search_fulltext` 接后端 FTS5 `email_body_fts`。
5. **Audit**：每个 tool_use 写 `chat_tool_call` 表（status / duration / user_edited_input）。

**关键约束**：

- 仅 **Custom AI 后端**启用 tool_use（Notion Agent CLI 不支持 tool_use 协议，gate 自动 fallback legacy single-turn）。
- prompt cache 双 breakpoint（system 末 + tools 末）保护命中率。
- 写操作必须经 ConfirmToolDialog 确认。
- abort signal 触发时清确认队列（`cancelConfirmationsForSession`，防 deadlock）。

:::caution[cutover 后 harness 不再是逃生阀]
V2.1 cutover 后，dispatcher 删了 `harnessEnabled && backendSupportsTools` gate，`runStream` **无条件走 harness**。`MAILAGENT_AGENT_HARNESS=0` 不再退化成 legacy 单遍纯文本路径；notion-agent 经 harness（empty tools → 首轮 end_turn）等价单遍。生产默认 ON，无实际影响，但若需排障回退单遍，该逃生阀已不存在。
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
| `kos_digest` | KOS query（按 slug 取 top hit）| 拉指定 entity 档案（`people/{slug}` 等），chat 开场注入发件人背景 |

**降级**：KOS 不可达时工具返 `ok:false` + stable error code（`E_KOS_NOT_CONFIGURED` / `E_KOS_NETWORK` / `E_KOS_RATE_LIMIT` 等），LLM 自然 fallback 到本地 FTS5（`email_search_fulltext` / `email_search_attachments`）。**LLM 不调 ingest** —— 写入路径由 mail-sync 后端独占，防 chat 路径把幻觉"事实"塞进图谱。

## ChatPlatform 抽象（一份引擎，本地+远程）

V2.1（B-pure-unified）把 chat 引擎下沉到 `frontend/src/shared/chat/`（零 Electron 依赖），electron 桌面与浏览器**共用一份引擎 + 一份 serve-api**，只差 `baseUrl + 鉴权`：

- **引擎层** `shared/chat/`：`harness`（多轮 loop）/ `dispatcher` / `backends/{custom_api, notion_agent_http}` / `tools/builtin`（`createBuiltinTools` 单一真源）/ `emitter`（进程内流式 sink，无 IPC 推流）。
- **传输层** `HttpChatPlatform`：分层接线板（infra / model / notion-agent / tool 四板），全部 fetch serve-api 对应端点。构造 `(httpApi, baseUrl, config?)`。
- **后端层** serve-api（FastAPI 8200，无 harness 逻辑）：`POST /api/chat/llm-proxy`（注入 key 透传上游 SSE）/ `POST /api/chat/notion-agent`（asyncio spawn CLI）/ chat 持久化端点 / `GET /api/chat/config`（运行配置快照）。

**鉴权两条腿**：本地 electron renderer 由 main 进程 `webRequest` 拦截 loopback 8200 注入 `X-MailAgent-Local-Token`（token 留 main 不进 renderer）；远程 browser 走 CF Access cookie。

:::caution[flag 命名误导]
`MAILAGENT_REMOTE_ACCESS_ENABLED` 名为「远程访问」，**实为本地 daemon / serve-api 总开关**。cutover 后本地 chat / 写都依赖它，`=false` **连本地 chat / 写都挂**（非仅关远程）。默认起。
:::

## 两类后端的不对称（有意）

| 后端 | 形态 | 实现位置 |
|---|---|---|
| **custom-api** | HTTP | serve-api `llm-proxy` 注入 key 后透传原始 SSE，shared `custom_api.ts` 在 UI 进程**解析**（双协议 Anthropic/OpenAI）|
| **notion-agent** | 子进程 | execa 不能在浏览器跑，serve-api Python **逐语义复刻** `notion_agent.ts`（thread 探测 / exit code 分类 / idle 看门狗）|

notion-agent-cli 后端的调用契约（serve-api 复刻的就是这个）：

```bash
notion-agent chat "<prompt>" --json --stream
# exit code: 75=RATE_LIMIT  77=AUTH  127=NOT_INSTALLED  0=OK
```

两者最终各是单一实现（custom_api = shared TS / notion_agent = Python）→ 零 parity。

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
