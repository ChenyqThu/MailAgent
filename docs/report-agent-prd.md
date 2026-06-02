# 邮件报告 Agent + Custom AI KOS 工具 — PRD

> **状态**：📐 设计中（2026-06-02）。本 PRD 待用户 review → handoff claude design 设计前端 → 据前端实现前后端。
> **分支**：`feat/report-agent`
> **受众**：Lucien（单用户）。
> **关联**：复用 [`daily_digest.py`](../src/notify/daily_digest.py) / [`digest_query.py`](../src/notify/digest_query.py) / [`client.py`](../src/llm_agent/client.py) / KOS [`client.py`](../src/kos/client.py)。

---

## 0. 决策记录（2026-06-02 对齐）

| 决策点 | 选择 |
|---|---|
| 报告渲染对接 | **LLM 输出结构化 JSON 块模型 → 前端 React 原生渲染**（非 LLM 直出 HTML，非纯 Markdown） |
| Custom Agent 首版范围 | **报告型模板优先**（日/周/月报），配置 schema 预留全自定义 |
| KOS 在对话中的用法 | **MCP 工具桥：把 KOS 原生工具（curated read-only）+ skill 给 LLM 自驱**（不做主动注入、不硬塞） |
| 报告触达面 | **v1 仅应用内 Agents 页查看**（不推送 / 不远程 web / 不回写 Notion） |

---

## 1. 背景与目标

**现状**：大部分邮件已被 AI 处理（分类 / 优先级 / 摘要 / 动作建议，存 `llm_processing.labels_json`）。已有灵动岛 `DailyDigest`（每天 9/18 点 LLM 汇总 24h 邮件）—— 但它输出的是**紧凑通知**，不是可查阅的富报告。

**痛点**：缺一个"综合昨天信息、可溯源、方便查看"的日报。

**目标 A（报告 Agent，主体）**：每天 / 每周 / 每月自动生成**结构化富报告**，应用内查看，每封邮件**可点击溯源**（直达邮件 / Notion）。

**目标 B（KOS 工具，#1）**：Custom AI 对话中，LLM 可**按需检索 KOS 知识库**（含邮件 source）补充上下文回话。

---

## 2. 范围

**In scope（v1）**
- 报告型 agent：日报为主，周报 / 月报同引擎（窗口 + prompt + 排程不同）。
- JSON 块模型（ReportDoc DSL）+ 前端原生组件渲染。
- 应用内 Agents 页：报告列表 + 详情 + agent 配置（启用 / 改 prompt / 排程 / 模型 / Run now）。
- Custom AI chat 的 KOS 工具接到**邮件 source**（修复当前够不到的问题）。

**Non-goals（v1，留待将来）**
- 全自定义 agent runtime（任意 trigger / tools / url / 模型密钥）。
- 推送通知 / 远程 web / 回写 Notion 日报页（schema 预留，不实现）。
- 报告内**批量动作执行**（v1 动作建议仅展示，不落地执行；v1.x 再接 outbox）。

---

## 3. 请求 #1：Custom AI 对话的 KOS 工具（MCP 工具桥 + skill）

> **设计哲学**（2026-06-02 用户定调）：不要我们替 LLM 查 / 主动注入；**把 KOS 的原生接口 + skill 给 LLM，让它按邮件上下文自判断该查什么**。更通用、更符合 harness 设计。KOS 本身就是按这个模式设计的。

### 3.1 现状（实测 2026-06-02）
- **KOS 是 MCP server**，`tools/list` 实测暴露 **81 个原生工具**，且自带 `list_skills` / `get_skill`：KOS 发布的 "skill" = 教 LLM 如何用这个 brain 的 prose 指令集，`get_skill` 返回 `{body, usable_tools, unavailable_tools, client_guidance}`。**KOS 就是为"skill + 工具给 LLM 自驱"设计的 thin-client 消费模式**。
- 现有 hand-wrapped `kos_query` / `kos_digest`（PR-2e，[`kos.ts`](../frontend/src/electron/main/chat/tools/builtin/kos.ts)）只暴露 2 个窄工具，且用 **default client 够不到邮件 source**（实测 `list_pages(type=email)=0`；只有 **bulk client** 能查到 `sources/email/*` + 邮件派生 entity）。

