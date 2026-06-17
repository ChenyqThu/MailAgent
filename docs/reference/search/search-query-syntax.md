# 邮件搜索查询语法规格（Search Query DSL v1）

> 本文档是 Python（`src/repository/`）与 TypeScript（`frontend/src/`）两份搜索实现的**共同契约**。
> 两端必须通过同一份行为夹具 `tests/fixtures/search_query_behavior.json` 的全部用例。
> 改语法 = 先改本文档 + 夹具，再同步两端实现。

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
| `has:` | — | 附件 | `attachment`→`EXISTS (SELECT 1 FROM email_attachment a WHERE a.internal_id = m.internal_id AND COALESCE(a.is_inline,0)=0)` |
| `priority:` | — | `ai_priority` | 别名映射后 `LIKE '%映射词%'`：urgent/紧急→紧急、important/重要→重要、normal/一般→一般、low/低→低（DB 实际值带 emoji 前缀如 `🔴 紧急`，故用 LIKE）。未知值→原值 LIKE |
| `sort:` | — | （排序指令，非过滤谓词） | `relevance` / `date`（别名 `newest`）/ `oldest`，详见 §4.4。不产生 WHERE 谓词，只覆盖 ORDER BY；首个有效值生效，非法值 → `unknown_value:sort:<v>` warning |
| `body:` | — | `email_body_fts.body_markdown` | FTS5 column filter；值复用 smart transform，参与 bm25/RRF；不替代裸词全文 |
| `subject~:` | — | `email_body_fts.subject` | FTS5 column filter；与既有 `subject:` LIKE 并存，`subject:` 语义不变 |
| `sender~:` | — | `email_body_fts.sender` | FTS5 column filter；与既有 `from:` LIKE 并存，`from:` 语义不变 |

通用规则：
- 字段名 **大小写不敏感**（`From:` = `from:`）；值保持原样（LIKE 本身 ASCII 大小写不敏感）。
- 值含空格 → 引号：`from:"Zhang San"`、`subject:"weekly report"`。
- 值为空（`from:` 后无内容）→ 丢弃该 token + 记 warning。
- **未知字段名**（`foo:bar`）→ 整个 token 降级为普通文本词（宽容，不报错）。
- `is:` / `has:` 的未知值 → 丢弃 + warning。

### 2.2 文本词 / 短语（全文检索）

- 裸词 → FTS5 MATCH（`email_body_fts`：body_markdown + subject + sender 三列），多词 **AND**。
- `body:` / `subject~:` / `sender~:` → 同样是全文 unit，但编译成 FTS5 column filter
  （如 `subject : redis`）；它们是新增语法，不改变 `subject:` / `from:` 的 LIKE 过滤语义。
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
  - 两侧均为文本词/短语 → FTS 表达式 `(e1) OR (e2)`。
  - **跨类 OR**（一侧字段一侧文本）→ 降级为 AND + 记 warning（v1 不支持）。
- 括号分组 v1 不支持（出现的 `(` `)` 在文本 token 内按 §2.2 转义处理）。
- 否定 unit 不参与 OR 组合（`-a OR b` → `-a AND b` + warning）。

### 2.5 raw 逃生门

`mode='raw'`（CLI `--raw` / API `raw=true` / SearchOpts `mode:'raw'`）→ **跳过全部语法解析**，
query 原样下放 FTS5 MATCH（现状行为，高级 FTS5 语法 NEAR/列过滤走这里）。

## 3. 解析流程（两端一致）

1. `mode='raw'` → 直通，结束。
2. tokenize：按空白切分，但**引号内的空白不切**（支持 `from:"a b"` 与 `"a b"`；未闭合引号 → 该引号视为普通字符 + warning）。
3. **字段容错合并（merge pass）**：若某 token 是孤立的已注册 `field:`（含 `sort:` 与 `body:` / `subject~:` / `sender~:`，冒号后空值），且其后紧跟一个**非字段过滤器、非 `OR`** 的 token（可为引号词），则合并为 `field:<下一个 token>`（保留前导 `-` 否定）。例：`from: echo`→`from:echo`、`-from: echo`→`-from:echo`、`from: "Zhang San"`→`from:"Zhang San"`。**不合并**（保持丢弃 + `empty_value` warning）：孤立 `field:` 在末尾、下一个是字段过滤器（如 `from: from:bob`、`from: -is:read`、`from: sort:date`）、下一个是 `OR`。注：值含空格仍需引号——只吞紧跟的一个 token（`from: a b` → `from:a` + 文本 `b`）。
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
- FTS5 运行期语法错误维持现状：log warning + 返回空列表。parser 自身**永不抛异常**——任何畸形输入最坏退化为文本搜索。

## 6. 跨语言一致性（行为夹具）

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
- TS：vitest runner 用 better-sqlite3 `:memory:` 同样建表灌数据跑断言，**读同一份 JSON 文件**（相对路径 `../../tests/fixtures/...`）。
- 夹具必须覆盖：每个字段至少 1 例、别名、引号值、否定（字段/文本/纯否定）、OR（字段同类/文本同类/跨类降级）、未知字段降级文本、空值丢弃、date-only 边界（当天含）、时区混存数据的日期过滤、newer_than 相对日期、纯过滤排序、列级 FTS（`body:` / `subject~:` / `sender~:`）、附件正文融合（only attachment / body+attachment / metadata filter 传播）、零语法 fast-path 行为不变（与现状对照例）、CJK smart 不回归、与结构化参数 merge。

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

## 8. 局限与未来扩展（v1 明确不做）

