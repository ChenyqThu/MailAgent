---
title: "全局 flag 与输出格式"
description: "mailagent 的全局 flag（写在子命令前）、JSON wrapper 契约（status/schema_version/data|error/meta）、错误结构、NDJSON 末行 _meta、label+key 双字段、数字字段恒为整数。"
---

本页是 agent 调用 `mailagent` 的**输出契约**——任何自动化解析 CLI 输出前都该先读这一页。

## 全局 flag 写在子命令之前

全局 flag 必须放在 `<resource> <action>` **之前**：

```bash
mailagent -o json email get 53675        # ✅ -o 在 email 之前
mailagent email get 53675 -o json        # ⚠️ 也能用（每个 leaf 也暴露 -o），但首选前置
```

| flag | 取值 | 说明 |
|---|---|---|
| `-o`, `--output` | `text` / `json` / `yaml` / `ndjson` | 输出格式，默认 `text` |
| `-q`, `--quiet` | — | 抑制 stderr 执行摘要 |
| `-v`, `--verbose` | — | DEBUG 级日志到 stderr |
| `--db-path PATH` | — | 覆盖 `sync_store.db` 路径 |
| `--api-key TOKEN` | — | 覆盖 `MAILAGENT_CLI_API_KEY`（写命令） |
| `--config PATH` | — | 覆盖配置文件路径 |
| `--no-color` | — | 强制无色（agent 建议默认无色） |
| `--version` | — | 打印版本退出 |
| `-h`, `--help` | — | 命令帮助 |

:::tip[agent 默认姿势]
`mailagent -o json --no-color <resource> <action>`。`-o json` 给你稳定 schema；`--no-color` 防 ANSI 转义污染解析。stderr 的执行摘要不影响 stdout 的纯 JSON，但若你要彻底安静可加 `-q`。
:::

## JSON wrapper 契约

`-o json` **始终**返回一个 wrapper object（不再像早期设计那样默认 NDJSON），与 `aws-cli` / `kubectl` / `gh` 的 `-o json` 行为对齐。三种顶层形态：

### success（成功）

```json
{
  "status": "success",
  "schema_version": 1,
  "data": { },
  "meta": { "duration_ms": 8 }
}
```

- `status`：枚举 `"success" | "error" | "partial_failure"`。
- `schema_version`：整数，当前 `1`；breaking change 走 major bump。**解析前先断言它是你预期的版本。**
- `data`：成功载荷。`get` / `body` 类是 object，`list` / `search` 类是 array。
- `meta`：至少含 `duration_ms`（整数毫秒）；list 类还有 `count` / `total` / `limit` / `offset`，search 类有 `total_hits` / `query`。

### error（失败）

```json
{
  "status": "error",
  "schema_version": 1,
  "error": {
    "code": "E_NOT_FOUND",
    "message": "Email with internal_id=99999 not found",
    "hint": "Use 'mailagent email list' to find available IDs"
  },
  "meta": { "duration_ms": 5 }
}
```

`error` 与 `data` **互斥**：`status` 为 `error` 时只有 `error`，没有 `data`。错误结构：

| 字段 | 必有 | 说明 |
|---|---|---|
| `error.code` | 是 | machine-readable enum（`E_*`），集中维护于 `error-codes.md`，对应退出码见 [退出码契约](/agent/exit-codes/) |
| `error.message` | 是 | 人类可读 |
| `error.hint` | 否 | next-step 提示 |
| `error.context` | 否 | 结构化字段供 agent 解析 |

```bash
# 永远先判 status，再取 data / error
out=$(mailagent -o json email get 53675)
if [ "$(jq -r '.status' <<<"$out")" = "error" ]; then
  echo "code=$(jq -r '.error.code' <<<"$out") msg=$(jq -r '.error.message' <<<"$out")" >&2
fi
```

### partial_failure（batch 部分成功）

batch 命令（如 `email resync --range`）部分成功部分失败时：

```json
{
  "status": "partial_failure",
  "schema_version": 1,
  "data": {
    "succeeded": [ ],
    "failed": [
      { "internal_id": 53675, "error": { "code": "E_LLM_FAILED", "message": "..." } }
    ],
    "summary": { "total": 100, "succeeded": 87, "failed": 13, "aborted_by": null }
  },
  "meta": { "duration_ms": 145320 }
}
```

