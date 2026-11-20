# AGENTS.md

为 **Antigravity / Codex / 其它 AI Agent** 提供的项目指南。

> **单一真相原则**：本项目所有指南 —— 通用约束、调试流程、部署验证、架构总览、配置开关、
> 命令速查、Notion 数据库结构、各子系统深度文档 —— **以 [`CLAUDE.md`](./CLAUDE.md) 为准**。
> 本文件不复制全文（防与 `CLAUDE.md` 漂移），仅提供导航、核心工程红线速查与工具链差异。

## 怎么找到你要的

1. **先读 [`CLAUDE.md`](./CLAUDE.md)** —— 精简索引：通用指南 / 关键开关现状 / 命令速查 / 模块地图 / 调试与部署。
2. **深度内容**走 `CLAUDE.md` 的「文档地图」表，按「何时读」指针去 `docs/reference/<子系统>/` 读对应常青文档（每个子系统目录有 `index.md`）。
3. **文档规范**见 [`docs/DOC-GUIDE.md`](./docs/DOC-GUIDE.md)：
   - 常青参考 → `docs/reference/<子系统>/`（**新增常青文档必须在 `CLAUDE.md`「文档地图」加一行**）
   - 过程产物（handoff / complete / phaseN / prN / sprint / 验收 matrix）→ `.trellis/tasks/<task>/` 或 `docs/archive/{年-月}/`（冻结存史，**不是当前真相**）
4. **子目录规则**：改动官网 `site/` 时同时读取 [`site/AGENTS.md`](./site/AGENTS.md)（指向 [`site/CLAUDE.md`](./site/CLAUDE.md)）。

## 核心工程红线速查（详见 `CLAUDE.md`）

- **环境禁令**：macOS 下 **没有 `sudo`**；不运行交互式命令；未先跑诊断不盲改代码。
- **跨边界常量纪律**：同一常量 / 枚举 / 派生表要在第二处手抄前，先问能不能消灭镜像（下沉零依赖叶子模块）；消灭不了才建一致性测试闸（见 `CLAUDE.md` & `tests/config/`）。
- **前端 Design v3 铁律（[`frontend/DESIGN.md`](./frontend/DESIGN.md) §18）**：
  - Token SSoT 在 `frontend/src/electron/renderer/index.css`，**禁止硬编码 hex**（`icons/` 品牌商标资产除外）。
  - **中文最小字号 ≥ 14px（`text-aux` / `text-body`）**：`text-micro` (11px) / `text-meta` (12px) 仅限 ASCII/英文/数字，ESLint 规则 `mailagent/no-cjk-in-mono-size` 会直接拦 CI。
  - **中英双语 i18n 同源**：`zh-CN/common.json` 与 `en-US/common.json` 必须严格对齐。
- **项目级 Skills（`.agents/skills/` 镜像 `.claude/skills/`）**：
  - `debug` / `deploy` / `health` / `agent-eval` / `db-migration` / `release` / `sprint-handoff`（受 `tests/config/test_agent_skills_parity.py` 闸门约束）。
- **改后必跑验证闸**：
  - Python 行为与配置闸：`./venv/bin/python -m pytest tests/agent_eval tests/config -q`
  - 前端类型与规范闸：`pnpm --dir frontend typecheck && pnpm --dir frontend lint`

## 多平台专属差异

- **Antigravity**：自动发现根目录及子目录 `AGENTS.md` 与 `.agents/skills/*/SKILL.md`。
- **Codex**：项目级自定义 subagent / 配置位于 `.codex/agents/`，技能位于 `.agents/skills/`。
- 其余一切（SSH 凭据、PM2 调试顺序、部署验证清单等）与 Claude Code 完全一致，见 [`CLAUDE.md`](./CLAUDE.md)。

<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->
