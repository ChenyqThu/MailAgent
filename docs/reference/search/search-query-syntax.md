# 邮件搜索查询语法规格（Search Query DSL v1）

> **架构现状（2026-06，Phase A+B 后 / v0.12.0）**：搜索已**收敛为单一 Python 引擎 CORE#1**（`src/repository/email_repository.py` + `src/repository/search_query.py`）。
> 旧 TypeScript 引擎 CORE#2（`frontend/src/.../search_query_parser.ts`）在 Phase B（G-B1a）**整体删除**；桌面 ⌘K 命令面板经 **loopback serve-api**（`127.0.0.1:8200` → `GET /api/email/search`，token 由 chat_local_bridge webRequest 注入）打到同一 Python 核——
> 因此**人工搜索与 AI agentic 搜索结果结构性恒一致**（同引擎，而非靠夹具对齐两份实现）。agentic 搜索（自然语言 → DSL → 引擎）由 AI SDK Gateway 工具调用驱动，见 [`llm-agent/ai-sdk-gateway-architecture.md`](../llm-agent/ai-sdk-gateway-architecture.md) §13。
> 本文档是该单一引擎的**权威规格**。行为锚 = `tests/repository/test_search_query_behavior.py`（读 `tests/fixtures/search_query_behavior.json`；旧 TS vitest runner 已随 CORE#2 删除）。
> 改语法 = 先改本文档 + 夹具，再改引擎。

## 1. 目标

让一个 query 字符串同时承载全文检索 + 字段过滤 + 逻辑组合，Gmail 风格：

```
from:alice subject:周报 is:unread after:2026-06-01 has:attachment -from:noreply 产品评审
```

入口签名**零变更**：Python `EmailRepository.search_email_bodies(query, ...)`、TS `searchEmails(opts)`、
serve-api `GET /api/email/search?q=`、CLI `mailagent email search`、chat tools `email_search_fulltext`
全部在 query 字符串内部升级，调用方自动获益。

## 2. 语法元素

### 2.1 字段过滤器 `field:value`

| 字段 | 别名 | 编译目标 | 匹配方式 |
|---|---|---|---|
| `from:` | — | `sender` / `sender_name` | `(sender LIKE '%v%' OR sender_name LIKE '%v%')` |
| `to:` | — | `to_addr` | `LIKE '%v%'` |
| `cc:` | — | `cc_addr` | `LIKE '%v%'` |
| `subject:` | — | `subject` | `LIKE '%v%'`（substring，不走 FTS） |
| `mailbox:` | `in:` | `mailbox` | `LIKE '%v%'`；内置英文别名先映射：inbox→收件箱、sent→发件箱、archive→存档、drafts→草稿箱（命中别名则映射后 LIKE） |
| `after:` | `since:` | `date_received` | `datetime(date_received) >= datetime(v_utc)`，见 §4.3 |
| `before:` | `until:` | `date_received` | `datetime(date_received) < datetime(v_next_day_utc)`（date-only 时取次日 0 点，**当天含**） |
| `date:` | `on:` | `date_received` | 当天范围（after+before 组合） |
| `newer_than:` | — | `date_received` | 相对 now：`Nd/Nw/Nm/Ny`（天/周/月/年，m=30d, y=365d），`>= now - N` |
| `older_than:` | — | `date_received` | `< now - N` |
| `is:` | — | 布尔列 | `read`→is_read=1、`unread`→is_read=0、`flagged`→is_flagged=1、`unflagged`→is_flagged=0、`pinned`→is_pinned=1、`important`→is_important=1 |
| `has:` | — | 附件（存在性） | `attachment`→`EXISTS (SELECT 1 FROM email_attachment a WHERE a.internal_id = m.internal_id AND COALESCE(a.is_inline,0)=0)` |
| `filename:` | — | 附件文件名（内容） | 非 inline 附件文件名子串：`EXISTS (SELECT 1 FROM email_attachment a WHERE a.internal_id = m.internal_id AND COALESCE(a.is_inline,0)=0 AND COALESCE(a.filename,'') LIKE '%v%')`。plain LIKE，不进 trigram 家族，**不受 `SEARCH_TRIGRAM_ENABLED` 影响**，CJK/拉丁同路且覆盖 <3 字符短值（`filename:v2`）。与 `has:attachment`（存在性）/ `attachment:`（内容）正交 |
| `attachment:` | — | 附件正文 + 文件名（内容） | 附件**内容检索**过滤谓词（filename OR text_content，EXISTS join 回邮件）。值路由镜像 §9.6 CJK 谓词族：`SEARCH_TRIGRAM_ENABLED=true` 时 ≥3 字符（任意文种）→ `email_attachment_fts_trigram MATCH`（两列）、2 字 CJK/短拉丁 → trigram 表列 LIKE、1 字 CJK → 拦截 + `cjk_too_short` warning；flag=false → 降级 `email_attachment_fts`（unicode61，仅 text_content）整词 MATCH（CJK 大概率 0 命中）。命中归因 `source='body'`/`filename=null`（过滤谓词不做归因，带归因排名走附件融合 lane，见 §9.7）。inline 附件**结构性**不可命中（登记面只 enqueue 非 inline 附件抽文本，两张附件 FTS 表都只索引 `status='extracted'` 行——与 `filename:` 的显式 `is_inline=0` 过滤等效但机制不同）。与 `has:attachment`（存在性）正交 |
| `priority:` | — | `ai_priority` | 别名映射后 `LIKE '%映射词%'`：urgent/紧急→紧急、important/重要→重要、normal/一般→一般、low/低→低（DB 实际值带 emoji 前缀如 `🔴 紧急`，故用 LIKE）。未知值→原值 LIKE |
| `sort:` | — | （排序指令，非过滤谓词） | `relevance` / `date`（别名 `newest`）/ `oldest`，详见 §4.4。不产生 WHERE 谓词，只覆盖 ORDER BY；首个有效值生效，非法值 → `unknown_value:sort:<v>` warning |
| `body:` | — | `email_body_fts.body_markdown` | FTS5 column filter；值复用 smart transform，参与 bm25/RRF；不替代裸词全文 |
| `subject~:` | — | `email_body_fts.subject` | FTS5 column filter；与既有 `subject:` LIKE 并存，`subject:` 语义不变 |
| `sender~:` | — | `email_body_fts.sender` | FTS5 column filter；与既有 `from:` LIKE 并存，`from:` 语义不变 |
| `to~:` | — | `email_recipient_fts.to_addr` | FTS5 column filter（**并行收件人表**，非 `email_body_fts`）；与既有 `to:` LIKE 并存，`to:` 语义不变 |
| `cc~:` | — | `email_recipient_fts.cc_addr` | FTS5 column filter（并行收件人表）；与既有 `cc:` LIKE 并存，`cc:` 语义不变 |
| `from~:` | — | `email_recipient_fts.sender_name` | FTS5 column filter（并行收件人表，仅 `sender_name`）；与既有 `from:` LIKE（`sender`/`sender_name`）并存，`from:` 语义不变 |

