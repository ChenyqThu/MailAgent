# 邮件报告 Agent + Custom AI KOS 工具 — PRD

> **状态**：📐 设计中（2026-06-02）。本 PRD 待用户 review → handoff claude design 设计前端 → 据前端实现前后端。
> **分支**：`feat/report-agent`
> **受众**：Lucien（单用户）。
> **关联**：复用 [`daily_digest.py`](../../../src/notify/daily_digest.py) / [`digest_query.py`](../../../src/notify/digest_query.py) / [`client.py`](../../../src/llm_agent/client.py) / KOS [`client.py`](../../../src/kos/client.py)。

---

## 0. 决策记录（2026-06-02 对齐）

| 决策点 | 选择 |
|---|---|
| 报告渲染对接 | **LLM 输出结构化 JSON 块模型 → 前端 React 原生渲染**（非 LLM 直出 HTML，非纯 Markdown） |
| Custom Agent 首版范围 | **报告型模板优先**（日/周/月报），配置 schema 预留全自定义 |
| KOS 在对话中的用法 | **精选 KOS 工具集 + skill 注入：读跨 3 源 union（query/recall/find_experts/get_page）给 LLM 自驱；写回 default 需确认**（不主动注入、不硬塞） |
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

## 3. 请求 #1：Custom AI 对话的 KOS 工具（精选工具集 + skill 注入）

> **设计哲学**（2026-06-02 用户定调）：不替 LLM 查 / 不主动注入；**把 KOS 的接口 + 使用指南给 LLM，让它按邮件上下文自判断该查什么、何时写回**。KOS 本身就是这么设计的（thin-client 消费）。设计依据 = KOS 自己给的消费契约（2026-06-02 Lucien 提供）。

### 3.1 现状（实测 2026-06-02）
- **KOS 是 MCP server**（`https://kos.chenge.ink/mcp`，OAuth client_credentials，client=`mailagent`）。`list_skills` 现已开放（**56 个 skill**），`get_skill(name)` 返回 `{frontmatter, body, usable_tools, client_guidance}`。
- **读跨 3 源 union（已配，实测）**：单次 `query` 跨 `default`（个人脑）+ `mailagent-emails`（邮件语料）+ `omada`（产品知识：用户指南/FAQ/综合观点），无需指定 source；要限定才传 `source`。实测 `Omada gateway 配置` 一次返 `companies/tp-link` + `sources/email/42856` + `faq/3148-...` 三源混合。
- 现有 hand-wrapped `kos_query` / `kos_digest`（PR-2e，[`kos.ts`](../frontend/src/electron/main/chat/tools/builtin/kos.ts)）只 2 个窄 tool，描述未提三源、未含写回 —— 本次扩成精选工具集。

### 3.2 设计：精选 KOS 工具集（取代 hand-wrapped 2 工具）
按 KOS 给的消费契约，chat harness 注册一组**精选**工具（proxy 到 TS `KOSClient.call_tool`），**不 dump 全部 81 工具**（KOS 明确哪些该用、哪些批处理/操作员 skill 不该逐封邮件调、且很贵）：

| 工具 | tier | 作用 |
|---|---|---|
| `query(query, limit, [source])` | silent | 混合检索（跨 3 源 union），返带 `[来源 slug]` 引证 hits。回答必须基于检索、无证据说"大脑里没有" |
| `recall([source])` | silent | per-source 热记忆 facts |
| `find_experts(topic)` | silent | "谁了解 X" |
| `get_page(slug)` | silent | 按 slug 精确读一页 |
| `list_skills` / `get_skill(name)` | silent | 发现 + 取 KOS 工作流指令（照其步骤执行） |
| `extract_facts(text)` | **confirm** | 从邮件正文抽取并**写入**个人知识事实到 default（返 inserted/superseded/fact_ids）；实测确认是写操作 → 需弹窗确认 |
| `put_page(slug, content)` | **confirm** | 写/更新一页到 `default` 个人脑（markdown+frontmatter；需 ConfirmToolDialog 批准） |

- **读跨源、写定向**：读用默认 `mailagent` client（union 三源）；`put_page` 本 client 写入 `default`。**邮件衍生知识进 `mailagent-emails` 语料由后端 producer（bulk client）独占**，chat 不写邮件语料（防污染）。
- KOS 不可达 / `E_KOS_*` → tool 返 `ok:false`，LLM 自然降级到本地 `email_search_fulltext`（FTS5）。
- 超时降级：query 实测偶发 ~10s 超时，tool timeout 10s + 单次跳过。

### 3.3 系统 prompt KOS 块（注入 chat system header，gate by KOS consumer enabled）
把 KOS 使用指南作为一段 prose 注入 system prompt（复用 PR-2f 的 static header KOS 槽位）：

