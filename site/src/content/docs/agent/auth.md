---
title: "写命令鉴权契约"
description: "mailagent 的读/写命令分权：读命令免鉴权，写命令需 MAILAGENT_CLI_API_KEY；--api-key vs 环境变量；--yes/--confirm；--dry-run 跳过鉴权；ALLOW_UNAUTH_WRITES 的 dev-only 风险与 agent 安全须知。"
---

`mailagent` 用一条简单规则保护写操作：**读命令免鉴权，写命令需 API key**。本页是这条规则的完整契约与 agent 安全须知。

## 读命令 vs 写命令

### 读命令（免鉴权）

本机访问 SQLite，无需 token：

```
email get / list / body / search
attachment list / download
admin stats / health / db-version / dead-letter list
llm selftest / stats
calendar recurring discover
debug *   (email-source / mail-structure / inline-images / applescript-fetch / notion-page)
notion page-orphans (--dry-run) / file-link-audit (--dry-run)
```

### 写命令（需鉴权）

会改 SQLite / Notion / Mail.app 的命令，必须提供 `MAILAGENT_CLI_API_KEY`：

```
email resync / delete / flag / draft
attachment derive / cleanup-orphans
llm run / retry-failed / compare-paths (--no-dry-run)
backfill body / derivatives
notion resync / update-flag / create-task / archive
        file-link-audit (--no-dry-run) / page-orphans (--archive-... / --insert-...)
admin dead-letter retry / cleanup-* / repair-parents
init *   (fetch-cache / analyze / fix-* / update-parents / sync-new / all)
calendar expand (--no-dry-run) / recurring replay
project-progress sync
```

:::note
`dead-letter list` 是读命令（免鉴权）；`dead-letter retry` 是写命令（需鉴权）。`page-orphans` / `file-link-audit` / `calendar expand` / `llm compare-paths` 默认 `--dry-run`（只读、免鉴权），加 `--no-dry-run`（或真修复 flag）后变写命令、需鉴权。
:::

## 校验机制

服务端 `.env` 配 `MAILAGENT_CLI_API_KEY` 后，写命令必须提供同值，CLI 用 `hmac.compare_digest` 常量时间比对。不上 OAuth、不做 RBAC、不区分用户——目的不是防本机其他用户（macOS Full Disk Access 已锁住 SQLite），而是**防 agent / 第三方进程 / 误粘贴命令** 误触发写操作。

校验失败 → 退出码 `4` + `error.code = E_AUTH_FAILED`。

## `--api-key` vs 环境变量

两种提供方式，**优先用环境变量**：

```bash
# ✅ 推荐：环境变量（不进 shell history、不进多数进程列表快照）
export MAILAGENT_CLI_API_KEY="$(cat /run/secrets/mailagent_cli_key)"
mailagent email flag 53675 --is-read

# ⚠️ inline flag：会进 shell history + ps 进程列表，泄漏面更大
mailagent --api-key xxx email flag 53675 --is-read
```

优先级（高 → 低）：

```
--api-key  >  $MAILAGENT_CLI_API_KEY  >  .env 里的 MAILAGENT_CLI_API_KEY
```

:::caution[--api-key 的 shell history 风险]
`--api-key xxx` 写在命令行会落进 `~/.zsh_history` / `~/.bash_history`，也会出现在 `ps aux` 的进程参数里。CI / cron / agent runner 一律用 `MAILAGENT_CLI_API_KEY` 环境变量从 secret store 注入，不要 inline。
:::

## `--yes` / `--confirm` —— 破坏性命令

破坏性命令（`email delete` / `admin cleanup-*` / `notion archive`）默认要交互确认。agent 调用必须显式传 `--yes` 跳过 prompt：

```bash
mailagent email delete 53675 --yes
mailagent notion archive 36215375-830d-... --yes
mailagent admin cleanup-deadletter --older-than 30 --no-dry-run --yes
```

部分高危场景还可叠加 `--confirm <internal_id>` 二次确认，防 wrong target。**`--yes` 不替代鉴权**——破坏性写命令既要 `--yes` 又要 API key。

## `--dry-run` 跳过鉴权

`--dry-run` 只打 plan、不写任何东西，因此**不需要 API key**。这让 agent 能在没有 token 的环境里先验证一条写命令"会做什么"：

```bash
# 无需 API key：dry-run 只输出计划
mailagent -o json email resync 53675 --dry-run | jq '.data'
mailagent -o json llm run 53675 --dry-run | jq '.data.labels'
```

工作流建议：**先 `--dry-run` 验证 plan → 再去真跑（带 API key）**。

## dev bypass 风险（`ALLOW_UNAUTH_WRITES`）

服务端**没配** `MAILAGENT_CLI_API_KEY` 时，写命令**默认拒绝**（退 `4`）——这是有意的"默认安全"。唯一逃生口是显式设环境变量：

```bash
# 仅限本地 dev：服务端没配 token 时放行写命令
MAILAGENT_CLI_ALLOW_UNAUTH_WRITES=true mailagent email flag 53675 --is-read
```

:::danger[ALLOW_UNAUTH_WRITES 绝不进 .env / CI]
`MAILAGENT_CLI_ALLOW_UNAUTH_WRITES=true` 把"忘配 token"变成"无防护"。它**只能**在本地交互式 dev shell 里临时 `export`，**绝不能**写进 `.env`、Dockerfile、CI secret、systemd unit。一旦它常驻，任何能跑 CLI 的进程都能无鉴权写 Notion / Mail.app。
:::

## Agent 安全须知

给写自动化 / 让 AI agent 调 `mailagent` 时，遵守这几条：

1. **token 从 secret store 注入环境变量**，不 hardcode、不 inline `--api-key`、不进 repo。
2. **CI / CD 用 `CLI_API_KEY` 环境变量**，并确保 `MAILAGENT_CLI_ALLOW_UNAUTH_WRITES` **未设**。
3. **agent 默认只给读命令**；要执行写命令时，先 `--dry-run` 让 agent 输出 plan、人工 / 上层 gate 审核，再真跑。
4. **破坏性命令（delete / cleanup / archive）要双闸**：`--yes` + 有效 API key，必要时 `--confirm <id>`。
5. **退出码 `4` 当作硬失败**，不自动重试——重试一个鉴权失败的命令只会刷日志，不会成功。

## 深入了解

- [自动化环境安装与配置](/agent/setup/) — `MAILAGENT_CLI_API_KEY` 注入
- [退出码契约](/agent/exit-codes/) — `4` / `E_AUTH_FAILED`
- [10 大命令组参考](/agent/commands/) — 各写命令的 flag
- 鉴权 spec：[`agent-cli-rfc.md` §5.3](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/cli/agent-cli-rfc.md) · [`cli-reference.md`](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/cli/cli-reference.md)