通用规则：
- 字段名 **大小写不敏感**（`From:` = `from:`）；值保持原样（LIKE 本身 ASCII 大小写不敏感）。
- 值含空格 → 引号：`from:"Zhang San"`、`subject:"weekly report"`。
- 值为空（`from:` 后无内容）→ 丢弃该 token + 记 warning。
- **未知字段名**（`foo:bar`）→ 整个 token 降级为普通文本词（宽容，不报错）。
- `is:` / `has:` 的未知值 → 丢弃 + warning。

### 2.2 文本词 / 短语（全文检索）

- 裸词 → FTS5 MATCH（`email_body_fts`：body_markdown + subject + sender 三列），多词 **AND**。
  **裸词不含收件人**（to_addr / cc_addr / sender_name）—— `email_body_fts` 不索引收件人列，
  收件人专属内容只能用下面的 `to~:` / `cc~:` / `from~:` 显式查（②保守语义：裸词搜索一行不碰
  并行收件人表，故存量裸词查询逐字节零回归）。
- `body:` / `subject~:` / `sender~:` → 同样是全文 unit，但编译成 `email_body_fts` 的 FTS5
  column filter（如 `subject : redis`）；它们是新增语法，不改变 `subject:` / `from:` 的 LIKE 过滤语义。
- `to~:` / `cc~:` / `from~:` → 收件人全文化（T8）。编译成**并行表** `email_recipient_fts`
  （索引 email_metadata 的 to_addr / cc_addr / sender_name 三列）的 MATCH 子查询，作为
  `m.internal_id IN (SELECT rowid FROM email_recipient_fts WHERE email_recipient_fts MATCH '<col>:<expr>')`
  AND 过滤谓词；与正文裸词组合时，正文词走 `email_body_fts` 排名、收件人词作 AND 过滤；
  只有收件人词、无正文裸词时直接对 `email_recipient_fts` MATCH 取 bm25 排名。它们与既有
  `to:` / `cc:` / `from:` 的 LIKE 硬过滤并存、互不改变。**与 `to:`/`cc:` LIKE 的区别**：
  `to:` 是 substring LIKE（`to_addr LIKE '%v%'`），`to~:` 走 FTS5 token 匹配（按
  `@` / `.` 切分的 token，参与相关度），二者各取所需。
- graceful degrade：`email_recipient_fts` 表缺失（旧库未迁移到 v25）→ MATCH 子查询抛
  `OperationalError` 被搜索路径 try/except 接住，不崩（该查询返回空，flag-free 升级后表恒在）。
- 纯 alnum/CJK 的 token → 复用现有 CJK smart transform（`smart_query_transform` / `smartQueryTransform`），行为不变。
- `"exact phrase"` → FTS5 短语 query（原样带引号传入 MATCH）。
- 文本 token 含 FTS5 特殊字符（`* ( ) : . @ -` 等非 alnum/CJK 字符）→ **双引号包裹转义**后进 MATCH（内部 `"` 翻倍转义），避免被 FTS5 误解析为语法。例：`foo:bar`（未知字段）→ MATCH 片段 `"foo:bar"`。

### 2.3 否定 `-`

- token **开头**的 `-` 表示否定：`-报告`、`-from:noreply`、`-is:read`、`-"weekly report"`。
- token 中间的 `-` 不是否定（`e-mail`、`2026-06-01` 正常）。
- 否定字段 → `NOT (谓词)`。
- 否定文本词 → `m.internal_id NOT IN (SELECT rowid FROM email_body_fts WHERE email_body_fts MATCH :neg_expr)`（多个否定词 OR 进同一个子查询的 MATCH 表达式）。纯否定（只有负词无正词）也支持——主查询退化为 metadata 扫描 + NOT IN。

### 2.4 逻辑组合

- 相邻 token 之间 = **隐式 AND**。
- 大写 `OR`（必须全大写，孤立 token）结合**左右相邻各一个 unit**：
  - 两侧均为字段条件 → SQL `(p1 OR p2)`；链式 `a OR b OR c` 合并为一组 `(a OR b OR c)`。
  - 两侧均为文本词/短语 → FTS 表达式 `(e1) OR (e2)`。**1g（`SEARCH_TRIGRAM_ENABLED`）**：正向文本 OR 组含**裸 CJK 成员**时，整组改编译成 `(IN trigram子查询 OR IN unicode子查询 …)` 的 AND 谓词（CJK≥3 合进一条 trigram MATCH、2 字 CJK 各自 trigram LIKE、拉丁成员保持 unicode61 MATCH），并整组排出 body MATCH——`评审 OR 周三` 等 CJK 组员的中文子串不再漏召回；纯拉丁 OR 组逐字节不变。见 §9.6。
  - **跨类 OR**（一侧字段一侧文本）→ 降级为 AND + 记 warning（v1 不支持）。
- 括号分组 v1 不支持（出现的 `(` `)` 在文本 token 内按 §2.2 转义处理）。
- 否定 unit 不参与 OR 组合（`-a OR b` → `-a AND b` + warning）。

### 2.5 raw 逃生门

`mode='raw'`（CLI `--raw` / API `raw=true` / SearchOpts `mode:'raw'`）→ **跳过全部语法解析**，
query 原样下放 FTS5 MATCH（现状行为，高级 FTS5 语法 NEAR/列过滤走这里）。

## 3. 解析流程（单核）

