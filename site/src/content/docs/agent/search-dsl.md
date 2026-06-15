---
title: "搜索 DSL（Python+TS 双端）"
description: "Search Query DSL v1：字段过滤器 / 否定 / OR / 短语 / 中文 unicode61 前缀通配，跨 Python+TS 双端共享行为夹具，以及如何扩展语法。"
---

MailAgent 的搜索是 Gmail 风格的 **Query DSL** —— 一个 query 字符串同时承载全文检索 + 字段过滤 + 逻辑组合。它有 **Python 与 TypeScript 两份实现**（后端 `src/repository/` + 前端 `frontend/src/`），靠同一份行为夹具保证逐用例一致。

```
from:alice subject:周报 is:unread after:2026-06-01 has:attachment -from:noreply 产品评审
```

:::tip[一份语法，所有入口共享]
DSL 在 query 字符串内部升级，**入口签名零变更**：`EmailRepository.search_email_bodies(query)`（Py）、`searchEmails(opts)`（TS）、serve-api `GET /api/email/search?q=`、CLI `mailagent email search`、chat 工具 `email_search_fulltext` 全部自动获益。
:::

## 语法元素

### 字段过滤器 `field:value`

| 字段 | 别名 | 编译目标（`email_metadata` 列）| 匹配 |
|---|---|---|---|
| `from:` | — | `sender` / `sender_name` | `(sender LIKE '%v%' OR sender_name LIKE '%v%')` |
| `to:` | — | `to_addr` | `LIKE '%v%'` |
| `cc:` | — | `cc_addr` | `LIKE '%v%'` |
| `subject:` | — | `subject` | `LIKE '%v%'`（substring，不走 FTS）|
| `mailbox:` | `in:` | `mailbox` | `LIKE`；英文别名先映射 inbox→收件箱 / sent→发件箱 / archive→存档 / drafts→草稿箱 |
| `after:` | `since:` | `date_received` | `datetime(date_received) >= datetime(v_utc)` |
| `before:` | `until:` | `date_received` | `< datetime(次日 0 点)`（date-only 时**当天含**）|
| `date:` | `on:` | `date_received` | 当天范围（after+before 组合）|
| `newer_than:` | — | `date_received` | 相对 now：`Nd/Nw/Nm/Ny`（m=30d, y=365d），`>= now - N` |
| `older_than:` | — | `date_received` | `< now - N` |
| `is:` | — | 布尔列 | `read`/`unread`/`flagged`/`unflagged`/`pinned`/`important` |
| `has:` | — | 附件 | `attachment` → 存在非内联附件 |
| `priority:` | — | `ai_priority` | 别名映射后 LIKE：urgent/紧急、important/重要、normal/一般、low/低 |

通用规则：

- 字段名**大小写不敏感**（`From:` = `from:`）；值保持原样（LIKE 本身 ASCII 大小写不敏感）。
- 值含空格 → 引号：`from:"Zhang San"`、`subject:"weekly report"`。
- 值为空（`from:` 后无内容）→ 丢弃该 token + 记 warning。
- **未知字段名**（`foo:bar`）→ 整个 token 降级为普通文本词（宽容，不报错）。
- `is:` / `has:` 的未知值 → 丢弃 + warning。

:::caution[中文字面量值]
`mailbox:` / `priority:` 的 DB 实际值是中文（且 `ai_priority` 带 emoji 前缀如 `🔴 紧急`）。英文别名（`inbox` / `urgent`）会被映射成中文后 LIKE；**即便英文环境，直接传中文值（`mailbox:收件箱`）也始终有效**。shell 里中文值注意编码（UTF-8）。
:::

### 文本词 / 短语（全文检索）

- 裸词 → FTS5 `MATCH`（`email_body_fts`：body_markdown + subject + sender 三列），多词 **AND**。
- 纯 alnum/CJK token → 复用 CJK smart transform（`smart_query_transform` / `smartQueryTransform`）。
- `"exact phrase"` → FTS5 短语 query（原样带引号进 MATCH）。
- 含 FTS5 特殊字符（`* ( ) : . @ -` 等）的文本 token → **双引号包裹转义**后进 MATCH，避免被误解析为语法。