> 你可调用 KOS（知识大脑）按需获取/写入信息。读跨 3 源（default 个人脑 / mailagent-emails 邮件语料 / omada 产品知识）union，无需指定 source。
> **何时用**：邮件涉及某人/公司/产品/技术点 → 先 `query` 看大脑已知什么（背景、往来、产品事实）再回信/处理；得到值得长期保留的事实/决定/承诺 → 写回（`put_page`，需确认）。
> **纪律**：回答必须基于检索内容，不编造，无证据就说"大脑里没有"；写入要可追溯（注明邮件 message-id/发件人/日期）；拿不准先 `query`/`get_skill`。
> **skill**：可 `list_skills`/`get_skill` 发现工作流（query / idea-ingest / media-ingest / brain-ops / enrich / meeting-ingestion）；**绝不**调批处理/操作员 skill（corpus-ingest / corpus-synth / synthesis-sweep / enrich-sweep / kos-patrol / digest-to-memory / image-ingest —— 整库/定时作业且贵）。

### 3.4 验收
开 Custom AI 对一封邮件问"这个供应商以前的合同条款是什么" → LLM 自选 `query` → 跨源返 `sources/email/*` + 相关 entity（可能含 omada FAQ）→ 回答带来源。"记住 X 是 Y" → LLM 调 `put_page`（弹确认）写回 default。KOS 不可达 → 降级 FTS5。

### 3.5 开放点（已大幅收敛）
- ~~源可见性~~ → **已解决**：mailagent client query 跨 3 源 union（Lucien 已配，实测）。
- ~~skill publishing 关闭~~ → **已解决**：56 skill 已发布。
- ✅ **写能力**（已定 2026-06-02）：用户批准开放 chat 写回 `default` 个人脑 —— `put_page` + `extract_facts` 为 confirm-tier（ConfirmToolDialog 弹窗批准）；绝不写 `mailagent-emails` 邮件语料（producer 独占）。

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
- **前端读**：复用现有"Electron main `better-sqlite3` 直读 `sync_store.db` + IPC"模式（与 [`handlers/email.ts`](../../../frontend/src/electron/main/handlers/email.ts) 一致），**不走 serve-api**（serve-api 是远程访问用，v1 不做远程）。
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

- 复用 [`client.py`](../../../src/llm_agent/client.py) + `tool_use` 强制 JSON Schema（同 `digest_summarizer` 模式）。
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
- 溯源链接：`notion_url = https://www.notion.so/{page_id.replace('-','')}`（[`EmailMetadataRecord.notion_url`](../../../src/repository/email_repository.py)）；app deeplink = 打开该封邮件（复用 inbox 选中路由，机制实现期定）。

### 4.5 调度

- `report_worker.tick_loop`（抄 [`daily_digest.tick_loop`](../../../src/notify/daily_digest.py)）：60s tick + fire window + `sync_store` state 去重 + 开机补推。
- cadence：daily（hours=[9] 可配）/ weekly（weekday=Mon + hour）/ monthly（day=1 + hour）。
- gate：`MAILAGENT_REPORT_AGENT_ENABLED`（总开关）+ per-agent `config.enabled`。
- 挂 [`service.py`](../../../src/service.py) worker 列表（`daily_digest_task` 旁）。

#### 🔴 时区语义（task 07-21 收敛，2026-07-21）

**`hours:[9]` 是哪个时区的 9 点 = `agent.timezone`（IANA），留空 = 本机系统时区**（跟随电脑，owner 拍板）。
fire 判定（`_due_hour` 的 `now.hour` / `weekday` / `day`）、slot marker 的日期、窗口计算
（`_window` / `_period_bounds`）**全部同一口径** —— 与 [`trigger_worker`](../../../src/agents/trigger_worker.py)
的 `UTC now → ZoneInfo → croniter` 范式对齐。

修复前（v1.14.2 及以前）`now_fn` 默认 `datetime.now(UTC+8)` 硬编码，`hours:[9]` 恒为**北京 9 点**，
与电脑时区、与 `agent.timezone` 都无关（owner 从深圳回洛杉矶后变成每天 LA 18:00 触发）。
`agent.timezone` 当时**只**参与窗口计算、不参与 fire 判定 → 触发与数据两套时区。

配套不变量（改这块前必读）：

- **marker 迁移一次性**：`report_last_fire:*` / `last_daily_digest_fire` 的日期从北京日改本地日，
  换算**不幂等**（重复跑每次前移一天），靠 `sync_state` 标记位只跑一次，且**先落标记位再改 marker**。
  换算逻辑单源 [`src/utils/fire_marker_tz.py`](../../../src/utils/fire_marker_tz.py)，report 与 digest 共用。
  🔴 `SyncStore.set_state` 吞 `sqlite3.Error` **返回 `False` 而不抛** —— 判成功必须看返回值，
  只 `try/except` 等于没有保护（本批实际踩过）。
