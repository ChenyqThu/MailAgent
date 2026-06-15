---
title: "TL;DR and Design Principles"
description: "The mailagent CLI is the single-entry, resource-first, agent-friendly command-line interface to the MailAgent backend. This page explains what it is, its seven design principles, and an end-to-end automation quickstart script."
---

`mailagent` is the **single-entry command-line tool** for the MailAgent backend, purpose-built for CLI / automation scripts / AI agent invocation. It consolidates the core capabilities scattered across `scripts/*.py` (email CRUD, full-text search, LLM classification, Notion re-push, health checks, and so on) into a `<noun> <verb> [<id>] [flags]` command tree, styled after `gh` / `kubectl` / `aws-cli`.

:::tip[In one sentence]
Your scripts / agents only ever talk to a single binary: `mailagent`. Every command can emit a **stable schema** via `-o json`, where each field has well-defined semantics and can be consumed directly with `jq`.
:::

## TL;DR

- **Entry point**: after `pip install -e ".[cli,dev]"`, the global `mailagent` command is available.
- **Resource-action model**: `mailagent email get 53675`, `mailagent admin health`, `mailagent llm run 53675 --dry-run`.
- **10 command groups**: `email` / `attachment` / `llm` / `backfill` / `notion` / `admin` / `init` / `calendar` / `debug` / `project-progress`.
- **Stable JSON contract**: `-o json` always returns the wrapper object `{status, schema_version, data|error, meta}` (see [Output Formats](/en/agent/output-formats/)).
- **Exit-code system**: `0 / 1 / 2 / 4 / 5 / 6 / 7 / 8 / 9 / 130`, so every kind of outcome can be decided programmatically (see [Exit-Code Contract](/agent/exit-codes/)).
- **Read/write privilege separation**: read commands require no auth; write commands require `MAILAGENT_CLI_API_KEY` (see [Authentication Contract](/agent/auth/)).
- **Long tasks are interruptible and resumable**: PM2 conflict detection, SIGINT circuit-breaker, `--max-failures`, checkpoint resume (see [Long-Task Contract](/agent/long-tasks/)).

## Seven Design Principles

Ordered by importance. Understanding these principles helps you predict the CLI's behavior in edge cases.

1. **Agent-first**: every command emits a **stable schema** via `-o json`, with fixed per-field semantics. stderr carries only 1 line of timing/counts (suppressed by `--quiet`); stdout is pure JSON, directly consumable by `jq`.
2. **Resource-action consistency**: `<noun> <verb> [<id>] [flags]` always holds. Resource names are singular (`email`, not `emails`); action names are bare verbs (`get` / `list` / `search`). Tab-completion friendly, enumerable by agents.
3. **The existing Python API is ground truth**: the CLI is a wrapper, not a reimplementation of business logic — it only does "parse arguments → call API → format output." The CLI's behavior always follows the same `EmailRepository` / `NotionSync` as the server side (`main.py` / the `mail-sync` process); there is no second implementation.
4. **Observable**: by default every command prints a 1-line execution summary to stderr (duration, row counts, etc.) so agents can inspect what happened; `meta.duration_ms` also goes into the JSON wrapper.
5. **Interruptible**: long tasks support `--max-failures` circuit-breaking + `--progress-every` progress reporting + graceful SIGINT exit + checkpoint resume.
6. **Configuration consistency**: by default it reads `.env` (same as the service); `--db-path` / `--api-key` / `--config` override it; `MAILAGENT_*` environment variables take precedence. Configuration goes through an explicit factory (`load_cli_config`) and does not depend on an import-time singleton.
7. **Non-breaking coexistence**: during the transition where the CLI and `scripts/*` coexist, the old paths do not become unavailable immediately (the shipped PR-5 / PR-6 completed the migration cutover, and the old `python scripts/<wrapper>.py` usage is now deprecated, unified under `mailagent <group> <action>`).

## How the 10 Command Groups Relate

| Group | Responsibility | Mostly Read/Write |
|---|---|---|
| `email` | Email CRUD + search + re-push + flag + drafts | Read + Write |
| `attachment` | Attachment list / download / derive / cleanup | Read + Write |
| `llm` | LLM classification to fill AI fields + selftest + stats + path comparison | Read + Write |
| `backfill` | Historical body / derived-attachment backfill | Write (long task) |
| `notion` | Direct Notion operations (update-flag / orphan / archive / create-task) | Write |
| `admin` | Stats / health / db-version / dead letters / cleanup / repair | Read + Write |
| `init` | 7 sub-actions to initialize sync | Write (long task) |
| `calendar` | Recurring-meeting expansion / discover / replay | Read + Write |
| `debug` | raw MIME / mail-structure / inline-images / notion-page | Read |
| `project-progress` | Project weekly-report sync add-on (xlsx → Notion) | Write |

