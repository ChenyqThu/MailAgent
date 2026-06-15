---
title: "退出码契约"
description: "mailagent 全退出码表（0/1/2/4/5/6/7/8/9/130）、每个码的 error.code 对应、如何脚本化判定，以及 exit 1 vs exit 6 的关键区别。"
---

`mailagent` 的退出码是**契约的一部分**——agent 不该靠解析文本判断成败，而该靠退出码 + `status` 字段。本页是全表 + 脚本化判定手册。

## 全表

| 退出码 | 含义 | 对应 `error.code` | 触发场景 |
|---|---|---|---|
| `0` | 成功 | — | 业务正常（含 `partial_failure` 但 0 失败的情况） |
| `1` | 业务失败（非 batch） | `E_NOT_FOUND` / `E_INTERNAL` / `E_LLM_FAILED` | not found / Notion API 错 / dry-run 检测到不一致 / 内部异常兜底 |
| `2` | 参数错 | `E_INVALID_ARG` / `E_NOT_IMPLEMENTED` | flag 非法 / 互斥 / 范围超出 / typer 自动校验失败 |
| `4` | 认证失败 | `E_AUTH_FAILED` | 写命令缺 `MAILAGENT_CLI_API_KEY` 或 token 不匹配 |
| `5` | 数据不一致 | `E_SCHEMA_MISMATCH` | `db_version != expected` / 读到不兼容 schema |
| `6` | partial_failure | `E_PARTIAL_FAILURE` | batch 命令同时有 succeeded 和 failed，未熔断 |
| `7` | aborted | `E_ABORTED` | SIGINT / SIGTERM 第一次（当前 unit 跑完后退出） |
| `8` | max-failures 熔断 | `E_MAX_FAILURES` | 长任务连续失败超 `--max-failures` |
| `9` | pm2 conflict | `E_PM2_RUNNING` | 写命令检测到 PM2 `mail-sync` 正 online |
| `130` | SIGINT 二次强退 | —（直接 `sys.exit(130)`） | 在 abort summary 阶段再按 Ctrl-C |

:::note
退出码与 `error.code` 是**多对一**：`1` 可能是 `E_NOT_FOUND` / `E_INTERNAL` / `E_LLM_FAILED`。要精确分支就解析 `error.code`；要粗粒度分支就看退出码。`130` 没有对应 `E_*`（进程直接 `sys.exit(130)`，可能来不及打 JSON）。
:::

## 如何脚本化判定每一个码

```bash
mailagent -o json email resync --range 53000-53100 --replace-existing
rc=$?
case "$rc" in
  0)  echo "all resynced" ;;
  1)  echo "business failure (not found / notion error)"; exit 1 ;;
  2)  echo "bad args — fix the command line"; exit 2 ;;
  4)  echo "auth failed — set MAILAGENT_CLI_API_KEY"; exit 4 ;;
  5)  echo "db schema mismatch — run backend migration first"; exit 5 ;;
  6)  echo "partial failure — inspect data.failed[], re-run failed ids"; ;;
  7)  echo "aborted by SIGINT — resume with --resume-from"; ;;
  8)  echo "circuit-broken by --max-failures — backend likely unhealthy"; exit 8 ;;
  9)  echo "pm2 mail-sync running — stop it or pass --allow-concurrent"; exit 9 ;;
  130) echo "force-quit"; exit 130 ;;
  *)  echo "unexpected rc=$rc"; exit "$rc" ;;
esac
```

各码的标准处理动作：

- **`0`** —— 成功。注意 batch 命令若**全部** unit 成功（哪怕 `status` 是 `success`）退 `0`。
- **`1`** —— 单封 / 非 batch 的业务失败。解析 `error.code` 区分 not-found（可忽略）vs LLM 失败（可重试）。
- **`2`** —— 你的命令行写错了。**不要重试**，先修命令。
- **`4`** —— 鉴权。检查 `MAILAGENT_CLI_API_KEY` 是否注入。详见 [鉴权契约](/agent/auth/)。
- **`5`** —— DB schema 不一致。先让后端起 DB 迁移，再重跑 CLI。**不要硬重试**。
- **`6`** —— 部分成功。从 `data.failed[].internal_id` 收集失败 id，单独重跑那一批。详见下文。
- **`7`** —— 被 SIGINT 优雅中止。用 `--resume-from <N>` 从断点续跑（checkpoint）。详见 [长任务契约](/agent/long-tasks/)。
- **`8`** —— 连续失败触发熔断，通常意味着后端 / 网关整体出问题。**先排障，别盲目重试**。
- **`9`** —— PM2 `mail-sync` 在跑，写命令为防双写自动拒绝。停 pm2 或显式 `--allow-concurrent`。详见 [长任务契约](/agent/long-tasks/)。
- **`130`** —— 二次 Ctrl-C 强退，可能没来得及写 checkpoint / 打 summary。

## exit 1 vs exit 6 —— 关键区别

这是 agent 最常踩的坑：

- **`exit 1`（`E_NOT_FOUND` 等）= 非 batch 模式的业务失败。** 例如 `email get 99999`（单封、不存在）退 `1`，输出是 `status: "error"` 的 wrapper，**没有** `data`。
- **`exit 6`（`E_PARTIAL_FAILURE`）= batch 模式下"有成功也有失败"。** 例如 `email resync --range 53000-53100` 里 87 封成功 13 封失败，退 `6`，输出是 `status: "partial_failure"` 的 wrapper，`data.succeeded` / `data.failed` / `data.summary` **都在**。

换句话说：

| | exit 1 | exit 6 |
|---|---|---|
| 模式 | 单封 / 非 batch | batch（`--range` / `--ids`） |
| `status` | `"error"` | `"partial_failure"` |
| 有 `data`？ | 否（只有 `error`） | 是（`succeeded`/`failed`/`summary`） |
| 重试策略 | 整条命令重试或放弃 | 只重跑 `data.failed[]` 里的 id |

```bash
# exit 6 的标准处理：抽出失败 id，逐个或成批重跑
out=$(mailagent -o json email resync --range 53000-53100 --replace-existing)
if [ $? -eq 6 ]; then
  failed_ids=$(jq -r '.data.failed[].internal_id' <<<"$out" | paste -sd, -)
  echo "retrying failed: $failed_ids" >&2
  mailagent -o json email resync --ids "$failed_ids" --replace-existing
fi
```

:::tip[别用 set -e]
batch 命令的 `6` / `7` / `9` 是你想自己处理的结果，不是脚本该直接死掉的"错误"。用 `set -uo pipefail` 而非 `set -e`，自己 `case "$rc"`。
:::

## 深入了解

- [全局 flag 与输出格式](/agent/output-formats/) — `error.code` / `status` / wrapper 结构
- [长任务契约](/agent/long-tasks/) — `6` / `7` / `8` / `9` 的来龙去脉 + checkpoint resume
- [写命令鉴权契约](/agent/auth/) — `4` 的成因与规避
- 全表 spec：[`error-codes.md`](https://github.com/ChenyqThu/MailAgent/blob/main/docs/cli-schema/error-codes.md) · [`agent-cli-rfc.md` §5.2](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/cli/agent-cli-rfc.md)