- 括号分组、跨类 OR。
- 不给既有 `subject:` / `from:` 叠加 FTS boost；它们继续是 LIKE 硬过滤。需要列级相关度时使用新增 `subject~:` / `sender~:`。
- `to:/cc:` 不进 FTS 索引（LIKE 够用；未来如需全文搜收件人再做 FTS schema migration）。
- 附件融合只在 smart 正向全文路径启用；`mode='raw'` 保持正文 FTS5 逃生门。列级 FTS term 在附件分支作为 `email_body_fts` 门控，只有列级 term、没有裸全文词时不查询附件正文。
- jieba 词典级中文分词（更重，双运行时一致性风险；trigram 已覆盖子串搜索，见 §9）。**裸全文中文子串**已由 §9 trigram 路由解决（flag-gated）；但**列级 FTS** `body:` / `subject~:` / `sender~:` 仍走 `unicode61`，对中文非前缀子串仍有限制（例如 `body:产品` 不保证命中正文 token `本周产品评审...`）。
- 保存搜索/搜索历史（前端后续迭代）。
- 纯过滤查询是 metadata 全表扫描（7 万行 ~30-60ms 可接受；变慢再加索引/物化）。

## 9. CJK 中文分词（T7 并行 trigram 表，flag-gated）

**问题**：主表 `email_body_fts` 用 `porter unicode61` tokenizer，把连续 CJK 串当成**单一 token**（`本周产品评审` 是 1 个 token），所以裸查 `产品` 仅命中含独立 `产品` token 的 doc，漏掉 `产品评审`。`smart_query_transform` 的字符级 `产* AND 品*` fallback 能部分缓解，但中间子串（如 `评审定` 命中 `本周产品评审定...`）仍漏。

**方案**（②并行 trigram 表，设计源 `.trellis/tasks/06-17-dsl-parse-warnings/research/codex-t7-tokenizer.md`）：

- **主表 `email_body_fts`（unicode61）不动** → 英文 / 已有路径**逐字节零回归**。
- 新增并行 **contentful** FTS5 表 `email_body_fts_trigram`（`tokenize='trigram'`，DB v24），由 4 个 trigger（insert/delete/update on `email_body` + meta_update on `email_metadata`）自动同步。contentful（非 contentless）是因为 2 字中文要靠 `LIKE` 兜底，需读列值。
- **灰度开关 `SEARCH_TRIGRAM_ENABLED`（默认 `False`）**：关闭时搜索逐字节同现状（unicode61 + smart transform）；`True` 才启用 CJK 路由。

### 9.1 路由规则（仅 flag=True + 裸全文 query 含 CJK 时生效）

对每个**裸全文 term**（无列限定 / 非短语；走 `is_plain_passthrough` fast-path）按 CJK 长度分路由：

| term 形态 | 路由 | 说明 |
|---|---|---|
| 无 CJK（纯英文/数字/符号） | unicode | 主表 `email_body_fts MATCH` + `smart_query_transform`（不变）|
| CJK ≥ 3 字 | trigram MATCH | `email_body_fts_trigram MATCH`（实测 ≥3 字才有召回）|
| CJK = 2 字 | trigram LIKE | trigram 表 `body/subject/sender LIKE '%词%'` 兜底（MATCH <3 字符无召回）|
| CJK = 1 字 | 拦截 | 不查该 term，push warning `cjk_too_short:<字>`（单字全表扫描噪声太高）|
| 中英混合（CJK + Latin 同 term） | 拆段 | 拉丁段走 unicode61 候选、CJK 段走 trigram 候选，段间 **rowid 交集** |

- **多 term 之间 AND**（rowid 交集）。中英混合多 term（如 `redis 超时`）严禁整串丢 trigram——实测会忽略 2 字中文约束误命中只含英文的行。
- **rank 融合**：复用 P1 RRF 基础设施（`_RRF_K=60`）。每个 term 候选列表按命中顺序计 `1/(60 + row_number)`，多 term 求和，`ORDER BY score DESC, date DESC`。
- **2 字 LIKE 无 bm25** → 启发式排序：`subject` 命中 > `sender` 命中 > `body` 命中，同档按 rowid DESC。

### 9.2 已知约束

- **1 字中文不查**（warning `cjk_too_short`）；前端可据此提示"请输入至少 2 个字"。
- **2 字 LIKE 无相关度**（bm25 在 trigram 表 LIKE 查询下返回 0），靠列位置启发式排序。
- **英文不回归**：英文 term 始终走 unicode61（保留 porter stemming + remove_diacritics）；trigram 路由只接管含 CJK 的裸全文 query。
- **列级 FTS / 附件融合不变**：`body:` / `subject~:` / `sender~:`（T6）与附件正文融合（T5）继续走 parsed 路径（unicode61），不受 trigram 影响。trigram 路由只增强 plain fast-path 的裸全文 term。
- **回滚**：关 `SEARCH_TRIGRAM_ENABLED` 即回 unicode 路径；彻底回退见 `sync_store.py` v24 迁移块注释（DROP 4 trigger + DROP `email_body_fts_trigram`，主表不动）。

### 9.3 跨语言一致性

行为夹具（§6）新增 `trigram: true` per-case 开关——标记的 case 把 `SEARCH_TRIGRAM_ENABLED` 置 True 跑，其余 case 默认 False 作零回归守卫。Python runner 建 `email_body_fts_trigram` 表灌数据；前端 TS runner（better-sqlite3，trigram tokenizer 已验证支持）须建同表 + 实现 `build_search_plan` 等价路由，读同一份 JSON 锁行为。
