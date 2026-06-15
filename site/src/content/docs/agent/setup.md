---
title: "自动化环境安装与配置"
description: "在自动化环境里装好 mailagent CLI：venv 安装、配置优先级链、load_cli_config 工厂、MAILAGENT_CLI_API_KEY、shell 补全。"
---

本页讲清如何在 CI / cron / agent runner 里把 `mailagent` CLI 跑起来，并理解它的配置加载顺序——后者直接决定"我设的值到底有没有生效"。

## 安装

CLI 通过 `pip` 的 optional-dependencies 安装。从仓库根目录（已有 venv）执行：

```bash
source venv/bin/activate
pip install -e ".[cli,dev]"
#   cli: typer / rich / pyyaml
#   dev: pytest + jsonschema>=4.18 + referencing（跑 schema 校验时需要）
```

验证：

```bash
which mailagent        # 应是 <project>/venv/bin/mailagent
mailagent --version    # 打印版本号
mailagent --help       # 列 10 个 group + 全局 flags
```

:::caution[venv 与 PATH]
`pip install -e .` 把 `mailagent` console_script 装进 `venv/bin/`。自动化环境里**不要**依赖交互式 shell 的 PATH——要么 `source venv/bin/activate`，要么直接用绝对路径 `/path/to/project/venv/bin/mailagent`。后者在 cron / systemd / GitHub Actions 里更稳。
:::

:::caution[macOS Full Disk Access]
本机读 Mail.app 的 SQLite / 执行 AppleScript 需要 **Full Disk Access**（系统设置 → 隐私与安全 → 完全磁盘访问权限）授予运行 CLI 的终端 / runner。纯读 `data/sync_store.db`（已同步数据）不需要 FDA；触达 Mail.app 的 `debug applescript-fetch` / `debug mail-structure` 等命令才需要。
:::

## 配置优先级链

CLI 启动时按下列顺序加载配置，**后者覆盖前者**：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1（最低） | `~/.config/mailagent/config.toml` | 用户级，可选 |
| 2 | `<project>/.env` | 与服务共用的 pydantic Config |
| 3 | `--config PATH` | CLI 显式指定的配置文件 |
| 4 | `MAILAGENT_*` 环境变量 | 如 `MAILAGENT_CLI_API_KEY` |
| 5（最高） | 命令行 flag | `--db-path` / `--api-key` 等 |

例：`mailagent --config x.toml email get 53675` 会用 `x.toml` 里的 `db_path` 而非 `.env`。

```bash
# db 路径覆盖：临时指向另一个库（如 app 库 vs 主仓 PM2 库）
mailagent --db-path ~/Library/Application\ Support/mailagent-frontend/data/sync_store.db \
  -o json email list --limit 5

# API key 覆盖（写命令）：env 优先于 .env，flag 优先于 env
MAILAGENT_CLI_API_KEY=xxx mailagent email flag 53675 --is-read
mailagent --api-key xxx email flag 53675 --is-read
```

## `load_cli_config()` 工厂——为什么配置一定生效

CLI **不**用模块级单例 `from src.config import config`。原因：pydantic Settings 在 import 时就立即加载 `.env`，那样 `--config` flag 来得太晚、无法覆盖。

CLI 改用显式工厂 `load_cli_config(config_path, env_overrides, flag_overrides)`：每次启动按上面的优先级链**重新构造一个 Config 实例**。这意味着：

- 你传的 `--config` / `--db-path` / `--api-key` **保证**生效，不会被 import-time 锁死的 `.env` 覆盖。
- 服务端进程（`main.py` / pm2）仍用全局 singleton，与 CLI 路径互不干扰——CLI 是短进程，每次干净加载。

:::note
这是一条 agent 友好的硬保证：**同一台机器上，你可以用 `--config` / `--db-path` 在不影响服务的前提下，把 CLI 指向任意一个库 / 配置**。常见用法是临时对照打包态 app 的库（`~/Library/Application Support/mailagent-frontend/data/sync_store.db`）和主仓 PM2 库（`data/sync_store.db`）。
:::

## `MAILAGENT_CLI_API_KEY`

写命令需要鉴权（读命令不需要）。在自动化环境里**用环境变量注入**，不要写进 `--api-key` 命令行（会进 shell history / 进程列表）：

```bash
# CI / cron：从 secret store 注入环境变量
export MAILAGENT_CLI_API_KEY="$(cat /run/secrets/mailagent_cli_key)"
mailagent email flag 53675 --is-read       # 自动用 env 里的 key
```

服务端 `.env` 里也配同名 `MAILAGENT_CLI_API_KEY`，CLI 用 `hmac.compare_digest` 比对。完整规则（读/写命令清单、`--dry-run` 跳过鉴权、dev bypass 风险）见 [写命令鉴权契约](/agent/auth/)。

:::danger[绝不进 .env]
`MAILAGENT_CLI_ALLOW_UNAUTH_WRITES=true` 是开发模式逃生口（服务端没配 token 时放行写命令）。它**绝不能进 `.env` 或 CI 环境**——一旦它在，"忘配 token"就等同于"无防护"。详见 [鉴权契约](/agent/auth/)。
:::

## shell 补全

`mailagent` 基于 typer，自带 shell completion：

```bash
# 安装当前 shell 的补全（zsh / bash / fish）
mailagent --install-completion zsh
# 或仅打印补全脚本，自己决定怎么 source
mailagent --show-completion zsh
```

补全覆盖资源、动作、flag，可枚举——这也是设计原则 2「资源-动作一致」给 agent autocomplete 的红利。

## 常见安装问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `mailagent: command not found` | venv 未激活 / PATH 没含 venv/bin | `source venv/bin/activate` 或用绝对路径 |
| 写命令报 `E_AUTH_FAILED`（exit 4） | 没传 `MAILAGENT_CLI_API_KEY` | 注入 env 变量；见 [鉴权](/agent/auth/) |
| 读命令报 SQLite 权限错 | 缺 Full Disk Access | 给 runner 授予 FDA |
| `admin db-version` 报 `E_SCHEMA_MISMATCH`（exit 5） | db_version 与 expected 不符 | 先跑后端起 DB 迁移；见 [退出码](/agent/exit-codes/) |

## 深入了解

- [全局 flag 与输出格式](/agent/output-formats/)
- [写命令鉴权契约](/agent/auth/)
- 安装 / 鉴权 spec：[`docs/reference/cli/cli-reference.md`](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/cli/cli-reference.md) · [`agent-cli-rfc.md` §5.4 / §6.5](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/cli/agent-cli-rfc.md)
