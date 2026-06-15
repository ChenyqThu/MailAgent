---
title: 全文搜索
description: 用 ⌘K 命令面板搜邮件——正文加附件文本的全文检索、Gmail 风格字段过滤（from / subject / mailbox / is / has / 日期）、AND/OR/NOT 逻辑、中文搜索与命中高亮。
---

MailAgent 把每封邮件的**正文**和**附件里的文字**（PDF / Word / PPT / Excel 都会被抽取出来）一起建进全文索引。所以你搜的不只是主题和发件人——一份藏在 PDF 附件里的某个词，也能被搜到。中文同样支持。

## 怎么开始搜

最快的入口是命令面板：按 `⌘K`，输入关键词回车即可。命中的邮件会列出来，正文里匹配到的片段会**高亮**显示，让你一眼看到相关上下文。

简单搜索就这么直接：

```
redis timeout
```

这会找出正文 / 主题 / 发件人里同时包含"redis"和"timeout"的邮件（多个词默认是"都要满足"的关系）。

## Gmail 风格的字段过滤

需要更精确时，可以像 Gmail 那样用 `字段:值` 缩小范围。下面是常用字段：

| 写法 | 含义 | 例子 |
|---|---|---|
| `from:` | 发件人（地址或名字） | `from:alice` |
| `to:` / `cc:` | 收件人 / 抄送 | `to:bob` |
| `subject:` | 主题包含 | `subject:周报` |
| `mailbox:` / `in:` | 限定邮箱 | `in:收件箱` |
| `is:` | 状态 | `is:unread`、`is:flagged`、`is:read` |
| `has:attachment` | 带附件 | `has:attachment` |
| `priority:` | AI 优先级 | `priority:urgent`、`priority:重要` |
| `after:` / `before:` | 日期范围 | `after:2026-06-01` |
| `date:` | 某一天 | `date:2026-06-01` |
| `newer_than:` / `older_than:` | 相对时间 | `newer_than:7d`（近 7 天） |

几点实用规则：

- 字段名**不区分大小写**（`From:` 等于 `from:`）。
- 值里有空格就加引号：`from:"Zhang San"`、`subject:"weekly report"`。
- 多个条件并排写就是"都要满足"：`from:alice subject:周报 is:unread`。
- `mailbox:` 支持英文别名：`inbox`→收件箱、`sent`→发件箱、`archive`→存档、`drafts`→草稿箱。

## 否定与"或者"

- 在字段或词前加 `-` 表示**排除**：`-from:noreply`、`-报告`、`-is:read`。
- 用大写的 `OR`（必须大写）表示"或者"：`from:alice OR from:bob`。

## 组合起来用

把上面的拼在一起，就能表达相当精确的查询：

```
from:alice subject:周报 is:unread after:2026-06-01 has:attachment -from:noreply 产品评审
```

意思是：6 月 1 日之后、未读、带附件、发件人含 alice 但不含 noreply、主题含"周报"、且全文相关"产品评审"的邮件。

更多例子：

| 查询 | 它在找什么 |
|---|---|
| `from:alice 报告` | alice 发来的、全文含"报告" |
| `subject:"weekly report" -from:noreply` | 主题含该短语、发件人不含 noreply |
| `产品评审 has:attachment newer_than:7d` | 近 7 天带附件、相关"产品评审" |
| `in:收件箱 is:flagged priority:urgent` | 收件箱里标了旗、AI 判定紧急的 |
| `redis OR timeout -is:read` | 全文含 redis 或 timeout，且未读 |

## 中文搜索

中文邮件可以直接搜中文词，命中后同样会高亮。日期用本地时区理解——`after:2026-06-01` 指你所在时区的 6 月 1 日 0 点起，`before:2026-06-01` 会**包含**当天全天。

:::tip[搜不到东西？]
- 附件里的文字需要先被抽取才能搜到。历史邮件的附件文本是逐步补齐的，刚同步完不久可能还没全部入索引。
- 输入畸形或不认识的字段不会报错——它会被宽容地当成普通关键词处理，最多搜不到结果，不会让整个搜索失败。
:::

## 接下来

- 想就搜到的邮件继续追问、让 AI 跨邮件帮你梳理？看 **[AI Chat 面板](/101/ai-chat/)**。
- 命令面板还能切邮箱、跳路由，配合快捷键见 **[日常工作流：收件箱](/101/daily-inbox/)**。

---

> 深入了解（含完整 DSL 语法、日期归一、跨语言契约）：[搜索查询语法规格](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/search/search-query-syntax.md)