`partial_failure` 对应退出码 `6`。`summary.aborted_by` 在被 SIGINT / max-failures 中止时记录原因（否则 `null`）。详见 [长任务契约](/agent/long-tasks/)。

## NDJSON 流（大结果集）

对 `email list` / `email search` / batch `resync` 这类大结果集，用 `-o ndjson`（或 `--stream`）走 newline-delimited JSON，便于边读边处理：

```text
{"internal_id": 53675, "subject": "...", "sender": "...", "date_received": "...", "mailbox": "...", ...}
{"internal_id": 53676, ...}
{"_meta": {"total": 1543, "limit": 50, "offset": 0, "duration_ms": 87}}
```

NDJSON 规则：

- 每行一个独立 JSON object，可 `jq -c .` 流式处理。
- **最后一行强制是 `{"_meta": {...}}`**，含 `total` / `duration_ms` / batch 的 `failed` 计数等。读到 `_meta` 即流结束。
- 错误也是一行（含 `error.code` / `error.message`），**不中断流**。
- batch 命令的 partial-failure 体现在末行 `_meta.failed=N`。

```bash
# 流式：跳过 _meta 行，逐封处理
mailagent -o ndjson email list --mailbox 收件箱 --limit 1000 \
  | jq -c 'select(._meta | not) | {id: .internal_id, subj: .subject}'

# 单独取末行的 _meta 汇总
mailagent -o ndjson email search "产品*" | tail -n1 | jq '._meta'
```

## 字段约定（agent 必知）

CLI 的 JSON 字段刻意为机器消费而设计，下面三条约定贯穿所有命令：

### 1. label + key 双字段

凡是含 emoji / 中文 / display 形态的值，**同时**给 machine-readable 的 `_key` 和 display 的 `_label`。例如 `llm run` 的优先级：

```json
{
  "labels": {
    "priority_key":  "important",
    "priority_label": "🟡 重要",
    "category_key":  "project_communication",
    "category_label": "项目沟通"
  }
}
```

**解析时永远用 `_key`** 做逻辑分支（`priority_key == "critical"`），`_label` 只用于展示。`priority_key` 枚举：`critical | urgent | important | normal | low`。

### 2. 数字字段恒为整数，且单独成 key

不做字符串拼接（不会有 `"tokens": "4521/342"` 这种）。token 用量拆成独立整数字段：

```json
{
  "usage": {
    "input_tokens": 4521,
    "output_tokens": 342,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 4321,
    "latency_ms": 2341
  }
}
```

计数 / 大小 / 毫秒一律 integer，可直接做算术，不必再 parse 字符串。

### 3. 时间统一 ISO 8601（含时区优先）

时间字段尽量是 ISO 8601 含时区（`"2026-05-15T10:23:45+08:00"`）；存量数据可能退化为 `YYYY-MM-DD HH:MM:SS` 或 `null`（schema 标注为 `iso_datetime_or_date`，可空）。解析时按"可空 + 两种格式"兜底。

## JSON Schema 契约文件

每个 agent-facing 命令都有一份 JSON Schema 落在 [`docs/cli-schema/`](https://github.com/ChenyqThu/MailAgent/tree/main/docs/cli-schema)（45+ 个 `.schema.json` + `_common.schema.json` + `error-codes.md`）。wrapper / error / meta 的通用结构定义在 `_common.schema.json` 的 `$defs`。你可以把这些 schema 拉下来在 CI 里做契约校验：

```bash
# 用 jsonschema 校验一条 CLI 输出符合契约
mailagent -o json email get 53675 > /tmp/out.json
python -m jsonschema --instance /tmp/out.json docs/cli-schema/email-get.schema.json
```

## 深入了解

- [退出码契约](/agent/exit-codes/) — `error.code` ↔ 退出码映射
- [写命令鉴权契约](/agent/auth/) — `--dry-run` 跳过鉴权、读/写命令清单
- [长任务契约](/agent/long-tasks/) — partial_failure / NDJSON 末行 `_meta.failed`
- schema spec：[`agent-cli-rfc.md` §5.1 / §5.5 / §7](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/cli/agent-cli-rfc.md)