1. `mode='raw'` → 直通，结束。
2. tokenize：按空白切分，但**引号内的空白不切**（支持 `from:"a b"` 与 `"a b"`；未闭合引号 → 该引号视为普通字符 + warning）。
3. **字段容错合并（merge pass）**：若某 token 是孤立的已注册 `field:`（含 `sort:` 与 `body:` / `subject~:` / `sender~:` / `to~:` / `cc~:` / `from~:`，冒号后空值），且其后紧跟一个**非字段过滤器、非 `OR`** 的 token（可为引号词），则合并为 `field:<下一个 token>`（保留前导 `-` 否定）。例：`from: echo`→`from:echo`、`-from: echo`→`-from:echo`、`from: "Zhang San"`→`from:"Zhang San"`。**不合并**（保持丢弃 + `empty_value` warning）：孤立 `field:` 在末尾、下一个是字段过滤器（如 `from: from:bob`、`from: -is:read`、`from: sort:date`）、下一个是 `OR`。注：值含空格仍需引号——只吞紧跟的一个 token（`from: a b` → `from:a` + 文本 `b`）。
4. 逐 token 分类：否定前缀 → 字段匹配（`^([A-Za-z_]+~?):(.*)$` 且字段名在注册表）→ 短语 → 文本词。
5. OR 结合（§2.4），产出结构化查询：`{ fts_terms[], fts_or_groups[], neg_fts_terms[], filters[], or_filter_groups[], neg_filters[], warnings[] }`。
6. **零语法 fast-path（回归红线）**：若解析结果不含任何字段过滤器、否定、OR 重组（即纯文本词/短语），必须走**与现状完全相同**的代码路径：整串 query 交给 smart transform（含其对 quote/wildcard/operator 的 raw-passthrough 判断）。保证存量查询行为逐字节不变。

## 4. SQL 编译

### 4.1 有正向文本词

```sql
SELECT m.internal_id, m.subject, m.sender, m.date_received, m.mailbox,
       snippet(email_body_fts, 0, '<mark>', '</mark>', '…', N) AS snippet,
       bm25(email_body_fts, 1.0, 5.0, 2.0) AS rank   -- T1: body/subject/sender 列权重
       [, 平台各自的附加列]
  FROM email_body_fts
  JOIN email_metadata m ON m.internal_id = email_body_fts.rowid
 WHERE email_body_fts MATCH :fts_expr
   [AND <filters...>]
   [AND m.internal_id NOT IN (SELECT rowid FROM email_body_fts WHERE email_body_fts MATCH :neg_expr)]
 ORDER BY rank ASC, datetime(m.date_received) DESC   -- T1: 相关度 + 时间 tie-break（sort: 可覆盖，见 §4.4）
 LIMIT :limit
```

`:fts_expr` = 各正向文本 unit 的 smart/短语/转义片段以 AND/OR 连接；列级 unit 编译成
FTS5 column filter（如 `body_markdown : redis`、`subject : "weekly report"`）。

T5 起，smart 模式的正向全文查询还会并行查附件正文：

```sql
SELECT m.internal_id, m.subject, m.sender, m.date_received, m.mailbox,
       a.filename,
       snippet(email_attachment_fts, 0, '<mark>', '</mark>', '…', N) AS snippet,
       bm25(email_attachment_fts) AS rank
  FROM email_attachment_fts
  JOIN email_attachment a ON a.id = email_attachment_fts.rowid
  JOIN email_metadata m ON m.internal_id = a.internal_id
 WHERE email_attachment_fts MATCH :attachment_fts_expr
   [AND <same metadata filters as body search>]
   [AND m.internal_id IN (SELECT rowid FROM email_body_fts WHERE email_body_fts MATCH :body_gate_expr)]
   [AND m.internal_id NOT IN (SELECT rowid FROM email_body_fts WHERE email_body_fts MATCH :neg_body_expr)]
   [AND a.id NOT IN (SELECT rowid FROM email_attachment_fts WHERE email_attachment_fts MATCH :neg_attachment_expr)]
 ORDER BY rank ASC, datetime(m.date_received) DESC
 LIMIT :candidate_limit
```

- `:attachment_fts_expr` 只包含附件表可解释的未限定列全文词；`body:` / `subject~:` / `sender~:` 作为
  `:body_gate_expr` 在 `email_body_fts` 上门控附件命中。只有列级词、没有裸全文词时，不启用附件维度。
- 两个候选列表分别按相关度取 candidate window 后做 RRF 融合（`k=60`）：
  `score = Σ 1 / (60 + row_number)`。同一邮件正文和附件都命中时按 `internal_id` 去重，
  `source='body'`、保留正文 snippet，但 RRF 分数叠加；仅附件命中时 `source='attachment'`，
  `filename` 填附件名，snippet 来自 `email_attachment_fts.snippet()`。
- 对外 `rank` 在融合路径中返回 **负 RRF 分数**，继续保持“数值越小越相关”的旧排序直觉。
- `mode='raw'` 仍只查 `email_body_fts`，作为高级 FTS5 语法逃生门。

### 4.2 纯过滤（无正向文本词）

```sql
SELECT m.internal_id, m.subject, m.sender, m.date_received, m.mailbox,
       '' AS snippet, 0.0 AS rank [, 附加列]
  FROM email_metadata m
 WHERE <filters...>
   [AND m.internal_id NOT IN (... MATCH :neg_expr)]
 ORDER BY datetime(m.date_received) DESC
 LIMIT :limit
```

snippet 为空串、rank 为 0（接口形状不变，前端 snippet 空则不渲染）。

### 4.3 日期归一（修正存量 bug）

`date_received` 存量数据**时区偏移混存**（`+00:00` / `-06:00` / `-07:00`），裸字典序比较边界错位最多 ~15h；
date-only 的 `until <= '2026-06-01'` 还会漏掉当天全部邮件。因此：

- 比较一律 `datetime(m.date_received) >= datetime(:v)`（SQLite datetime() 解析时区后缀并归一 UTC）。
- date-only 值（`YYYY-MM-DD`）按**本地时区**解释：`after:2026-06-01` → 本地 06-01 00:00 → 转 UTC ISO；`before:2026-06-01` → 本地 06-02 00:00（次日）→ `<`，实现"当天含"。
- 带时间的值（`YYYY-MM-DDTHH:MM[:SS]`）原样按本地时区转 UTC。
- 非法日期值 → 丢弃 + warning。
- `newer_than:/older_than:` 相对 `now`；**parser 接受注入的 now 与本地时区偏移**（生产取系统值，测试由夹具注入）。
- 结构化参数 `since`/`until`（SearchOpts / CLI flag / API query param）保持入口不变，但内部统一走同一编译路径（即同样获得 datetime 归一修正），与语法过滤器 AND 合并。

### 4.4 排序

默认：有正向文本词 → smart 模式按正文候选 + 附件候选的 RRF 融合分降序（对外 `rank=-rrf_score`），同分时 `datetime(date_received) DESC`；raw 模式仍按 `bm25(email_body_fts, body=1.0, subject=5.0, sender=2.0) ASC` + `datetime(date_received) DESC`；纯过滤 → `datetime(date_received) DESC`（最新优先）。

