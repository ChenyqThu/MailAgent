---
title: "长任务契约（batch）"
description: "mailagent batch / 长任务的可中断、可续跑契约：PM2 冲突 exit 9 + --allow-concurrent、SIGINT exit 7/130、--max-failures exit 8、checkpoint resume（cli_checkpoints + --resume-from）、--progress-every。含 PM2 冲突与 checkpoint 续跑两个完整 recipe。"
---

batch 命令（处理一批邮件而非单封）受一套**长任务契约**约束：可中断、可熔断、可续跑，且会主动避免与服务端进程双写。本页讲清这套契约 + 两个标准 recipe。

## 哪些是长任务

凡是用 `--range LO-HI` / `--ids LIST` / `--all` 批量处理，或本身就遍历大量邮件的命令：

```
email resync --range / --ids
backfill body
backfill derivatives
init fetch-cache / analyze / fix-* / update-parents / sync-new / all
```

这些命令额外支持：`--max-failures` / `--progress-every` / `--resume-from` / `--allow-concurrent`，并在中断 / 部分失败时走 [退出码契约](/agent/exit-codes/) 的 `6` / `7` / `8` / `9` / `130`。

## PM2 冲突检测（exit 9 + `--allow-concurrent`）

batch 写命令启动前会检测 PM2 `mail-sync` 是否在跑。如果 `online`，**默认拒绝**退出 `9`（`E_PM2_RUNNING`）—— 防止 CLI 与服务端 FanoutWorker / watcher 同时写同一个库导致竞态 / 双写。

```bash
mailagent -o json email resync --range 53000-53100 --replace-existing
# 若 pm2 mail-sync online：
# {"status":"error","error":{"code":"E_PM2_RUNNING",
#   "message":"pm2 mail-sync is online; refusing to run batch write",
#   "hint":"Stop pm2 first or pass --allow-concurrent"}, ...}   → exit 9
```

两种处理：

- **停 pm2 再跑**（推荐，最安全）：`pm2 stop mail-sync` → 跑 batch → `pm2 start mail-sync`。
- **`--allow-concurrent` 显式绕过**（仅你确知不会冲突的灰度场景）：

```bash
mailagent email resync --range 53000-53100 --replace-existing --allow-concurrent
```

:::caution
`--allow-concurrent` 关掉的是安全闸，不是冲突本身。除非你清楚这批 id 不会被服务端同时触碰，否则优先"停 pm2"。
:::

## SIGINT / SIGTERM（exit 7，二次 exit 130）

长任务对中断信号分两级响应：

| 信号 | 行为 | 退出码 |
|---|---|---|
| SIGINT 第一次（Ctrl-C）/ SIGTERM | 当前 unit 跑完 → 写 checkpoint → 打 summary → 退出 | `7`（`E_ABORTED`） |
| SIGINT 第二次（再 Ctrl-C） | 立即 `sys.exit(130)`，不等当前 unit | `130` |

第一次中断是**优雅的**：它不会留下半个 unit，且会落 checkpoint，让你能 `--resume-from` 续跑。第二次中断是**强退**，可能来不及写 checkpoint / 打 summary。

```bash
# 优雅中止后，输出会带 resume 提示：
#   Aborted at internal_id=53050. Resume with: mailagent email resync --range 53000-53100 --resume-from 53051
```

## `--max-failures` 熔断（exit 8）

长任务连续失败超过 `--max-failures`（默认值因命令而异）时熔断，退出 `8`（`E_MAX_FAILURES`）。这通常意味着后端 / 网关整体出问题（而非单封数据坏），**不该盲目重试**——先排障。

```bash
mailagent -o json email resync --range 53000-54000 --max-failures 5
# 连续 5 次失败 → exit 8，summary.aborted_by = "max_failures"
```

熔断与 partial_failure（`6`）的区别：`6` 是"有成功也有失败、跑完了"；`8` 是"连续失败到阈值、提前中止"。

## checkpoint resume（`cli_checkpoints` + `--resume-from`）

batch 命令每 N 个 unit（默认 50）把进度写进 SQLite 的 `cli_checkpoints` 表（key 是 `<command, target_key>`）。中断 / 熔断后：

- **同命令、同 target 再跑**会**自动**从 `last_completed_internal_id + 1` 续——不用你手动指定。
- 也可显式 `--resume-from N` 从 `internal_id >= N` 续跑。