### 3.2 设计：MCP 工具桥（取代 hand-wrapped 2 工具）
- chat harness 加一个 **MCP 工具桥**：启动时拉 KOS `tools/list` → 按 allowlist 过滤 → 每个工具注册成 `ToolDef`（直接用 KOS 自带 description + inputSchema），handler 代理 `KOSClient.call_tool(name, args)`。LLM 直接调原生工具、自判断查什么。
- **read-only allowlist**（实测 81 工具**无 annotations**，无法靠 `readOnlyHint` 自动过滤 → 按名手工分类）：
  `query` / `search` / `get_page` / `list_pages` / `resolve_slugs` / `get_links` / `get_backlinks` / `traverse_graph` / `get_timeline` / `find_experts` / `find_trajectory` / `recall` / `get_recent_salience`（+ `get_skill` 若开放）。
- **硬护栏**：write / admin 工具（`put_page` / `delete_page` / `add_link` / `*_job` / `sources_*` / `schema_*` / `forget_fact`…）**不进 allowlist**（守住设计原则"chat 不写 KOS、防图谱污染"）。code_* 代码图谱工具与邮件无关，也不进。
- **skill 注入**：理想是消费 KOS 自己发布的 skill（`get_skill().body` 注入 system prompt）—— 但实测 **`list_skills` 当前被 brain owner 关闭**（"Skill publishing is disabled"）。两条路：(a) 请 Lucien 开放 skill publishing（design-intended，最通用，KOS 升级新 skill 自动生效）；(b) 我们自己写一段简短 KOS skill block 兜底（描述 KOS 是什么 + 何时该查 + 邮件源语义）。建议 (a) 为主 + (b) 兜底。
- **通用性**：桥做成 **MCP-generic**（`McpToolBridge`：per-server 配置 + allowlist + 底层 client），KOS 是第一个接入的 server，将来可加别的 MCP server，零额外框架成本。

### 3.3 源可见性（实测关键点 + 新线索）
- default client query 够不到 `sources/email/*`；bulk client 能（实测）。两 client 看图谱不同切片。
- **新线索**：`query` 工具带 `source_id` 参数，且有 `sources_list` 工具 → 也许**单 client 用 `source_id` 就能 scope 到邮件源**，省去双 client。但 default client 之前完全查不到邮件源，说明**跨 OAuth-token 的源可见性**仍是 gating 项。
- → **需 Lucien 确认**：哪个 client 能看哪些 source、能否一个 client 同时看邮件源 + Notion 全域知识。v1 桥底层用能看到邮件源的凭据（bulk，或 Lucien 给一个能看全的 client）。

### 3.4 验收
开 Custom AI 对一封邮件问"这个供应商以前的合同条款是什么" → LLM **自选** KOS 工具（如 `query` / `find_trajectory`）检索 → 返回相关 `sources/email/*` + entity → 回答带来源。KOS 不可达时 LLM 自然降级到本地 FTS5（`email_search_fulltext`）。

---

## 4. 请求 #2：报告 Agent 系统（主体）

### 4.1 架构总览

```
[Python service worker]  report_worker.tick_loop   ← 排程 (daily/weekly/monthly)
  1. fetch briefs        digest_query.fetch_recent_emails(window=cadence)
  2. compute counts      确定性算 总数/未读/紧急/AI已处理/待处理
  3. (可选) KOS enrich   对 top 发件人/项目 调 bulk client kos_digest/query
  4. LLM 生成            client.py tool_use → ReportDocDraft (headline/overview/分组/section intro/highlights)
  5. 后端组装            用代码权威数据回填 counts/links/internal_ids → 完整 ReportDoc.blocks
  6. 存 report 表        blocks_json = SSoT
        │
        ▼  (同一个 sync_store.db)
[Electron main]  handlers/report.ts   ← better-sqlite3 直读 (与 handlers/email.ts 同模式)
  IPC: report:list / report:get / report:runNow / report:getConfig / report:setConfig
        │
        ▼
[Renderer]  /agents 路由页
  报告列表 + 详情(BlockRenderer 逐块渲染) + agent 配置面板
```