`sort:` 覆盖（T2）：`sort:relevance`（相关性/RRF；纯过滤无 rank 时 fallback 时间倒序）、`sort:date`（别名 `sort:newest`，时间倒序）、`sort:oldest`（时间正序）。`sort:date` / `sort:oldest` 会忽略 RRF 排序，仅把正文/附件去重后的邮件按时间排。`sort:` 只改 ORDER BY、不产生过滤谓词；首个有效 `sort:` 生效，非法值 → `unknown_value:sort:<v>` warning 并回退默认。

## 5. 结果与警告

- 返回结构（EmailSearchHit / SearchHit / API items）新增可选字段：
  - `source: 'body' | 'attachment'`，默认 `'body'`；表示当前 snippet 来自正文还是附件正文。
  - `filename: string | null`，仅 `source='attachment'` 时填附件名，正文命中为 `null`。
- `SearchResult` / CLI meta / API meta 新增**可选** `parse_warnings: string[]`（additive，不破坏 wire 契约；无 warning 时省略）。
- **自我收敛信号（Phase A G-A2，additive）**：
  - `total_matches: number`（前端 `SearchResult` / serve-api `data` / pydantic `SearchResult`）= **本次查询命中数**（= `items.length`，≤ 请求 `limit`）。**不是**语料总量 `total_indexed`——后者继续用于命令面板 footer「N of total_indexed」，但不再作为 agentic 搜索的命中信号喂给模型。CLI envelope 沿用既有 `meta.total_hits`（同语义，未重命名）。
  - `has_more: boolean`（`SearchResult` / serve-api `data` + `meta` / CLI `meta` / pydantic）= 是否还有超出本次 `limit` 的命中。由 `search_email_bodies_with_meta` / 前端 `searchEmails` 的 **`limit + 1` 探针**精确判定（多取 1 条检测溢出，再裁回 `limit`；返回的 `items` 与不探针时的 top-`limit` **逐条一致**，零结果回归）。
  - 用途：搜索 agent 据 `has_more`/工具 `hint` 自我收敛——命中太多就加 `from:/after:/subject:` 等 filter 缩小，0 命中就放宽重试。由单核 CORE#1 实现，人工搜索与 agentic 搜索共用同一信号（Phase B 收敛后无需双端对齐）。
- **AI 命中投影（Phase B MED-2）**：返回结构补 `ai_priority` / `lang`（5 条执行路径统一经 `_ai_fields_select_join` 投影，旧库无列时 schema-probe 降级），让命令面板渲染优先级 chip + 语言 pip，桌面经 loopback 后与本地直查逐字段一致。
- FTS5 运行期语法错误维持现状：log warning + 返回空列表。parser 自身**永不抛异常**——任何畸形输入最坏退化为文本搜索。

## 6. 行为夹具（单核回归锚）

> Phase B 收敛单核后，本节从「跨语言（Python↔TS）一致性」降级为**单核回归锚**——TS 引擎已删除，夹具只锚定 Python CORE#1 的行为不漂移。

`tests/fixtures/search_query_behavior.json`（repo 根，唯一真源）：

```jsonc
{
  "now": "2026-06-13T12:00:00",        // 注入的本地 now
  "tz_offset_minutes": 480,             // 注入的本地时区（北京 +08:00）
  "emails": [ { "internal_id": 1, "subject": "…", "sender": "…", "sender_name": "…",
                "to_addr": "…", "cc_addr": "…", "date_received": "…", "mailbox": "收件箱",
                "is_read": 0, "is_flagged": 0, "is_pinned": 0, "is_important": 0,
                "ai_priority": "🔴 紧急", "body_markdown": "…",
                "attachments": [{ "filename": "a.pdf", "is_inline": 0,
                                  "text_content": "optional extracted attachment text" }] } ],
  "cases": [ { "name": "field_from_basic", "query": "from:alice",
               "expect_ids": [1, 3], "order": "set",          // set=集合比对（默认）, exact=顺序比对
               "expect_warnings": 0,
               "expect_hits": [{ "internal_id": 1, "source": "body", "filename": null }] } ]
}
```

- Python：pytest runner 建 in-memory SQLite（最小 schema：email_metadata + email_body_fts(contentful, rowid=internal_id) + email_attachment + email_attachment_text + email_attachment_fts），灌 emails；`attachments[].text_content` 存在时写入 `email_attachment_text` 并索引到 `email_attachment_fts`，逐 case 跑 search、断言。
- TS：~~vitest runner~~ **Phase B（G-B1a）已删除**——桌面 ⌘K 经 loopback serve-api 复用 Python 引擎，无独立 TS 检索代码，故无需 TS 夹具 runner。夹具现仅由 Python runner 消费。
- 夹具必须覆盖：每个字段至少 1 例、别名、引号值、否定（字段/文本/纯否定）、OR（字段同类/文本同类/跨类降级）、未知字段降级文本、空值丢弃、date-only 边界（当天含）、时区混存数据的日期过滤、newer_than 相对日期、纯过滤排序、列级 FTS（`body:` / `subject~:` / `sender~:`）、收件人 FTS（`to~:` / `cc~:` / `from~:` 命中 + 收件人词 + 正文词 AND + **裸词不命中收件人专属 token** 守卫 + 负向收件人），附件正文融合（only attachment / body+attachment / metadata filter 传播）、parsed 路径 OR 组 CJK 子串（`p5_or_group_*`：2 字 LIKE / ≥3 MATCH 合并 / CJK+拉丁并集 / 纯拉丁不变 pin）与列级 CJK 子串（`p5_column_*`：`body:`/`subject~:` 2 字/≥3 / 负向 / 与 filter 组合 / flag-off prefix-only pin，见 §9.6）、DSL 附件字段（`attachment_field_*`：CJK ≥3 MATCH / 2 字 LIKE / 拉丁 / 短拉丁 <3 LIKE + flag-off 对照 / 命中文件名列 / 组合 AND / 否定 / 1 字 CJK 拦截 / OR 相邻悬空 `dangling_or`（`attachment:` 不进 OR 组，镜像 `sort:` 先例）/ trigram-off 子串漏召回 + 整词命中 / 空值 warning；`filename_field_*`：拉丁子串 / <3 字符短值 / inline 排除 / 不命中正文 / 否定，见 §9.8；v38 缺表 fail-closed pin 在 `TestAttachmentTrigramLaneDegrade`）、零语法 fast-path 行为不变（与现状对照例）、CJK smart 不回归、与结构化参数 merge。

## 7. 示例

