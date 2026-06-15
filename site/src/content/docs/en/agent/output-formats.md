---
title: "Global Flags and Output Formats"
description: "mailagent's global flags (placed before the subcommand), the JSON wrapper contract (status/schema_version/data|error/meta), the error structure, the NDJSON trailing _meta line, the label+key dual fields, and numeric fields always being integers."
---

This page is the **output contract** for agents calling `mailagent` — any automation should read this page before parsing CLI output.

## Global Flags Go Before the Subcommand

Global flags must be placed **before** `<resource> <action>`:

```bash
mailagent -o json email get 53675        # ✅ -o before email
mailagent email get 53675 -o json        # ⚠️ also works (each leaf also exposes -o), but prefer placing it first
```

| Flag | Values | Notes |
|---|---|---|
| `-o`, `--output` | `text` / `json` / `yaml` / `ndjson` | Output format, default `text` |
| `-q`, `--quiet` | — | Suppress the stderr execution summary |
| `-v`, `--verbose` | — | DEBUG-level logs to stderr |
| `--db-path PATH` | — | Override the `sync_store.db` path |
| `--api-key TOKEN` | — | Override `MAILAGENT_CLI_API_KEY` (write commands) |
| `--config PATH` | — | Override the config file path |
| `--no-color` | — | Force no color (recommended default for agents) |
| `--version` | — | Print the version and exit |
| `-h`, `--help` | — | Command help |

:::tip[Default agent posture]
`mailagent -o json --no-color <resource> <action>`. `-o json` gives you a stable schema; `--no-color` prevents ANSI escapes from polluting parsing. The stderr execution summary doesn't affect the pure JSON on stdout, but if you want full silence add `-q`.
:::

## JSON Wrapper Contract

`-o json` **always** returns a wrapper object (no longer defaulting to NDJSON as in the early design), aligned with the `-o json` behavior of `aws-cli` / `kubectl` / `gh`. There are three top-level shapes:

### success

```json
{
  "status": "success",
  "schema_version": 1,
  "data": { },
  "meta": { "duration_ms": 8 }
}
```

- `status`: enum `"success" | "error" | "partial_failure"`.
- `schema_version`: integer, currently `1`; breaking changes get a major bump. **Assert it is the version you expect before parsing.**
- `data`: the success payload. `get` / `body`-type commands return an object; `list` / `search`-type commands return an array.
- `meta`: contains at least `duration_ms` (integer milliseconds); list-type commands also have `count` / `total` / `limit` / `offset`, and search-type commands have `total_hits` / `query`.

### error

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

`error` and `data` are **mutually exclusive**: when `status` is `error`, there is only `error`, no `data`. The error structure:

| Field | Required | Notes |
|---|---|---|
| `error.code` | Yes | Machine-readable enum (`E_*`), maintained centrally in `error-codes.md`; for the corresponding exit codes see [Exit-Code Contract](/agent/exit-codes/) |
| `error.message` | Yes | Human-readable |
| `error.hint` | No | Next-step hint |
| `error.context` | No | Structured fields for agents to parse |

```bash
# Always check status first, then read data / error
out=$(mailagent -o json email get 53675)
if [ "$(jq -r '.status' <<<"$out")" = "error" ]; then
  echo "code=$(jq -r '.error.code' <<<"$out") msg=$(jq -r '.error.message' <<<"$out")" >&2
fi
```

### partial_failure (batch partially succeeded)

When a batch command (e.g. `email resync --range`) partially succeeds and partially fails:

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

`partial_failure` corresponds to exit code `6`. `summary.aborted_by` records the reason when aborted by SIGINT / max-failures (otherwise `null`). See [Long-Task Contract](/agent/long-tasks/).

## NDJSON Stream (Large Result Sets)

For large result sets like `email list` / `email search` / batch `resync`, use `-o ndjson` (or `--stream`) for newline-delimited JSON, which lets you process as you read:

```text
{"internal_id": 53675, "subject": "...", "sender": "...", "date_received": "...", "mailbox": "...", ...}
{"internal_id": 53676, ...}
{"_meta": {"total": 1543, "limit": 50, "offset": 0, "duration_ms": 87}}
```

NDJSON rules:

- Each line is an independent JSON object, processable in a stream with `jq -c .`.
- **The last line is always `{"_meta": {...}}`**, containing `total` / `duration_ms` / a batch's `failed` count, etc. Reading `_meta` means the stream has ended.
- Errors are also a single line (containing `error.code` / `error.message`) and **do not interrupt the stream**.
- A batch command's partial failure is reflected in the trailing line's `_meta.failed=N`.

```bash
# Streaming: skip the _meta line and process each email
mailagent -o ndjson email list --mailbox 收件箱 --limit 1000 \
  | jq -c 'select(._meta | not) | {id: .internal_id, subj: .subject}'

# Get just the _meta summary from the trailing line
mailagent -o ndjson email search "产品*" | tail -n1 | jq '._meta'
```

The `--mailbox 收件箱` value is the Chinese for "Inbox" and must be passed verbatim as that Chinese string; likewise `"产品*"` is a Chinese search term ("product*") shown here as an example query.

## Field Conventions (Agent Must-Knows)

The CLI's JSON fields are deliberately designed for machine consumption. The following three conventions run through every command:

### 1. label + key Dual Fields

For any value that contains emoji / Chinese / a display form, a machine-readable `_key` and a display `_label` are given **at the same time**. For example, the priority from `llm run`:

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

**Always use `_key`** for logic branching (`priority_key == "critical"`); `_label` is for display only. (Above, `priority_label` "🟡 重要" is Chinese for "Important," and `category_label` "项目沟通" is Chinese for "project communication.") The `priority_key` enum: `critical | urgent | important | normal | low`.

### 2. Numeric Fields Are Always Integers, Each Its Own Key

No string concatenation (there is no `"tokens": "4521/342"` form). Token usage is split into independent integer fields:

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

Counts / sizes / milliseconds are always integers; you can do arithmetic on them directly without parsing strings.

### 3. Times Unified as ISO 8601 (timezone-bearing preferred)

Time fields are ISO 8601 with timezone where possible (`"2026-05-15T10:23:45+08:00"`); legacy data may degrade to `YYYY-MM-DD HH:MM:SS` or `null` (the schema annotates this as `iso_datetime_or_date`, nullable). When parsing, handle the "nullable + two formats" fallback.

## JSON Schema Contract Files

Every agent-facing command has a JSON Schema under [`docs/cli-schema/`](https://github.com/ChenyqThu/MailAgent/tree/main/docs/cli-schema) (45+ `.schema.json` files + `_common.schema.json` + `error-codes.md`). The common structure of wrapper / error / meta is defined in the `$defs` of `_common.schema.json`. You can pull these schemas down and run contract validation in CI:

```bash
# Validate that one CLI output conforms to the contract using jsonschema
mailagent -o json email get 53675 > /tmp/out.json
python -m jsonschema --instance /tmp/out.json docs/cli-schema/email-get.schema.json
```

## Learn More

- [Exit-Code Contract](/agent/exit-codes/) — `error.code` ↔ exit-code mapping
- [Write-Command Authentication Contract](/agent/auth/) — `--dry-run` skipping auth, list of read/write commands
- [Long-Task Contract](/agent/long-tasks/) — partial_failure / NDJSON trailing `_meta.failed`
- Schema spec: [`agent-cli-rfc.md` §5.1 / §5.5 / §7](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/cli/agent-cli-rfc.md)