- **后端在 Python**（常驻、取数 / LLM / 链接全在 Python 侧；直接复用 DailyDigest 基础设施）。
- **前端读**：复用现有"Electron main `better-sqlite3` 直读 `sync_store.db` + IPC"模式（与 [`handlers/email.ts`](../frontend/src/electron/main/handlers/email.ts) 一致），**不走 serve-api**（serve-api 是远程访问用，v1 不做远程）。
- **防幻觉纪律（抄 DailyDigest）**：counts 与 internal_ids 由**代码**算，LLM 只写文案（headline / overview / section 介绍 / 每封一句点评）+ 分组 + 挑 highlights。后端组装时用真实数据回填，LLM 出错爆炸半径限定在文案。

### 4.2 报告块模型 DSL（ReportDoc，JSON SSoT）

```jsonc
ReportDoc = {
  version: 1,
  agent_id: "daily_email_digest",
  cadence: "daily" | "weekly" | "monthly",
  report_date: "2026-06-01",            // slot 日期
  window: { start: ISO, end: ISO },
  generated_at: ISO,
  model: "claude-sonnet-4-6",
  blocks: Block[]
}
```

`Block` 是按 `type` 区分的 discriminated union：

| type | 字段 | 数据来源 | 说明 |
|---|---|---|---|
| `header` | title, subtitle, date_label | 代码 | 报告头 |
| `overview` | text | **LLM** | 一段总览 |
| `stat_row` | stats:[{key,label,value,tone}] | **代码** | 统计卡：总数/未读/紧急/AI已处理/待处理 |
| `section` | id, title, icon, intro? | 代码定标题 + **LLM 写 intro** | 分组：需关注 / 已处理 / FYI |
| `email_item` | internal_id, subject, sender_name, sender_addr, time, category, priority, ai_summary, ai_action, source:{notion_url, app_deeplink?}, badges[] | **代码** | 可点溯源的邮件行 |
| `key_points` | title?, items:[text] | **LLM** | 你必须知道的关键信息 |
| `callout` | tone(info\|warn\|critical), title, body | **LLM** | 高亮提示 |
| `kos_context` | entity_slug, title, snippet, source | 代码(KOS) | KOS 增强卡（可选） |
| `action_suggestion` | id, title, detail, internal_ids, action_type, enabled:false | 代码 | **v1 仅展示不执行** |
| `trend` | metric, points:[{label,value}], compare? | **代码** | 周/月报趋势（前端用纯 CSS bar / inline SVG 画，无需图表库） |
| `divider` | — | — | 分隔 |

**渲染原则**：每种 block 一个 React 组件；未知 type 优雅降级（跳过 / 纯文本）。前端**无图表库** → trend 用纯 CSS / inline SVG（claude design 定）。

### 4.3 LLM 生成（结构化 + 防幻觉）

- 复用 [`client.py`](../src/llm_agent/client.py) + `tool_use` 强制 JSON Schema（同 `digest_summarizer` 模式）。
- LLM 输出 schema = ReportDoc 的"**可写子集**"：
  ```jsonc
  ReportDocDraft = {
    headline, overview,
    sections: [{ id, title, intro, email_refs: [internal_id] }],   // LLM 把邮件分配到组
    key_points: [text],
    highlights: [{ tone, title, body }]
  }
  ```
- 后端把 `email_refs` 校验回真实候选集（丢弃幻觉 id），映射成 `email_item`（含权威链接），拼成完整 `blocks`。
- **默认日报 prompt**（基于用户 Notion 示例 prompt 的意图）：
  - 角色：Lucien 的邮件日报助手（Jarvis）；回顾目标日期邮件。
  - 策展四块：① Jarvis（Email Agent）已处理了什么 ② 还需你亲自关注的 ③ 你必须知道的关键信息 ④ 一般 / FYI 已汇总。
  - prompt 可在 agent config 编辑。
  - ⚠️ **待办**：把用户 Notion 那页（`2e015375830d80cb...`）完整 prompt 导入为默认 —— 需用户把该页共享给 MailAgent integration，或直接贴文本（当前该页未共享，integration 404）。

### 4.4 数据层