| Query | 语义 |
|---|---|
| `from:alice 报告` | 发件人含 alice 且全文匹配"报告" |
| `from:alice OR from:bob is:unread` | (alice 或 bob 发的) 且未读 |
| `subject:"weekly report" -from:noreply` | 主题含短语且发件人不含 noreply |
| `产品评审 has:attachment newer_than:7d` | 近 7 天带附件的"产品评审"相关邮件 |
| `in:收件箱 is:flagged priority:urgent` | 收件箱中旗标且 AI 判定紧急（纯过滤，按日期倒序） |
| `redis OR timeout -is:read` | 全文 redis 或 timeout，且未读 |
| `date:2026-06-01 from:tp-link.com` | 本地时区 6 月 1 日当天、发件域含 tp-link.com |
| `subject~:Redis timeout` | subject FTS 命中 Redis，且正文/标题/发件人或附件正文命中 timeout |
| `contract from:alice` | 正文或附件正文含 contract，且邮件发件人满足 alice |
| `attachment:合同` | 存在附件的**正文或文件名**含"合同"（纯过滤，按日期倒序；命中记 `source='body'`） |
| `filename:roadmap is:unread` | 未读且存在非 inline 附件文件名含"roadmap"（含 `roadmap_v2.xlsx`；短值 `filename:v2` 同理） |

## 8. 局限与未来扩展（v1 明确不做）

- 括号分组、跨类 OR。
- 不给既有 `subject:` / `from:` 叠加 FTS boost；它们继续是 LIKE 硬过滤。需要列级相关度时使用新增 `subject~:` / `sender~:`。
- `to:` / `cc:` / `from:` 的 **LIKE 硬过滤**不叠加 FTS boost（仍是 substring LIKE）；需要收件人
  全文/相关度时用 T8 新增的 `to~:` / `cc~:` / `from~:`（并行 `email_recipient_fts` 表，见 §10）。
- **带归因的**附件融合（`source='attachment'` + `filename` 归因、参与 RRF 排名）只在 smart 正向全文路径启用；`mode='raw'` 保持正文 FTS5 逃生门。列级 FTS term（`body:`/`subject~:`/`sender~:`）在这条融合分支里作为 `email_body_fts` 门控，只有列级 term、没有裸全文词时不做带归因的附件融合。**但附件不再只能被动 gate**：`attachment:` / `filename:` 两个字段（parsed 路径过滤谓词，见 §2.1）可直接主动检索附件正文/文件名——它们是 AND 过滤谓词、不做归因（命中 `source='body'`/`filename=null`），与融合 lane 的带归因排名是两套语义（要归因升级另立独立 lane）。
- jieba 词典级中文分词（更重，双运行时一致性风险；trigram 已覆盖子串搜索，见 §9）。**裸全文中文子串**已由 §9 trigram 路由解决（flag-gated）；**列级 FTS** `body:` / `subject~:` / `sender~:` 的**中文值**（parsed 路径）1g 起也走 trigram 同名列子串（`SEARCH_TRIGRAM_ENABLED` 门；`body:产品` 现能命中 `本周产品评审...`，见 §9.6）；**收件人列级** `to~:` / `cc~:` / `from~:` 仍走 `unicode61`（recipient 表无 trigram 变体，本批 out of scope）。
- ~~保存搜索/搜索历史~~ **已在 Phase B（G-B3）落地**：⌘K 命令面板 localStorage 搜索历史（去重/上限 8）+ 收藏搜索 CRUD + facet chips（`is:unread` / `has:attachment`，引号感知 token toggle），见 `frontend/src/shared/state/search-history.ts` + `frontend/src/shared/lib/dsl_token.ts`。
- 纯过滤查询是 metadata 全表扫描（7 万行 ~30-60ms 可接受；变慢再加索引/物化）。

## 9. CJK 中文分词（T7 并行 trigram 表，flag-gated）

**问题**：主表 `email_body_fts` 用 `porter unicode61` tokenizer，把连续 CJK 串当成**单一 token**（`本周产品评审` 是 1 个 token），所以裸查 `产品` 仅命中含独立 `产品` token 的 doc，漏掉 `产品评审`。`smart_query_transform` 的字符级 `产* AND 品*` fallback 能部分缓解，但中间子串（如 `评审定` 命中 `本周产品评审定...`）仍漏。

**方案**（②并行 trigram 表，设计源 `.trellis/tasks/06-17-dsl-parse-warnings/research/codex-t7-tokenizer.md`）：

- **主表 `email_body_fts`（unicode61）不动** → 英文 / 已有路径**逐字节零回归**。
- 新增并行 **contentful** FTS5 表 `email_body_fts_trigram`（`tokenize='trigram'`，DB v24），由 4 个 trigger（insert/delete/update on `email_body` + meta_update on `email_metadata`）自动同步。contentful（非 contentless）是因为 2 字中文要靠 `LIKE` 兜底，需读列值。
- **开关 `SEARCH_TRIGRAM_ENABLED`（Phase A 起默认 `True`）**：开启时裸全文 CJK query 走 trigram 子串路由（§9.1）；设 `False` 则搜索逐字节退回旧路径（unicode61 + smart transform）。

### 9.1 路由规则（仅 flag=True + 裸全文 query 含 CJK 时生效）

对每个**裸全文 term**（无列限定 / 非短语；走 `is_plain_passthrough` fast-path；term 已按空格切分、无内部空格）按「是否含 CJK + **整 term 字符长度**」分路由：

| term 形态 | 路由 | 说明 |
|---|---|---|
| 无 CJK，整 term < 3 字符 | 仅 unicode | 主表 `email_body_fts MATCH` + `smart_query_transform`（不变）；trigram MATCH <3 字符无召回，不追加 lane |
| 无 CJK，整 term ≥ 3 字符（批次1 PR2/PR4） | unicode ∪ trigram 子串（双 lane 并集） | `SEARCH_LATIN_TRIGRAM_ENABLED`（默认 true）门；开时组内追加 `email_body_fts_trigram` 整词 MATCH 子串 lane，修复连写文档漏召回（正文 `Omada固件升级` 无空格）+ 拉丁子串模糊（`Omad`→`Omada`）；flag off 回单 unicode lane（逐字节 PR2 前行为）。含 CJK 混合 query 内按 term 生效（本路径 `_search_email_bodies_trigram`）；纯英文整 query（不含 CJK）在 `_search_email_bodies_fused` 侧按整串短语生效（不做 per-term AND 重组，避免改多词旧语义），见 §9.7 |
| 含 CJK 且整 term ≥ 3 字 | trigram MATCH（整串） | `email_body_fts_trigram MATCH '<整串短语>'`（整 term 用 `_quote_fts_token` 包成 FTS5 短语，含符号/中英混合也安全）|
| 含 CJK 且整 term = 2 字 | trigram LIKE（整串） | trigram 表 `body/subject/sender LIKE '%整串%'` 兜底（MATCH <3 字符无召回）|
| 含 CJK 且整 term = 1 字 | 拦截 | 不查该 term，push warning `cjk_too_short:<字>`（单字全表扫描噪声太高）|

