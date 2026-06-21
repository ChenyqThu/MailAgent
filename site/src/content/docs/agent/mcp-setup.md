---
title: "MCP 接入与 skill pack"
description: "把 MailAgent Skill 层接进 MCP 客户端：mailagent-mcp console script 启动 + MAILAGENT_API_BASE / MAILAGENT_AGENT_KEY 环境变量 + Claude Desktop / Code 配置（mcp-config.example.json）+ export_skill_pack.py 导出 + selftest 自检。"
---

如果你的 agent 跑在 **MCP 客户端**里（Claude Desktop / Claude Code / 任意 MCP host），不用裸调 [REST](/agent/skill-delivery/) —— MailAgent 提供一个 **MCP stdio server** `mailagent-mcp`，把 Skill manifest 里 `mcp_exposed=true` 的工具自动暴露成 MCP tools。

:::note[前置]
先按 [Skill Delivery API](/agent/skill-delivery/) 申请一把 scoped Bearer key（`mak_…`）。MCP server 经这把 key 打 serve-api，本页假设你已经有 key。
:::

## mailagent-mcp（MCP stdio server）

`mailagent-mcp` 是个 console script（`pip install -e ".[cli,dev]"` 后可用），跑 MCP stdio JSON-RPC（`initialize` / `tools/list` / `tools/call`）。它不自己实现业务，只把请求经 Bearer key 转发给 serve-api 的 `/api/skills/invoke`。

工具从 manifest 的 `mcp_exposed` 字段生成，命名 `mailagent_<skill>_<tool>`（如 `mailagent_search_email_search`）。

### 两个环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `MAILAGENT_API_BASE` | serve-api 地址 | 本机 `http://127.0.0.1:8200` |
| `MAILAGENT_AGENT_KEY` | scoped Bearer key（`mak_…`）| 无（必填）|

远程打 `https://mail.chenge.ink`。手动起一次验证：

```bash
MAILAGENT_API_BASE=http://127.0.0.1:8200 \
MAILAGENT_AGENT_KEY=mak_… \
  mailagent-mcp
```

它会等 MCP 客户端经 stdin 发 JSON-RPC —— 正常情况由客户端拉起，不用手动跑，这步只是确认 console script 在 PATH 里。

## Claude Desktop / Claude Code 配置

MCP 客户端用一段 JSON 声明怎么拉起 server。把 `mailagent-mcp` 配成一个 stdio MCP server：

```jsonc
{
  "mcpServers": {
    "mailagent": {
      "command": "mailagent-mcp",
      "env": {
        "MAILAGENT_API_BASE": "http://127.0.0.1:8200",
        "MAILAGENT_AGENT_KEY": "mak_…"
      }
    }
  }
}
```

- **Claude Desktop**：写进 `claude_desktop_config.json` 的 `mcpServers`。
- **Claude Code**：等价的 MCP server 注册。
- `command` 若不在 PATH，用绝对路径 `./venv/bin/mailagent-mcp`。

:::caution[key 不进 repo]
`MAILAGENT_AGENT_KEY` 是明文 `mak_…`。配置文件若入库 / 同步，请用客户端支持的 secret 注入方式，别把 key 提交进版本库。
:::

这份 JSON 不用手写 —— skill pack 直接导出一份现成的（见下）。

## skill pack：一键导出 + 自检

`scripts/export_skill_pack.py` 把对外交付面打成一个目录，给你现成的客户端配置 + 文档 + 自检脚本：

```bash
python scripts/export_skill_pack.py     # → dist/mailagent-skill-pack/（gitignored）
```

产物：

| 文件 | 内容 |
|---|---|
| `README` | 接入说明 |
| `mcp-config.example.json` | 上面那段 MCP 配置的现成模板 |
| `manifest.json` | 完整 Skill manifest |
| `openapi.json` | REST 端点的 OpenAPI 描述 |
| `selftest.sh` | 安全自检脚本 |
| `skills/<skill>/SKILL.md` | 5 个 skill 各一份说明 |

### 自检

`selftest.sh` 只跑**安全动作**（health / manifest / search / report_list；`report.run` 为 opt-in），不碰写 / 发：

```bash
MAILAGENT_API_BASE=http://127.0.0.1:8200 \
MAILAGENT_AGENT_KEY=mak_… \
  bash dist/mailagent-skill-pack/selftest.sh
```

它验证：key 有效（非 403）→ manifest 能取（按 scope 过滤）→ 一个只读 tool 能跑通。接进 MCP 客户端前先跑它，能在客户端层之外把鉴权 + 连通性问题先排掉。

## 与 CLI-as-MCP 的区别

:::note[两条 MCP 路径，别混]
本页的 `mailagent-mcp` 经 **Bearer key 打 serve-api 的 Skill 层** —— 远程可用、按 scope 收敛、不碰本机 CLI。
[MCP / Agent Harness 集成](/agent/mcp-harness/) 末尾讲的是另一种思路：自己把 `mailagent` **CLI** 包成 MCP server（本机、按 CLI 读写分权）。生产对外交付用前者。
:::

## 深入了解

- [Skill Delivery API](/agent/skill-delivery/) — scoped key 申请 + REST manifest / invoke + 5 skill 表
- [MCP / Agent Harness 集成](/agent/mcp-harness/) — 前端 chat harness + CLI-as-MCP 草图
- 设计真源：[`docs/reference/llm-agent/skill-delivery-api.md`](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/llm-agent/skill-delivery-api.md)