For the full list of actions + flags + `jq` examples, see [Reference for the 10 Command Groups](/agent/commands/).

## Version and Installation Check

```bash
which mailagent        # should be <project>/venv/bin/mailagent
mailagent --version    # prints the version number and exits
mailagent --help       # lists the 10 groups + global flags
```

:::caution[PATH note]
After `pip install -e .`, `mailagent` lives in `venv/bin/`. If your shell PATH does not include venv, use the absolute path `./venv/bin/mailagent` directly, or `source venv/bin/activate` first. In CI / cron, always use the absolute path to avoid depending on an interactive shell's PATH.
:::

## End-to-End Automation Quickstart

The script below demonstrates a **complete read + write loop**: health check → search → read one body → change one flag, with exit-code handling at every step. It is the canonical opening move for writing automation; adapt it for your own use.

```bash
#!/usr/bin/env bash
set -uo pipefail   # Note: do NOT set -e — we want to handle exit codes ourselves

MA="./venv/bin/mailagent"     # use the absolute path, don't rely on PATH
export MAILAGENT_CLI_API_KEY="${MAILAGENT_CLI_API_KEY:?need API key for writes}"

# 1) Health check — admin health exit 0 = healthy, 1 = unhealthy
if ! "$MA" -o json admin health | jq -e '.data.healthy == true' >/dev/null; then
  echo "backend unhealthy, abort" >&2
  exit 1
fi

# 2) Search — FTS5 full-text; take the internal_id of the first hit
ID=$("$MA" -o json email search "redis timeout" --mailbox 收件箱 --limit 1 \
       | jq -r '.data[0].internal_id // empty')
if [ -z "$ID" ]; then
  echo "no match, nothing to do" >&2
  exit 0
fi
echo "matched internal_id=$ID" >&2

# 3) Read one body (markdown) and save it for later LLM / human use
"$MA" -o json email body "$ID" --format markdown \
  | jq -r '.data.content' > "/tmp/body-$ID.md"

# 4) Write: mark this email as read + flagged (write command, needs API key)
"$MA" -o json email flag "$ID" --is-read --is-flagged
rc=$?
case "$rc" in
  0) echo "flag updated for $ID" >&2 ;;
  4) echo "auth failed — check MAILAGENT_CLI_API_KEY" >&2; exit 4 ;;
  9) echo "pm2 mail-sync running; retry later or pass --allow-concurrent" >&2; exit 9 ;;
  *) echo "flag failed rc=$rc" >&2; exit "$rc" ;;
esac
```

Note the `--mailbox 收件箱` value above: `收件箱` is the Chinese for "Inbox" and must be passed verbatim as that Chinese string — it is the actual mailbox name the backend matches on.

Key points:

- **Do not `set -e`**: many commands' nonzero exit codes (`6` partial_failure / `9` pm2 conflict) are "business results" you want to branch on yourself; `set -e` would kill the script at the first nonzero status.
- **Always use `jq -e` for boolean checks**: `jq -e` exits nonzero when the result is `false` / `null`, which pairs naturally with `if !`.
- **Exit codes are part of the contract**: handling 4 / 6 / 7 / 8 / 9 with `case "$rc"` branches is the standard posture for agent automation — see [Exit-Code Contract](/agent/exit-codes/).

## EWS Shutdown Migration Warning

If your automation touches the email **fetch / send / calendar** path: the MailAgent production primary path runs **DavMail 6.7**, which bridges Exchange via **EWS**, and **EWS will be shut down on 2026-10-01**. At that point a migration to the Graph API path is required. See [`docs/reference/architecture/roadmap-post-cutover.md` §5.1](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/architecture/roadmap-post-cutover.md). The AppleScript fallback path is always available and is unaffected by EWS.

## Learn More

- [Automation Environment Install and Configuration](/en/agent/setup/) — venv / config precedence chain / API key
- [Global Flags and Output Formats](/en/agent/output-formats/) — JSON wrapper / NDJSON / field conventions
- [Exit-Code Contract](/agent/exit-codes/) — full 0–130 table + programmatic decisions
- [Reference for the 10 Command Groups](/agent/commands/) — per-group synopsis + jq examples
- Full design RFC: [`docs/reference/cli/agent-cli-rfc.md`](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/cli/agent-cli-rfc.md)