```bash
# 显式从断点续
mailagent email resync --range 53000-53100 --resume-from 53051 --replace-existing
```

## `--progress-every` 进度回报

`--progress-every N`（默认 10）控制 stderr 进度打印间隔。text 模式下走 `rich` 进度条（bar + rate + ETA）；JSON 模式下走 NDJSON 流（每个 unit 一行，末行 `_meta`，见 [输出格式](/agent/output-formats/)）。

```bash
# 每 25 个 unit 报一次进度；JSON 走 ndjson 流式
mailagent -o ndjson email resync --range 53000-54000 --progress-every 25 --replace-existing \
  | jq -c 'select(._meta | not) | {id: .internal_id, ok: .passes}'
```

## Recipe 1 — PM2 冲突自动处理

agent 想跑 batch 写命令，但不确定 pm2 状态。检测到 `9` 就停 pm2、重跑、再恢复：

```bash
#!/usr/bin/env bash
set -uo pipefail
MA="./venv/bin/mailagent"
export MAILAGENT_CLI_API_KEY="${MAILAGENT_CLI_API_KEY:?need key}"

run_resync() { "$MA" -o json email resync --range 53000-53100 --replace-existing; }

out=$(run_resync); rc=$?
if [ "$rc" -eq 9 ]; then
  echo "pm2 mail-sync online; stopping it for the batch" >&2
  pm2 stop mail-sync
  trap 'pm2 start mail-sync' EXIT       # 无论如何最后把服务拉回来
  out=$(run_resync); rc=$?
fi

case "$rc" in
  0) echo "done" >&2 ;;
  6) echo "partial: $(jq -r '.data.summary | "\(.succeeded)/\(.total) ok"' <<<"$out")" >&2 ;;
  *) echo "resync rc=$rc" >&2; exit "$rc" ;;
esac
```

要点：用 `trap '... EXIT'` 保证脚本无论怎么退都把 `mail-sync` 拉回来；不要 `--allow-concurrent` 当默认绕过。

## Recipe 2 — checkpoint 续跑直到完成

长 batch 可能被 SIGINT（`7`）或熔断（`8`）打断。下面这个循环靠 checkpoint **自动续跑**，直到成功或彻底失败：

```bash
#!/usr/bin/env bash
set -uo pipefail
MA="./venv/bin/mailagent"
export MAILAGENT_CLI_API_KEY="${MAILAGENT_CLI_API_KEY:?need key}"
RANGE="53000-54000"

attempt=0; max_attempts=5
while :; do
  attempt=$((attempt+1))
  # 不带 --resume-from：同 <command,range> 自动从 cli_checkpoints 续跑
  "$MA" -o json email resync --range "$RANGE" --replace-existing --max-failures 10
  rc=$?
  case "$rc" in
    0) echo "completed after $attempt attempt(s)" >&2; break ;;
    6) echo "partial failures, but range finished — done" >&2; break ;;
    7) echo "aborted by signal; will auto-resume from checkpoint" >&2 ;;
    8) echo "circuit-broken (backend likely unhealthy); cooling down 60s" >&2; sleep 60 ;;
    9) echo "pm2 conflict; stop mail-sync first" >&2; exit 9 ;;
    *) echo "fatal rc=$rc" >&2; exit "$rc" ;;
  esac
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "gave up after $max_attempts attempts" >&2; exit 1
  fi
done
```

要点：

- **不传 `--resume-from`** 也能续——CLI 按 `<command, range>` 在 `cli_checkpoints` 里查 `last_completed_internal_id` 自动接上。要跨不同 range / 强制起点时才用 `--resume-from`。
- **`7`（aborted）直接重跑**即可（会自动续）；**`8`（熔断）先 cooldown** 再试，因为它通常是后端整体问题。
- **`9`（pm2 冲突）不在循环里硬扛**——交给 Recipe 1 那套停 pm2 逻辑或人工处理。

## 深入了解

- [退出码契约](/agent/exit-codes/) — `6` / `7` / `8` / `9` / `130` 全表
- [全局 flag 与输出格式](/agent/output-formats/) — partial_failure / NDJSON 末行 `_meta`
- [写命令鉴权契约](/agent/auth/) — batch 写命令的 token 要求
- 长任务 spec：[`cli-reference.md` PR-4 长任务](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/cli/cli-reference.md) · [`agent-cli-rfc.md` §5.2 PR-4](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/cli/agent-cli-rfc.md)