### 否定 `-`

- token **开头**的 `-` 表否定：`-报告`、`-from:noreply`、`-is:read`、`-"weekly report"`。
- token 中间的 `-` 不是否定（`e-mail`、`2026-06-01` 正常）。
- 否定字段 → `NOT (谓词)`；否定文本词 → `internal_id NOT IN (SELECT rowid FROM email_body_fts WHERE … MATCH :neg)`。
- 纯否定（只有负词无正词）也支持 —— 主查询退化为 metadata 扫描 + `NOT IN`。

### 逻辑组合

- 相邻 token = **隐式 AND**。
- 大写 `OR`（必须全大写、孤立 token）结合左右相邻各一个 unit：
  - 两侧均字段 → `(p1 OR p2)`；链式 `a OR b OR c` 合并为一组。
  - 两侧均文本 → FTS `(e1) OR (e2)`。
  - **跨类 OR**（一侧字段一侧文本）→ 降级为 AND + warning（v1 不支持）。
- 括号分组 v1 不支持（出现的 `(` `)` 按文本 token 转义处理）。
- 否定 unit 不参与 OR（`-a OR b` → `-a AND b` + warning）。

### raw 逃生门

`mode='raw'`（CLI `--raw` / API `raw=true` / `SearchOpts.mode='raw'`）→ **跳过全部语法解析**，query 原样下放 FTS5 MATCH。高级 FTS5 语法（`NEAR(a,b,5)` / 列过滤）走这里。

## 中文：unicode61 + 前缀通配

FTS5 用 `unicode61` tokenizer，对中文是**按字切分**，没有词级分词。因此中文检索靠**前缀通配 `*`** 命中：

```
产品*      # 命中"产品评审 / 产品经理 / 产品线"等
```

CJK smart transform 在零语法 fast-path 下自动为纯 CJK token 加通配，调用方通常无需手动加 `*`。但显式写 `产品*` 永远有效。这是 `unicode61` 的固有限制（无 jieba 中文分词，列在「未来扩展」里）。

## 解析流程（两端一致）

1. `mode='raw'` → 直通。
2. tokenize：按空白切分，**引号内空白不切**；未闭合引号 → 该引号当普通字符 + warning。
3. 逐 token 分类：否定前缀 → 字段匹配（`^([A-Za-z_]+):(.*)$` 且字段名在注册表）→ 短语 → 文本词。
4. OR 结合，产出结构化查询 `{ fts_terms, fts_or_groups, neg_fts_terms, filters, or_filter_groups, neg_filters, warnings }`。
5. **零语法 fast-path（回归红线）**：解析结果不含字段/否定/OR 时，**走与现状完全相同**的代码路径（整串交 smart transform），保证存量查询逐字节不变。

## SQL 编译要点

- **有正向文本词**：`FROM email_body_fts JOIN email_metadata ... WHERE … MATCH :fts_expr [AND filters] [AND NOT IN neg]`，`ORDER BY bm25 ASC`（相关性）。
- **纯过滤（无正向文本词）**：`FROM email_metadata WHERE filters`，snippet 空串 / rank 0，`ORDER BY datetime(date_received) DESC`（最新优先）。
- **日期归一（修了存量 bug）**：`date_received` 存量数据时区偏移混存（`+00:00`/`-06:00`/`-07:00`），裸字典序比较边界错位最多 ~15h。一律 `datetime(m.date_received) >= datetime(:v)` 让 SQLite 解析时区归一 UTC；date-only 值按**本地时区**解释，`before:` 取次日 0 点实现"当天含"。`newer_than/older_than` 相对注入的 `now`（生产取系统值，测试由夹具注入）。

## 返回与警告

- 返回结构（`EmailSearchHit` / `SearchHit` / API items）**字段不变**。
- `SearchResult` / CLI meta / API meta 新增**可选** `parse_warnings: string[]`（additive，不破坏 wire 契约；无 warning 时省略）。
- parser **永不抛异常** —— 任何畸形输入最坏退化为文本搜索。FTS5 运行期语法错误：log warning + 返回空列表。