- `fetch_recent_emails(window_hours)`：daily=24 / weekly=168 / monthly=720。
- counts：`compute_counts`（复用）。
- 溯源链接：`notion_url = https://www.notion.so/{page_id.replace('-','')}`（[`EmailMetadataRecord.notion_url`](../src/repository/email_repository.py)）；app deeplink = 打开该封邮件（复用 inbox 选中路由，机制实现期定）。

### 4.5 调度

- `report_worker.tick_loop`（抄 [`daily_digest.tick_loop`](../src/notify/daily_digest.py)）：60s tick + fire window + `sync_store` state 去重 + 开机补推。
- cadence：daily（hours=[9] 可配）/ weekly（weekday=Mon + hour）/ monthly（day=1 + hour）。
- gate：`MAILAGENT_REPORT_AGENT_ENABLED`（总开关）+ per-agent `config.enabled`。
- 挂 [`service.py`](../src/service.py) worker 列表（`daily_digest_task` 旁）。

### 4.6 存储 schema（`sync_store.db`，bump DB_VERSION，走 `/db-migration`）

```sql
-- agent 配置表（可扩展向全自定义）
CREATE TABLE report_agent (
  id TEXT PRIMARY KEY,              -- "daily_email_digest"
  type TEXT NOT NULL DEFAULT 'report',
  enabled INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  schedule_json TEXT,              -- {cadence, hours, weekday?, day_of_month?}
  window_hours INTEGER,
  prompt TEXT,
  model TEXT,
  tools_json TEXT,                 -- 预留: 该 agent 可用 tool 白名单
  kos_enrich INTEGER DEFAULT 0,
  updated_at REAL
);
-- 报告产物表
CREATE TABLE report (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  cadence TEXT,
  report_date TEXT,                -- slot 日期
  window_start TEXT, window_end TEXT,
  status TEXT,                     -- generating|ready|failed|skipped|empty
  blocks_json TEXT,                -- ReportDoc SSoT
  counts_json TEXT,
  model TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL,
  error TEXT, created_at REAL, generated_at REAL
);
CREATE INDEX idx_report_agent_date ON report(agent_id, report_date DESC);
```

### 4.7 配置（可扩展 schema）

- v1 固定 `type=report`；预留 `type` / `tools_json` / 将来 `trigger` / `url` 字段为全自定义铺路。
- 用户在 /agents 页可：启用 / 停用、改 prompt、改排程 / 窗口、选 model、**Run now**（即时生成）。

### 4.8 日 / 周 / 月差异

| cadence | 窗口 | 侧重 | 主力块 |
|---|---|---|---|
| daily | 24h | 策展明细（关注 / 已处理 / FYI） | `email_item` |
| weekly | 7d | 趋势 + 跨项目进展（KOS entity 最增值） | `trend` + `kos_context` + 精选 email |
| monthly | 30d | 高层回顾 | `trend` + 高层 `callout` + 极简明细 |

### 4.9 前端（claude design handoff 面）

**入口**：Sidebar `AI AGENTS` 段的 "Custom AI" 行改为导航到新 `/agents` 路由页（仿现有 `sessionsRoute`）。

**`/agents` 页 = tabs**：
1. **Agents**：报告 agent 卡片（状态 / 下次运行 / enabled toggle / Run now / 进配置）。
2. **报告**：report 列表（按日期、cadence 筛选、状态 badge）+ 详情（BlockRenderer 逐块渲染 ReportDoc）。
3. **Chats**：复用现有 `SessionsPage` 作为一个 tab（"chats 历史只是其中一个模块"）。

**需设计的屏 / 组件 / 状态**：
- Agents 概览卡（enabled toggle、排程展示、最近一次报告、Run now）。
- 报告列表（日期分组、cadence 筛选、状态 badge：ready / generating / failed / empty）。
- 报告详情 = **BlockRenderer**：渲染 §4.2 全部 block 类型。重点：
  - `email_item`：点击 → app 内打开该邮件；hover 显示 ai_summary；priority / category badge。
  - `stat_row`：统计卡视觉。
  - `trend`（周 / 月报）：纯 CSS / inline SVG 简单图。
