---
title: "TL;DR 与设计原则"
description: "mailagent CLI 是 MailAgent 后端的单入口、resource-first、agent-friendly 命令行接口。本页讲清它的定位、七条设计原则，以及一段端到端自动化 quickstart 脚本。"
---

`mailagent` 是 MailAgent 后端的**单入口命令行工具**，专为 CLI / 自动化脚本 / AI agent 调用而设计。它把散落在 `scripts/*.py` 里的核心能力（邮件 CRUD、全文搜索、LLM 分类、Notion 重传、健康检查……）整合成一套 `<noun> <verb> [<id>] [flags]` 的命令树，风格对齐 `gh` / `kubectl` / `aws-cli`。

:::tip[一句话]
你的脚本 / agent 永远只跟一个二进制说话：`mailagent`。所有命令都能 `-o json` 输出**稳定 schema**，每个字段都有明确语义，可直接 `jq` 消费。
:::

## TL;DR

- **入口**：`pip install -e ".[cli,dev]"` 后全局 `mailagent` 命令可用。
- **资源-动作模型**：`mailagent email get 53675`、`mailagent admin health`、`mailagent llm run 53675 --dry-run`。
- **10 个命令组**：`email` / `attachment` / `llm` / `backfill` / `notion` / `admin` / `init` / `calendar` / `debug` / `project-progress`。
- **稳定 JSON 契约**：`-o json` 始终返回 wrapper object `{status, schema_version, data|error, meta}`（详见 [输出格式](/agent/output-formats/)）。
- **退出码体系**：`0 / 1 / 2 / 4 / 5 / 6 / 7 / 8 / 9 / 130`，可脚本化判定每种结果（详见 [退出码契约](/agent/exit-codes/)）。
- **读写分权**：读命令免鉴权，写命令需 `MAILAGENT_CLI_API_KEY`（详见 [鉴权契约](/agent/auth/)）。
- **长任务可中断、可续跑**：PM2 冲突检测、SIGINT 熔断、`--max-failures`、checkpoint resume（详见 [长任务契约](/agent/long-tasks/)）。

## 七条设计原则

按重要性排序。理解这些原则能帮你预测 CLI 在边界情况下的行为。

1. **Agent-first**：所有命令 `-o json` 输出 **stable schema**，每个字段语义固定。stderr 仅 1 行 timing/counts（`--quiet` 抑制），stdout 是纯 JSON，可直接 `jq`。
2. **资源-动作一致**：`<noun> <verb> [<id>] [flags]` 始终成立。资源名单数（`email` 不是 `emails`），动作名动词原形（`get` / `list` / `search`）。tab 补全友好，agent 可枚举。
3. **现有 Python API 是地面真值**：CLI 是 wrapper，不重写业务逻辑——只做"参数解析 → 调 API → 格式化输出"。CLI 的行为永远跟服务端（`main.py` / `mail-sync` 进程）走同一套 `EmailRepository` / `NotionSync`，不存在第二份实现。
4. **可观测**：每条命令默认在 stderr 打 1 行执行摘要（duration、行数等），便于 agent 检查执行情况；`meta.duration_ms` 也进 JSON wrapper。
5. **可中断**：长任务支持 `--max-failures` 熔断 + `--progress-every` 进度回报 + SIGINT 优雅退出 + checkpoint resume。
6. **配置一致**：默认读 `.env`（与服务一致）；`--db-path` / `--api-key` / `--config` 覆盖；`MAILAGENT_*` 环境变量优先。配置走显式 factory（`load_cli_config`），不依赖 import-time singleton。
7. **非破坏共存**：CLI 与 `scripts/*` 共存过渡期内老路径不立即失效（已 ship 的 PR-5 / PR-6 完成迁移收口，旧 `python scripts/<wrapper>.py` 用法现已废弃，统一走 `mailagent <group> <action>`）。

## 10 个命令组关系

| 组 | 职责 | 读/写为主 |
|---|---|---|
| `email` | 邮件 CRUD + 搜索 + 重传 + flag + 草稿 | 读 + 写 |
| `attachment` | 附件 list / download / derive / cleanup | 读 + 写 |
| `llm` | LLM 分类填 AI 字段 + selftest + stats + 路径对比 | 读 + 写 |
| `backfill` | 历史正文 / 衍生附件回填 | 写（长任务） |
| `notion` | Notion 直接操作（update-flag / orphan / archive / create-task） | 写 |
| `admin` | 统计 / 健康 / db-version / 死信 / cleanup / repair | 读 + 写 |
| `init` | 初始化同步 7 个 sub-action | 写（长任务） |
| `calendar` | 周期会议展开 / discover / replay | 读 + 写 |
| `debug` | raw MIME / mail-structure / inline-images / notion-page | 读 |
| `project-progress` | 项目周报同步外挂（xlsx → Notion） | 写 |