- **含 CJK 的连续 term 整体走 trigram 子串检索**（**不再拆 CJK/Latin 段各自 MATCH 后 AND 交集**）。
  历史 bug：旧实现把连续 term（如 `研发项目deadline汇报`）按 CJK/非 CJK 边界拆段，latin 段
  `deadline` 走 unicode61 主表 MATCH——但 unicode61 只能整词/前缀匹配，嵌在连续 token 中间的
  `deadline` 召回为 0 → 段间 AND 交集空 → 整 term 搜不到（用户实测「拆短了反而搜得到」即此）。
  整 term 走 trigram 子串后，连续串 `研发项目deadline汇报` / `【项目进度】` / `central立项` 都能正确命中。
- **多 term 之间 AND**（rowid 交集）：term 由空格切分，仍逐 term 路由后求交集（如 `redis 产品评审` =
  `redis`(unicode) ∩ `产品评审`(trigram MATCH)）。**无内部空格的连续混合串是单个 term，整体走 trigram**，
  不再被拆成 latin/CJK 子段。
- **rank 融合**：复用 P1 RRF 基础设施（`_RRF_K=60`）。每个 term 候选列表按命中顺序计 `1/(60 + row_number)`，多 term 求和，`ORDER BY score DESC, date DESC`。
- **2 字 LIKE 无 bm25** → 启发式排序：`subject` 命中 > `sender` 命中 > `body` 命中，同档按 rowid DESC。

### 9.2 已知约束

- **1 字中文不查**（warning `cjk_too_short`）；前端可据此提示"请输入至少 2 个字"。
- **2 字 LIKE 无相关度**（bm25 在 trigram 表 LIKE 查询下返回 0），靠列位置启发式排序。
- **英文不回归**：英文 term 始终走 unicode61（保留 porter stemming + remove_diacritics）；trigram 路由只接管含 CJK 的裸全文 query。
- **列级 CJK（parsed 路径）1g 起走 trigram**：`body:` / `subject~:` / `sender~:` 的**中文值**编译成 trigram 表**同名列** column-filter 子查询谓词（≥3 MATCH `col : "短语"` / 2 字该列 LIKE / 1 字拦截 warning），见 §9.6；值无 CJK 仍走 unicode61。**收件人列级** `to~:` / `cc~:` / `from~:` 不变（recipient 表无 trigram 变体）。附件正文融合（T5）语义不变。
- **回滚**：关 `SEARCH_TRIGRAM_ENABLED` 即回 unicode 路径（含 1g 的 OR 组/列级 CJK 谓词一并回退）；彻底回退见 `sync_store.py` v24 迁移块注释（DROP 4 trigger + DROP `email_body_fts_trigram`，主表不动）。

### 9.3 跨语言一致性

行为夹具（§6）新增 `trigram: true` per-case 开关——标记的 case 把 `SEARCH_TRIGRAM_ENABLED` 置 True 跑，其余 case 默认 False 作零回归守卫。Python runner 建 `email_body_fts_trigram` 表灌数据；前端 TS runner（better-sqlite3，trigram tokenizer 已验证支持）须建同表 + 实现 `build_search_plan` 等价路由，读同一份 JSON 锁行为。

### 9.4 trigram 路径 snippet 高亮（P4a）

trigram 路径早期把 hit 的 `snippet` 设成 `''`（前端只剩 subject 高亮）。中英混合搜索（如 `central 立项`）只显示中文 subject，看不到英文词命中的正文片段，用户误判英文没参与。**P4a 给 trigram 结果补 snippet**（`build_trigram_snippet_expr` / `buildTrigramSnippetExpr`，Python/TS 逐行镜像，夹具锁）：

- 构造「snippet 匹配表达式」= 所有 **trigram-MATCH-able 词**的 OR：
  - unicode term：其 `original` 按 `[A-Za-z0-9]+` 抽词取 len≥3 的。
  - trigram term 且 `trigram_mode=='match'`（整 term ≥3 字）：收**整 term** `trigram_core`（连续混合串
    如 `研发项目deadline汇报` / `central立项` 整体进表达式 → snippet 高亮整段连续命中串）。
  - **2 字 CJK（`trigram_mode=='like'`）和 1 字 CJK 不进表达式**（trigram MATCH <3 字符无效）。每个 token 包成 FTS5 短语 `"..."` 以 `OR` 连接。
- 表达式非空 → 对 top-N id 跑 `snippet(email_body_fts_trigram, 0, '<mark>', '</mark>', '…', 24) ... WHERE rowid IN (...) AND email_body_fts_trigram MATCH '<expr>'`，把高亮片段映射回 hit（高亮命中的 `【项目进度】`/`研发项目deadline汇报`/`产品评审` 等）。`snippet()` 只能在带 MATCH 的查询里用。
- 表达式为空（纯 2/1 字 CJK 查询）或某 row 不被表达式 MATCH（只 2 字 LIKE 命中）→ **fallback**：取 `body_markdown` 前 ~80 字符做无高亮摘要（不经 `snippet()`），保证 snippet 不再恒空。
- 前端复用既有 DOMPurify 渲染（snippet 含 `<mark>`，`CommandPalette` 已 sanitize 注入）。

### 9.5 冷启动预热（P4a perf，仅 Electron 主进程）

2 字 CJK（如 `立项`）走 `email_body_fts_trigram` 的 `body_markdown/subject/sender LIKE '%词%'` = 全表扫（~7700 行）；冷缓存首查实测 ~1.4s、热 ~0.3s（≥3 字 MATCH / 英文都 <0.01s）。**缓解**：主进程在 `waitReady()` 确认 serve 迁到 `EXPECTED_DB_VERSION`（FTS 表齐全）后，`index.ts` 用 `setImmediate` fire-and-forget 调 `warmSearchFtsCache()`（`handlers/email.ts`），对 `email_body_fts_trigram` + `email_recipient_fts` 各跑一次匹配不到的 sentinel（`LIKE '% zzwarm%'`）全扫触页进缓存。module 级 `_ftsWarmed` flag 守只跑一次；`try/catch` 失败静默；`setImmediate` 让 `createWindow` 先跑完，**不阻塞开窗/首帧**。