## 跨语言一致性：共享行为夹具

唯一真源是仓库根的 **`tests/fixtures/search_query_behavior.json`**。Python（pytest）与 TypeScript（vitest）两端**读同一份 JSON**，各自建 in-memory SQLite（`email_metadata` + contentful `email_body_fts` + `email_attachment`），灌入 emails，逐 case 跑 search 断言。

```jsonc
{
  "now": "2026-06-13T12:00:00",        // 注入的本地 now
  "tz_offset_minutes": 480,             // 注入的本地时区（北京 +08:00）
  "emails": [ { "internal_id": 1, "subject": "…", "sender": "…", "sender_name": "…",
                "to_addr": "…", "cc_addr": "…", "date_received": "…", "mailbox": "收件箱",
                "is_read": 0, "is_flagged": 0, "is_pinned": 0, "is_important": 0,
                "ai_priority": "🔴 紧急", "body_markdown": "…",
                "attachments": [{ "filename": "a.pdf", "is_inline": 0 }] } ],
  "cases": [ { "name": "field_from_basic", "query": "from:alice",
               "expect_ids": [1, 3], "order": "set",     // set=集合比对（默认）, exact=顺序比对
               "expect_warnings": 0 } ]
}
```

:::note[vitest runner 注意]
用 better-sqlite3 的 vitest 套件须走 electron-as-node runner（`npx vitest` 在新版 node worker 下会假失败）。
:::

夹具必须覆盖：每个字段至少 1 例、别名、引号值、否定（字段/文本/纯否定）、OR（同类/跨类降级）、未知字段降级文本、空值丢弃、date-only 边界（当天含）、时区混存数据的日期过滤、`newer_than` 相对日期、纯过滤排序、零语法 fast-path 行为不变、CJK smart 不回归、与结构化参数 merge。

## 如何扩展语法

改语法是有顺序的三步，**先改契约，再改实现**：

1. **改本规格文档 + 夹具**：在 `docs/reference/search/search-query-syntax.md` 写新字段语义，在 `tests/fixtures/search_query_behavior.json` 加覆盖用例（含边界 + 降级）。
2. **双端同步实现**：改 Python（`src/repository/`）和 TypeScript（`frontend/src/`）两份 parser/编译器，让两端都通过新夹具。
3. **跑双端测试**：`pytest`（Python 端）+ vitest（TS 端，electron-as-node runner）全绿才算落地。

:::caution[别只改一端]
DSL 是双端契约。只改 Python 不改 TS（反之亦然）会导致 CLI/serve-api 与前端搜索行为漂移 —— 同一 query 在桌面 app 和远程 web 出不同结果。夹具是硬闸，专门拦这类漂移。
:::

## 示例

| Query | 语义 |
|---|---|
| `from:alice 报告` | 发件人含 alice 且全文匹配"报告" |
| `from:alice OR from:bob is:unread` | (alice 或 bob 发的) 且未读 |
| `subject:"weekly report" -from:noreply` | 主题含短语且发件人不含 noreply |
| `产品评审 has:attachment newer_than:7d` | 近 7 天带附件的"产品评审"相关邮件 |
| `in:收件箱 is:flagged priority:urgent` | 收件箱中旗标且 AI 判定紧急（纯过滤，按日期倒序）|
| `redis OR timeout -is:read` | 全文 redis 或 timeout，且未读 |
| `date:2026-06-01 from:tp-link.com` | 本地时区 6 月 1 日当天、发件域含 tp-link.com |

## v1 明确不做

括号分组、跨类 OR、字段级 FTS（subject 走 LIKE）、`to:/cc:` 进 FTS 索引、jieba 中文分词、`sort:` 排序覆盖、保存搜索/搜索历史。纯过滤查询是 metadata 全表扫描（7 万行 ~30–60ms 可接受）。

---

## 深入了解

- [`docs/reference/search/search-query-syntax.md`](https://github.com/)（Python+TS 双端完整契约）
- [10 大命令组参考](/agent/commands/) §`email search`
- [JSON Schema 契约](/agent/json-schema/)（`email-search.schema.json`：hit 含 `snippet` / `rank`）