完整动作 + flag + `jq` 样例见 [10 大命令组参考](/agent/commands/)。

## 版本与安装检查

```bash
which mailagent        # 应是 <project>/venv/bin/mailagent
mailagent --version    # 打印版本号后退出
mailagent --help       # 列 10 个 group + 全局 flags
```

:::caution[PATH 注意]
`pip install -e .` 后 `mailagent` 在 `venv/bin/`。如果你的 shell PATH 没含 venv，直接用绝对路径 `./venv/bin/mailagent`，或先 `source venv/bin/activate`。CI / cron 里建议永远用绝对路径，避免依赖交互式 shell 的 PATH。
:::

## 端到端自动化 quickstart

下面这段脚本演示一个**读 + 写完整闭环**：健康检查 → 搜索 → 读一封正文 → 改一个 flag，每一步都做退出码处理。它是写自动化的起手式，建议照着改。

```bash
#!/usr/bin/env bash
set -uo pipefail   # 注意：不要 set -e，我们要自己判退出码

MA="./venv/bin/mailagent"     # 用绝对路径，别依赖 PATH
export MAILAGENT_CLI_API_KEY="${MAILAGENT_CLI_API_KEY:?need API key for writes}"

# 1) 健康检查 —— admin health exit 0 = 健康，1 = 不健康
if ! "$MA" -o json admin health | jq -e '.data.healthy == true' >/dev/null; then
  echo "backend unhealthy, abort" >&2
  exit 1
fi

# 2) 搜索 —— FTS5 全文，取第一封命中的 internal_id
ID=$("$MA" -o json email search "redis timeout" --mailbox 收件箱 --limit 1 \
       | jq -r '.data[0].internal_id // empty')
if [ -z "$ID" ]; then
  echo "no match, nothing to do" >&2
  exit 0
fi
echo "matched internal_id=$ID" >&2

# 3) 读一封正文（markdown），存下来给后续 LLM / 人工用
"$MA" -o json email body "$ID" --format markdown \
  | jq -r '.data.content' > "/tmp/body-$ID.md"

# 4) 写：把这封标为已读 + 标旗（写命令，需 API key）
"$MA" -o json email flag "$ID" --is-read --is-flagged
rc=$?
case "$rc" in
  0) echo "flag updated for $ID" >&2 ;;
  4) echo "auth failed — check MAILAGENT_CLI_API_KEY" >&2; exit 4 ;;
  9) echo "pm2 mail-sync running; retry later or pass --allow-concurrent" >&2; exit 9 ;;
  *) echo "flag failed rc=$rc" >&2; exit "$rc" ;;
esac
```

要点：

- **不要 `set -e`**：很多命令的非零退出码（`6` partial_failure / `9` pm2 conflict）是你想自己分支处理的"业务结果"，`set -e` 会让脚本在第一个非零处直接死掉。
- **永远 `jq -e` 做布尔判定**：`jq -e` 在结果为 `false` / `null` 时退出非零，配合 `if !` 很自然。
- **退出码是契约的一部分**：`case "$rc"` 分支处理 4 / 6 / 7 / 8 / 9 是 agent 自动化的标准姿势，详见 [退出码契约](/agent/exit-codes/)。

## EWS 关停迁移警示

如果你的自动化触达邮件**抓取 / 发送 / 日历**链路：MailAgent 生产主路径走 **DavMail 6.7**，它通过 **EWS** 桥接 Exchange，而 **EWS 将于 2026-10-01 关停**。届时需迁移到 Graph API 路线。详见 [`docs/reference/architecture/roadmap-post-cutover.md` §5.1](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/architecture/roadmap-post-cutover.md)。AppleScript fallback 路径始终可用，不受 EWS 影响。

## 深入了解

- [自动化环境安装与配置](/agent/setup/) — venv / 配置优先级链 / API key
- [全局 flag 与输出格式](/agent/output-formats/) — JSON wrapper / NDJSON / 字段约定
- [退出码契约](/agent/exit-codes/) — 0–130 全表 + 脚本化判定
- [10 大命令组参考](/agent/commands/) — 每组 synopsis + jq 样例
- 设计 RFC 全文：[`docs/reference/cli/agent-cli-rfc.md`](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/cli/agent-cli-rfc.md)