### 9.6 parsed 路径的 OR 组 + 列级 CJK 走 trigram（1g，flag-gated）

§9.1 的 trigram 路由原先只接管 **plain fast-path**（无字段语法）的裸 CJK term；一旦 query 带字段（`from:` / `is:` / 列词等）就走 **parsed 路径**，裸 CJK term 由 `_build_cjk_trigram_predicates` 编成 trigram IN/NOT-IN 谓词（P5 已落）。1g 把 parsed 路径**另外两个死角**也接进 trigram（同一族谓词构造器，`email_repository.py`）：

- **含裸 CJK 成员的正向文本 OR 组**（`评审 OR 周三` / `评审 OR redis`）：整组编译成单条 `(IN … OR IN …)` AND 谓词——CJK≥3 成员合进一条 `email_body_fts_trigram MATCH '("a") OR ("b")'`、2 字 CJK 成员各自 `(body/subject/sender LIKE '%词%')`、拉丁/列成员合进一条 `email_body_fts MATCH` unicode61 子查询，三类 SQL 级 `OR` 连接；整组从 body MATCH 排除（镜像裸 CJK term 的 `_exclude_from_body_match`）。**语义红线**：子串放宽只对 CJK 成员生效，纯拉丁 OR 组逐字节不变（不进新分支）。
- **body 列 term 的 CJK 值**（`body:产品` / `subject~:产品` / `sender~:产品`）：编译成 trigram 表**同名列** column-filter 子查询（列映射 `body_markdown/subject/sender` 与主表一致；≥3 → `MATCH 'col : "短语"'`、2 字 → `col LIKE '%值%'`、1 字 → 拦截 + `cjk_too_short` warning），从 body MATCH 排除该 unit。负向 `-body:产品` 对称 `NOT IN`。值无 CJK → 现状不变。该 trigram column 谓词落 `metadata_predicates`、**同时约束 body 与 attachment 两条 lane**，故列级 CJK 词也**排出附件的 unicode61 body-gate**（`_build_attachment_body_gate_expr`）——否则更严的整词/前缀 gate 会盖掉 trigram 子串，让 `<附件词> body:<CJK 内部子串>` 漏附件命中；flag off 时 gate 照旧 unicode61（零回归）。**收件人列级 `to~:` / `cc~:` / `from~:` 不做**（recipient 表无 trigram 变体，out of scope）。

两者均只受 master `SEARCH_TRIGRAM_ENABLED` 门（CJK 语义，与 `SEARCH_LATIN_TRIGRAM_ENABLED` 无关）；关闭即逐字节回 unicode61。这些 unit 本就是 AND 过滤谓词/排除出 body MATCH（与既有裸 CJK term 同款），不参与 bm25 排名。行为夹具（§6）新增 `p5_or_group_*` / `p5_column_*` case 锁定（含 flag-off 与纯拉丁 OR 组的不变 pin）。

### 9.7 附件融合进 trigram 路径（批次1 PR4）

**背景**：PR4 之前，`_search_email_bodies_trigram`（含 CJK 裸查快路径）提前 return，完全不查附件——中文正文能搜、附件正文/文件名搜不到；`_search_email_bodies_fused`（纯英文路径）虽融合附件，但附件维度只有 unicode61 整词/列级门控，没有子串模糊。

**方案**：PR3 先建并行 contentful FTS5 表 `email_attachment_fts_trigram(filename, text_content)`（`tokenize='trigram'`，rowid=attachment_id，DB v39），由 3 个 trigger 自动同步 `email_attachment_text`（仅 `status='extracted'` 有正文的行）+ `email_attachment.filename` 变更——设计镜像正文 trigram 表（§9）先例。PR4 把它接成两条 plain 路径各自候选组的**并集 lane**：

- **`_search_email_bodies_trigram`（含 CJK 快路径）**：每个 term 的 AND 组内追加一条 attachment-trigram lane（组语义变为「该 term 命中 正文 OR 附件正文 OR 附件文件名」；组间跨 term 仍是 AND，每 term 至少命中邮件某处，不要求同一附件）。CJK term（≥3 字 MATCH / 2 字 LIKE / 1 字拦截）的附件 lane 只受 master `SEARCH_TRIGRAM_ENABLED` 门；拉丁 term（≥3 字符，见 §9.1）的附件 lane 另受 `SEARCH_LATIN_TRIGRAM_ENABLED` 子门（镜像正文双 lane）。
- **`_search_email_bodies_fused`（纯英文路径）**：整 query（≥3 字符，master + latin 双门均开）除追加正文 trigram 子串 lane（§9.1）外，同时 union-only 追加一条附件 trigram MATCH 子串 lane（只增召回不减，AND 语义零变化）。
- MATCH 默认跨 `filename` + `text_content` 两列，文件名子串（中/英）随之可搜（1f，如 `固件手册`、`roadmapzeta` 命中对应文件名的附件）。同邮件多附件命中同 term 按 `internal_id` 去重（保留 bm25 最优位次）；正文 + 附件同 term 双命中 → `source='body'` 优先（与既有 lane 注册顺序语义一致，正文先于附件）；仅附件命中 → `source='attachment'` + `filename`。
- graceful degrade：`email_attachment_fts_trigram` 表缺失（v38 老库未迁移到 v39）→ MATCH/LIKE 抛 `OperationalError` 被搜索路径 try/except 接住，返回空（该维度不生效，搜索不崩）。
- **回滚**：关 master `SEARCH_TRIGRAM_ENABLED` 整体回旧路径（含此附件 lane，回到 PR4 前「CJK 快路径不融合附件」现状）；只想撤拉丁子串的附件面可单独关 `SEARCH_LATIN_TRIGRAM_ENABLED`（CJK 附件 lane 不受影响）；彻底回退 `email_attachment_fts_trigram` 见 `sync_store.py` v39 迁移块注释（DROP 3 trigger + DROP 表；正文 trigram 表 `email_body_fts_trigram` / 主表 `email_body_fts` / 附件主 FTS 表 `email_attachment_fts` 均不动）。

### 9.8 DSL `attachment:` / `filename:` 字段如何复用/不复用附件 trigram 基建（批次2）

§9.7 的附件 trigram 表 `email_attachment_fts_trigram` 除了喂 plain 路径的**带归因融合 lane**，批次2 起还被 DSL 的 `attachment:` 字段（§2.1）当作**过滤谓词**的检索源——两者语义分层，实现不共用一行 lane 代码：

