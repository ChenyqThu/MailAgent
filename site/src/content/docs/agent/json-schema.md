---
title: "JSON Schema 契约"
description: "mailagent CLI 的 docs/cli-schema 目录、schema_version、wrapper/error/partial-failure 通用结构，以及用 jsonschema 做 CI 校验。"
---

每个 agent-facing 的 `mailagent` 命令都有一份机器可读的 JSON Schema 契约。schema 是 agent 调用 CLI 的**稳定接口**：先读 schema 知道字段形状，再写解析代码，而不是靠"看一眼输出猜结构"。

:::tip[一句话]
所有 `-o json` 输出都是同一个 wrapper：`{ status, schema_version, data | error, meta }`。`schema_version` 当前恒为 `1`，破坏性变更才 major bump。
:::

## schema 目录在哪

契约文件落在仓库的 [`docs/cli-schema/`](https://github.com/) 目录（与 CLI 源码同仓），共 **56 个文件**：1 个通用结构 `_common.schema.json` + 1 个 `error-codes.md` + 54 个命令级 `<command>.schema.json`。每个 schema 都是标准 JSON Schema（带 `$schema` / `required` / `enum` / `additionalProperties: false`），可直接喂给任意 JSON Schema 校验器。

```
docs/cli-schema/
├── _common.schema.json          # wrapper / error / meta 的 $defs（被所有命令 $ref）
├── error-codes.md               # 全部 error.code enum + exit_code + 触发场景
├── email-get.schema.json
├── email-list.schema.json
├── email-body.schema.json
├── email-search.schema.json
├── email-resync.schema.json     # 单封
├── email-resync-batch.schema.json   # 含 partial_failure 形态
├── email-flag.schema.json
├── admin-stats.schema.json
├── admin-stats-v4-rollout.schema.json
├── admin-health.schema.json
├── admin-dead-letter.schema.json
├── llm-run.schema.json
├── llm-stats.schema.json
└── …（其余 attachment / notion / backfill / init / calendar / debug / project-progress）
```

## 通用 wrapper 结构

所有 `-o json` 输出顶层永远是一个 object（不会直接吐数组），形如：

```jsonc
{
  "status": "success",           // enum: success | error | partial_failure
  "schema_version": 1,           // integer，当前恒为 1
  "data": { /* … */ },           // success / partial_failure 用 data
  "meta": { "duration_ms": 8 }   // 永远有 duration_ms，list 类还有 count/total/limit/offset
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | enum | `success` / `error` / `partial_failure` |
| `schema_version` | integer | 契约版本号，初始 `1`；breaking change 走 major bump |
| `data` | object \| array | 成功时的业务数据（`get` 类是 object，`list`/`search` 类是 array）|
| `error` | object | 失败时填，与 `data` 互斥 |
| `meta` | object | 至少含 `duration_ms`；命令特定字段（如 list 的 `total`/`limit`/`offset`）|

:::note[NDJSON 例外]
`-o ndjson`（大结果集流式）不是 wrapper：每行一个独立 JSON object，**最后一行**强制是 `{"_meta": {...}}`（含 `total` / `duration_ms` 等）。详见[全局 flag 与输出格式](/agent/output-formats/)。
:::

## error 结构

`status: "error"` 时 `error` 字段形如：

```jsonc
{
  "status": "error",
  "schema_version": 1,
  "error": {
    "code": "E_NOT_FOUND",                                  // enum，见 error-codes.md
    "message": "Email with internal_id=99999 not found",    // 人类可读
    "hint": "Use 'mailagent email list' to find available IDs",  // 可选，下一步提示
    "context": { "internal_id": 99999 }                     // 可选，结构化字段供 agent 解析
  },
  "meta": { "duration_ms": 5 }
}
```

`error.code` 的 enum 集中维护在 `docs/cli-schema/error-codes.md`，与 `exit_code` 一一对应：

| code | exit_code | 含义 |
|---|---|---|
| `E_NOT_FOUND` | 1 | 资源不存在 |
| `E_INVALID_ARG` | 2 | 参数非法 / 互斥 / 范围超出 |
| `E_AUTH_FAILED` | 4 | 写命令缺 API key 或 token 不匹配 |
| `E_SCHEMA_MISMATCH` | 5 | DB schema 不一致 / `db_version != expected` |
| `E_PARTIAL_FAILURE` | 6 | batch 命令部分成功部分失败 |
| `E_ABORTED` | 7 | SIGINT/SIGTERM 主动退出（长任务第一次 Ctrl-C）|
| `E_MAX_FAILURES` | 8 | 长任务连续失败超 `--max-failures` 熔断 |
| `E_PM2_RUNNING` | 9 | PM2 `mail-sync` 在跑，写命令拒绝 |
| `E_LLM_FAILED` | 1 | LLM gateway 调用失败 / 模型链耗尽 / Notion 写失败 |
| `E_INTERNAL` | 1 | 兜底，未匹配上述任何 code 的内部异常 |
| `E_NOT_IMPLEMENTED` | 2 | 命令存在但当前为 stub |

完整退出码语义见[退出码契约](/agent/exit-codes/)。

## partial-failure 结构（batch 命令）

`email resync --range` / `backfill body` / `init` 等长任务部分成功时返回 `partial_failure`：

```jsonc
{
  "status": "partial_failure",
  "schema_version": 1,
  "data": {
    "succeeded": [ /* … */ ],
    "failed": [
      { "internal_id": 53675, "error": { "code": "E_LLM_FAILED", "message": "…" } }
    ],
    "summary": { "total": 100, "succeeded": 87, "failed": 13, "aborted_by": null }
  },
  "meta": { "duration_ms": 145320 }
}
```

退出码为 `6`（`E_PARTIAL_FAILURE`），脚本据此分流"全成功 / 部分成功 / 全失败"。

## 关键设计约定（写解析器前必读）

1. **数字字段恒为整数，不拼字符串**。`llm run` 的 token 用量拆成独立的 integer key（`input_tokens` / `output_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens`），不会出现 `"4521/342"` 这种拼接串。
2. **带 emoji/中文 display 的值给 `_key` + `_label` 双字段**。如优先级同时给 `priority_key: "important"`（machine enum）和 `priority_label: "🟡 重要"`（display）。agent 永远读 `_key` 分支，不要 parse `_label`。
3. **时间统一 ISO 8601 含时区**：`"2026-05-15T10:23:45+08:00"`，不再用纯日期或 epoch（个别内部 `fetched_at` 仍是 epoch float，schema 里标了类型）。
4. **`additionalProperties` 行为**：wrapper 顶层与 error 结构是封闭的（`additionalProperties: false`）；`data` 内部按各命令 schema 定义。

## schema-to-command 速查目录

| schema 文件 | 对应命令 | 形态 |
|---|---|---|
| `email-get.schema.json` | `email get` | object（含可选 `body`/`attachments`）|
| `email-list.schema.json` | `email list` | array + meta `total/limit/offset` |
| `email-body.schema.json` | `email body` | object `{format, content, size_bytes}` |
| `email-search.schema.json` | `email search` | array（hit 含 `snippet`/`rank`）|
| `email-resync.schema.json` | `email resync <id>` | object `{action, attachments_uploaded, …}` |
| `email-resync-batch.schema.json` | `email resync --range/--ids` | partial_failure 形态 |
| `email-flag.schema.json` | `email flag` | object（outbox intent 落库结果）|
| `attachment-list.schema.json` | `attachment list` | array |
| `attachment-download.schema.json` | `attachment download --dest` | object 元信息（二进制下载本体不进 JSON）|
| `llm-run.schema.json` | `llm run` | object `{labels, usage, writer_summary}` |
| `llm-stats.schema.json` | `llm stats` | object（status 分布 + cost + cache hit）|
| `llm-selftest.schema.json` | `llm selftest` | object `{healthy, …}` |
| `admin-stats.schema.json` | `admin stats` | object（多 section，各带 `_source`）|
| `admin-stats-v4-rollout.schema.json` | `admin stats`（v4 section）| object（含 `_snapshot_at`/`_warn_if_stale_sec`）|
| `admin-health.schema.json` | `admin health` | object `{healthy, checks[]}` |
| `admin-db-version.schema.json` | `admin db-version` | object `{db_version, expected, compatible}` |
| `admin-dead-letter.schema.json` | `admin dead-letter list/retry` | array / object |
| `notion-page-orphans.schema.json` | `notion page-orphans` | array |
| `notion-file-link-audit.schema.json` | `notion file-link-audit` | array / object |
| `backfill-body.schema.json` | `backfill body` | partial_failure 形态 |
| `init-*.schema.json`（7 个）| `init {fetch-cache,analyze,fix-properties,fix-critical,update-parents,sync-new,all}` | object |
| `calendar-recurring-*.schema.json` | `calendar recurring {discover,replay}` | array / object |
| `debug-*.schema.json`（5 个）| `debug {email-source,mail-structure,inline-images,applescript-fetch,notion-page}` | object |
| `project-progress-sync.schema.json` | `project-progress sync` | object |

（完整命令明细见 [10 大命令组参考](/agent/commands/)。）

## CI 校验：用 jsonschema 把输出钉在契约上

把 CLI 输出和契约绑死，最简单的方式是在 CI 里跑 `jsonschema`（`pip install -e ".[dev]"` 已带 `jsonschema>=4.18` + `referencing`）。schema 之间用 `$ref` 指向 `_common.schema.json`，因此校验时要把整个 `docs/cli-schema/` 目录作为 registry 加载。

命令行快速校验单条输出：

```bash
# 把一次真实调用的输出存下来，对照契约校验
mailagent -o json email get 53675 > /tmp/out.json
jsonschema --instance /tmp/out.json docs/cli-schema/email-get.schema.json
# 退出码 0 = 符合契约；非 0 = 字段漂移，CI 红
```

带 `$ref` 解析的 Python 校验脚本（CI 用）：

```python
# scripts/dev/validate_cli_schema.py（示意）
import json, subprocess, pathlib
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

SCHEMA_DIR = pathlib.Path("docs/cli-schema")

# 把目录里所有 schema 注册进 registry，让 $ref 能解析到 _common.schema.json
registry = Registry().with_resources(
    (p.name, Resource.from_contents(json.loads(p.read_text())))
    for p in SCHEMA_DIR.glob("*.schema.json")
)

def check(cmd: list[str], schema_file: str) -> None:
    out = subprocess.run(
        ["mailagent", "-o", "json", *cmd],
        capture_output=True, text=True, check=True,
    ).stdout
    schema = json.loads((SCHEMA_DIR / schema_file).read_text())
    validator = Draft202012Validator(schema, registry=registry)
    validator.validate(json.loads(out))   # 不符合即抛 ValidationError

# 用一个 seed 库（非生产库）跑代表性命令
check(["email", "get", "1"], "email-get.schema.json")
check(["admin", "health"], "admin-health.schema.json")
check(["email", "search", "test"], "email-search.schema.json")
```

:::caution[校验跑在 seed 库上]
CI 校验应指向一个 `--db-path` 临时 seed 库（带几封测试邮件），不要碰生产 `data/sync_store.db`。`email get 1` 这类调用需要库里有对应行才能产出 `success` 形态。
:::

## 何时 schema 会变

- **加字段**：additive，`schema_version` 不变（agent 应对未知新字段宽容）。
- **删字段 / 改字段类型 / 改 enum 取值**：breaking，必须 bump `schema_version`，同步更新 `docs/cli-schema/<command>.schema.json` + `error-codes.md` + `src/cli/exceptions.py`。
- 新增命令：新落一个 `<command>.schema.json` + 在 `error-codes.md` 追加可能的 `E_*`。

---

## 深入了解

- [`docs/reference/cli/agent-cli-rfc.md`](https://github.com/) §7（JSON Schema 标准 + `docs/cli-schema/` placeholder 清单）
- [`docs/reference/cli/cli-reference.md`](https://github.com/) §JSON Schema 契约
- 同站：[全局 flag 与输出格式](/agent/output-formats/) · [退出码契约](/agent/exit-codes/) · [10 大命令组参考](/agent/commands/)