- **周/月报聚合按子报告的窗口中点归属**，不是 `report_date` 字符串。rolling_24h 日报的
  `report_date=生成当天`、内容却是前 24h，按 report_date 选会让周报内容整体前移一天。
  窗口列解析不出的历史行退回 report_date 老判据，但与新判据**互斥**（本周期有可解析命中就不启用），
  否则并集会多算一天且被 `max(0, expected-len)` 吞成 `missing=0`。
- **daily 必先于 weekly/monthly 跑**：新口径下周报要读当天那份日报，靠
  `ReportStore.list_agents()` 的 `(cadence rank, id)` 显式排序保证（改前只是
  `daily_email_digest` < `weekly_email_digest` 的**字母序巧合**）。
  🔴 rank 的 cadence 默认值必须与执行侧同源（`store.cadence_of` / `DEFAULT_CADENCE`）——
  CLI 新建的 report agent `schedule_json` 为空，两处各写字面量默认会让排序与执行语义分裂。
- 周期最后一天的日报缺席时，周报**仍发布**但正文 `missing_note` 点名缺失 + warning 日志
  （owner 拍板；测试只锁「必须诚实标注」，不锁「继续发布」这个行为）。
- 已知未收：多个 daily agent 时聚合跨 agent 求和 → [issue #51](https://github.com/ChenyqThu/MailAgent/issues/51)。

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
  model TEXT,                      -- preprocess 行: 空 = 跟随全局 LLM_MODEL（v1.1.0 行级模型拆分）
  tools_json TEXT,                 -- 预留: 该 agent 可用 tool 白名单
  kos_enrich INTEGER DEFAULT 0,
  updated_at REAL,
  context_docs_json TEXT,          -- v27: preprocess 身份文档勾选（JSON 数组 of profile-doc 名；NULL=默认 soul+user，[]=不注入）
  fallback_models_json TEXT        -- v29: preprocess 行级 fallback 链（JSON 数组；NULL=跟随全局 LLM_FALLBACK_MODELS，[]=显式不设，数组=专用链；非 preprocess 行恒 NULL）
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

> **v1.1.0 增量（DB v27–v29）**：`report_agent` 多了一类 `type='preprocess'` 特殊行 `email_preprocess_agent`（v27 seed）= **AI 邮件预处理 Custom Agent 卡片**——复用本表存运行时配置：`model`（空=跟随全局 `LLM_MODEL`，与 chat 默认模型解耦）+ `context_docs_json`（v27，身份文档勾选）+ `fallback_models_json`（v29，fallback 三态）；开关走全局 env `LLM_AGENT_ENABLED`（非 `enabled` 列），排程/窗口/报告产物字段不适用。读侧 `src/llm_agent/preprocess_config.py` 每封邮件重读该行 → PATCH 保存即生效（`store.py` `_AGENT_PATCH_FIELDS` 白名单含这 3 列）。v28 删除了 `monthly_email_digest` 默认 seed 行（dogfood #9，用户未改默认态才删）。详见 [`llm-agent.md`](../llm-agent/llm-agent.md)「预处理 Agent 化」。

### 4.7 配置（可扩展 schema）

- v1 固定 `type=report`；预留 `type` / `tools_json` / 将来 `trigger` / `url` 字段为全自定义铺路。（v1.1.0 起 `type='preprocess'` 已实际启用 —— AI 邮件预处理 agent 行，见 §4.6 增量注。）
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
| P3 | KOS 精选工具集（请求 #1）：扩 `kos.ts` 注册 query/recall/find_experts/get_page/list_skills/get_skill/extract_facts(silent) + put_page(confirm) 代理 KOSClient + system prompt KOS 块注入（取代 hand-wrapped kos_query/kos_digest） |
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

1. ✅ **KOS 源可见性 + skill publishing（均已解决）**：mailagent client query 跨 3 源 union（default + mailagent-emails + omada，实测）；56 skill 已发布，get_skill 可取 body/usable_tools。读跨源、写定向。
2. **chat 写 KOS 能力**（待用户拍板）：是否开放 `put_page`（confirm-tier）让 chat 写回 `default` 个人脑。KOS 契约鼓励写回，harness 已有写确认机制；建议开（弹窗批准，绝不写邮件语料）。
3. **默认日报 prompt**（需用户）：把 Notion 页 `2e015375830d80cb...` 共享给 MailAgent integration，或贴文本，导入为默认 prompt。
4. **app deeplink 打开邮件**：确认前端打开某封邮件的路由 / 机制（复用 inbox 选中状态？）。
5. **Run now 触发机制**：CLI 直跑 vs worker 拾取 —— 实现期定（推荐 CLI）。
6. **报告与灵动岛 DailyDigest 的关系**：二者共用数据层，输出不同（富报告 vs 通知）。是否将来统一 / 灵动岛通知带"日报已生成"deeplink —— v1 先并存。