- **`attachment:`（内容检索谓词）** = `_attachment_content_predicate` / `_build_attachment_content_predicates`（`email_repository.py`），是 §9.6 CJK 谓词族（`_column_cjk_term_predicate`）指向附件表的**姊妹函数**：`m.internal_id IN (SELECT a.internal_id FROM email_attachment_fts_trigram JOIN email_attachment a ON a.id=rowid WHERE …)`。值路由镜像裸 CJK 词（≥3 字符任意文种 → MATCH 两列 / 2 字 CJK+短拉丁 → 列 LIKE / 1 字 CJK → 拦截 + `cjk_too_short`），`SEARCH_TRIGRAM_ENABLED=false` 降级 `email_attachment_fts`（unicode61，仅 text_content）整词 MATCH。它进 `_search_email_bodies_parsed` 的 `predicates` 列表 → 纯 `attachment:` 查询天然走**纯过滤 else 分支**（不依赖 fts_expr 非空，绕开「无裸文本词落空」死角），**零 lane/fused 路径改动**。命中不做归因（`source='body'`/`filename=null`），这是 D1 接受语义——要 `source='attachment'` 归因走 §9.7 融合 lane（`email_search_attachments` 工具同源）。
- **`filename:`（文件名子串谓词）** = 普通 `FilterPredicate`（`search_query.py` `_build_filter_predicate`），**不碰任何 trigram/FTS 表**：直接对 `email_attachment.filename` 列做 `LIKE '%v%' ESCAPE`（排除 inline），附件行仅数千、LIKE 扫描零成本，**不受 `SEARCH_TRIGRAM_ENABLED` 影响**且覆盖 <3 字符短值（trigram MATCH 硬约束接不住）。CJK/拉丁同路。
- graceful degrade：`attachment:` 谓词 SQL 命中缺失的 trigram 表（v38 老库）时，谓词 AND 在它所在的每条候选语句里（纯过滤单条 SELECT / fused 各 lane / recipient-ranked），语句抛 `OperationalError` 被语句级 try/except 接住返回空 → 含 `attachment:` 的查询**整体返回空**（fail-closed，不崩、log warning；**不是**「谓词静默失效=过滤被放宽」——用户不会拿到假装被过滤过的结果）。这与 §9.7 融合 lane 的降级（lane 级静默缺席、body 结果照常）是两种粒度，pin 在 `TestAttachmentTrigramLaneDegrade`；`filename:` 只碰 `email_attachment` 恒在，无降级问题。
- 行为夹具（§6）新增 `attachment_field_*` / `filename_field_*` case 锁定（含 trigram-off 子串漏召回/整词命中 pin、inline 排除、短值、组合 AND、否定）。

## 10. 收件人全文化（T8 并行 recipient 表，无 flag）

**问题**：旧版 `to:` / `cc:` 只走 substring LIKE（`to_addr LIKE '%v%'`），收件人不进任何 FTS 索引，
无法参与相关度，也没有 token 级匹配；`email_body_fts` 又**只索引 body/subject/sender 三列**，
裸词搜索天然不含收件人。

**方案（②保守 + 并行 contentful 表，DB v25）**：

- **主表 `email_body_fts` 一行不动** → 裸词搜索逐字节零回归（②保守语义：裸词不碰收件人）。
- 新增并行 **contentful** FTS5 表 `email_recipient_fts`（`to_addr`, `cc_addr`, `sender_name`；
  `tokenize='porter unicode61 remove_diacritics 2'`，rowid=internal_id）。**数据源是
  `email_metadata` 三列**（与 `email_body_fts` 来自 `email_body` 不同），由 3 个 trigger
  自动同步：`AFTER INSERT` / `AFTER UPDATE OF to_addr,cc_addr,sender_name` / `AFTER DELETE`
  on `email_metadata`。
- **无 flag**：纯新增 `to~:` / `cc~:` / `from~:` 显式 FTS 列语法，opt-in，不改任何现有行为。
  `to:` / `cc:` / `from:` 的 LIKE 过滤完全不变。

### 10.1 编译规则

- 正向单 term → `m.internal_id IN (SELECT rowid FROM email_recipient_fts WHERE email_recipient_fts MATCH '<col>:<expr>')` 作 AND 过滤谓词。
- 正向且全为收件人列的 OR 组 → 组内 `(c1:e1) OR (c2:e2)` 合进同一条 MATCH 子查询。
- 负向 term（`-to~:x`）→ `m.internal_id NOT IN (SELECT rowid FROM email_recipient_fts WHERE ... MATCH ...)`。
- query 同时有正文裸词 → 正文 term 走 `email_body_fts` MATCH 排名，收件人 term 作 IN-子查询 AND 过滤。
- query **只有**收件人列 term（无正文裸词、无 `sort:date`/`oldest`）→ 直接 `FROM email_recipient_fts MATCH` 取 `bm25` 排名。
- 与 T5 附件融合 / T7 trigram / T6 主表列级互不冲突（收件人是独立的新增列 + 独立表）。
- graceful degrade：`email_recipient_fts` 表缺失（旧库未迁移到 v25）→ MATCH 子查询抛
  `OperationalError`，被搜索路径 try/except 接住，不崩。

### 10.2 与 `to:`/`cc:`/`from:` LIKE 的区别

| 语法 | 编译 | 匹配 |
|---|---|---|
| `to:bob` | `to_addr LIKE '%bob%'` | substring，不参与相关度 |
| `to~:bob` | `email_recipient_fts MATCH 'to_addr:bob'` | FTS5 token（按 `@`/`.` 切分），参与 bm25 排名 |
| `from:alice` | `(sender LIKE '%alice%' OR sender_name LIKE '%alice%')` | substring，邮箱地址 + 显示名 |
| `from~:alice` | `email_recipient_fts MATCH 'sender_name:alice'` | FTS5 token，仅显示名 `sender_name` |

### 10.3 回滚

三个新语法只在 parser 显式列名出现时生效，不影响裸词；彻底回退见 `sync_store.py` v25 迁移块注释
（DROP 3 trigger + DROP `email_recipient_fts`，主表 `email_body_fts` / `email_body_fts_trigram` 不动）。

### 10.4 跨语言一致性

行为夹具（§6）的收件人 case **无 per-case 开关**（无 flag，恒生效）。Python runner 建
`email_recipient_fts` 表并镜像 insert trigger 从 fixture email 的 to_addr / cc_addr / sender_name
灌数据；前端 TS runner 须建同表 + 实现等价编译（`to~:`/`cc~:`/`from~:` + 表维度），读同一份 JSON 锁行为。
前端镜像还需：`TextTerm` 加表维度（哪张表的哪列）、`EXPECTED_DB_VERSION` 抬到 25。