- agent 配置面板（prompt 编辑 textarea + 排程 + 窗口 + model 选择 + 保存）。
- 空 / 加载 / 失败态：generating 骨架屏、failed 重试、empty（"昨天无需特别关注的邮件"）。
- 主题：深 / 浅 / accent 跟随现有设计系统。

**数据契约**：前端拿到 `ReportDoc`（`blocks_json`）直接渲染，契约见 §4.2。

### 4.10 后端接口（IPC，Electron main `better-sqlite3` 直读）

| IPC channel | 入参 | 出参 |
|---|---|---|
| `report:list` | {cadence?, limit, offset} | [{id, agent_id, cadence, report_date, status, headline, counts}] |
| `report:get` | {id} | {ReportDoc(blocks_json) + meta} |
| `report:runNow` | {agent_id, date?} | 触发即时生成 |
| `report:getConfig` | {agent_id} | report_agent 行 |
| `report:setConfig` | {agent_id, patch} | 更新后的配置 |

- **Run now 实现**（实现期定）：推荐加 `mailagent report run --agent <id> --date <YYYY-MM-DD>` CLI，main 通过托管子进程即时跑（无 60s 等待）；scheduled 路径走 worker tick。备选：写 report 行 `status=generating` + state 触发，worker 下个 tick 拾取。
- v1 **不做** serve-api report router（远程访问是 future）。

---

## 5. 实施阶段（PR 拆分）

| PR | 范围 |
|---|---|
| P0 | schema 迁移（`report_agent` + `report` 表，bump DB_VERSION）+ config flags |
| P1 | 数据层（fetch by cadence + 候选 + counts）+ ReportDoc 块模型 + 后端组装器（代码回填） |
| P2 | LLM 生成器（tool_use schema + 默认日报 prompt）+ `report_worker.tick_loop` 挂 service.py |
| P3 | KOS MCP 工具桥（请求 #1）：`McpToolBridge` 拉 tools/list → read-only allowlist → 注册 ToolDef 代理 KOSClient + KOS skill 注入 + 底层用能看邮件源的 client（取代 hand-wrapped kos_query/kos_digest） |
| P4 | 前端 /agents 路由页 + BlockRenderer + 配置面板（**待 claude design 后实现**） |
| P5 | dogfood（跑真日报 + 验收 + CLAUDE.md / 文档更新） |

> P0-P3 可在 claude design 进行的同时先做（纯后端，与前端解耦）；P4 待设计稿。

---

## 6. 验收标准

- **日报**：开关开 → 次日 9am 生成一份 `ReportDoc`，应用内 /agents 可查看，每封邮件可点溯源；无邮件时 empty 态。
- **KOS**：Custom AI 对邮件提问 → LLM 调 `kos_query`（bulk client）返回相关邮件 / entity → 回答带来源；KOS 不可达降级 FTS5。
- **防幻觉**：报告里的 counts / 链接 / internal_ids 与 DB 一致（代码回填，非 LLM 生成）。

---

## 7. 开放问题 / 待确认

1. **KOS source 可见性 + 凭据**（需 Lucien）：实测 default client 查不到 `sources/email/*`，bulk 能。`query` 带 `source_id` 参数 + 有 `sources_list` 工具 → 也许单 client 用 `source_id` 即可 scope。确认：哪个 OAuth client 能看哪些 source、能否一个 client 同时看邮件源 + Notion 全域知识。
2. **KOS skill publishing**（需 Lucien）：实测 `list_skills` 被 brain owner 关闭。请开放（消费 KOS 自发布 skill 是最通用路径，新 skill 自动生效）；否则我们自写 KOS skill block 兜底。
3. **默认日报 prompt**（需用户）：把 Notion 页 `2e015375830d80cb...` 共享给 MailAgent integration，或贴文本，导入为默认 prompt。
4. **app deeplink 打开邮件**：确认前端打开某封邮件的路由 / 机制（复用 inbox 选中状态？）。
5. **Run now 触发机制**：CLI 直跑 vs worker 拾取 —— 实现期定（推荐 CLI）。
6. **报告与灵动岛 DailyDigest 的关系**：二者共用数据层，输出不同（富报告 vs 通知）。是否将来统一 / 灵动岛通知带"日报已生成"deeplink —— v1 先并存。
