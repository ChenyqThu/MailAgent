# PR-7+ Handoff: 未来 nice-to-have（模糊）

> **Mission**: PR-6 ship 后（commit `<PR-6 末位>`，2026-05-16）的未决 / nice-to-have
> 项。**不规定实施时间**，由后续 release window 视优先级 / 需求决定。
>
> 本文档是模糊 handoff —— 列出待决事项 + 决策依据，不规定 prd.json 结构，不
> 排时序。下一个 PR 启动时再起 prd.json。

---

## 1. 范围外（PR-7+ 候选）

### 1.1 `src/{init,cleanup}/` 反向 import 收口（PR-6 §2.2 nice-to-have）

> **PR-6 spec 偏差备注**：原 `docs/archive/pr6-handoff-deprecation-cleanup.md` §2.1
> 把 `scripts/replay_recurring_invite.py` 列入「7 个真 thin wrapper 可 git rm」桶。
> 实测 `src/cli/commands/calendar.py:193, 377` 直接
> `from scripts.replay_recurring_invite import discover_recurring, replay_one`
> —— 整体删会破 CLI。PR-6 ship 时调整为「保留 module + 删 `__main__`」。
> 因此本节 §1.1 候选迁移把 `replay_recurring_invite.py` 也加上（迁到
> `src/calendar_notion/recurring_invite.py`，与现有 `src/calendar_notion/sync.py`
> 同 group）。

PR-5 / PR-6 都保留了一个反模式：`src/cli/commands/*.py` 反向 import `scripts/X`：

| CLI 文件 | 反向 import 的 scripts/ 模块 |
|---|---|
| `src/cli/commands/admin.py` | `scripts.cleanup_syncstore` / `cleanup_duplicate_message_ids` / `cleanup_notion_db` |
| `src/cli/commands/calendar.py` | `scripts.replay_recurring_invite` |
| `src/cli/commands/init.py` | `scripts.initial_sync` |

`src/` import `scripts/` 方向不健康。可选迁移：

```
scripts/initial_sync.py                  → src/init/initial_sync.py
scripts/cleanup_syncstore.py             → src/cleanup/syncstore.py
scripts/cleanup_duplicate_message_ids.py → src/cleanup/duplicate_message_ids.py
scripts/cleanup_notion_db.py             → src/cleanup/notion_db.py
scripts/replay_recurring_invite.py       → src/calendar_notion/recurring_invite.py (与现有 calendar_notion 同 group)
```

**收益**: 删 `scripts/__init__.py`，顶层 `scripts/` 仅剩 `dev/` + `archive/` + `*.sh`
+ `html_clipboard.py` / `keep_alive.py`。CLI 模块只 import `src/`，方向一致。

**代价**: 5 个文件 git mv + CLI import path 改 5 处。需要先 grep 校验依赖（应该
只有 CLI 用，没有其他 src/* 引用）。预估 0.5 天。

**触发条件**: 想做架构整洁性 cleanup 时 / 加新 CLI 命令复用这些类时。

### 1.2 db_version 6 → 7（新需求驱动）

PR-4 ship 时 DB_VERSION = 6（cli_checkpoints + v4_rollout_stats 表）。后续需求才升：

- LLM cache 表（如果想本地缓存 LLM 输出做 dry-run 重复跑）
- 反向 sync 队列表（Notion → Mail.app 事件持久化，目前走 Redis 内存队列）
- FTS5 tokenizer 升级（中文分词，目前是字符级 unigram；详见 CLAUDE.md FTS5 段
  "中文搜索注意"）
- 附件去重表（如果两封邮件包含同一 PDF 想本地只存一份）

**触发条件**: 上述需求中某一项有具体业务驱动。

### 1.3 新 CLI 命令需求

PR-5 contract 冻结 10 个 group / 45+ schema / 退出码体系。新加另开 PR：

- `mailagent llm cache {list,clear}`（如果做 1.2 LLM cache 表）
- `mailagent calendar recurring expand <internal_id>`（手动展开单封 RRULE）
- `mailagent admin migrate-attachments` / `migrate-bodies`（v4 backfill 收尾工具）
- `mailagent notion diff <internal_id>`（SQLite vs Notion 字段 diff，灰度审查工具）

**触发条件**: 实际 agent / 用户提出明确需求。

### 1.4 重构 `src/cli/long_task.py` / `pm2_check.py`

PR-4 ship 稳定（checkpoint resume + max-failures + PM2 检测）。当前架构良好，
**没需求别动**。仅当：

- 长任务模型从 SIGINT-aware 升级为 cooperative-cancel（如 trio / anyio 风格）
- PM2 检测换技术（如改 systemd / launchd）
- checkpoint 表加新字段（如 owner / partition）

才触发重构。

### 1.5 删 `scripts/__init__.py`

完全做完 1.1 迁移后才能删。当前 `scripts/__init__.py` 是空文件 + 5 个 CLI 依赖
module 仍住在 `scripts/`，namespace 必须保留。

---

## 2. 不在 PR-7+ 范围（确定不动）

| 项 | 原因 |
|---|---|
| 改 db_version | 没需求 |
| 改 10 个 CLI group / 退出码 | PR-5 contract 冻结 |
| 改 `.sh` / production scripts（`html_clipboard.py` / `keep_alive.py` / `create_reply_draft.sh` / `deploy-webhook.sh` / `toggle_keep_alive.sh`） | 生产入口稳定 |
| 重写 `src/repository/` / `src/notion/` | I-07 拆完, R-06 已修, 稳定 |
| 改 prompt caching / fallback chain | PR-5 ship 后稳定，cache 命中率符合预期 |
| 删 5 个 import-only module | CLI 仍依赖；要删先做 1.1 迁移 |

---

## 3. 当前架构状态（post-PR-6, 2026-05-16）

| 维度 | 状态 |
|---|---|
| CLI groups | 10 个（email / admin / attachment / llm / notion / calendar / debug + backfill + project-progress + init） |
| Schemas | 45+ 个（`docs/cli-schema/`） |
| 退出码 | 0/1/2/4/5/6/7/8/9/130 完整冻结 |
| DB_VERSION | 6（cli_checkpoints + v4_rollout_stats） |
| pytest | 655 passed（PR-6 ship baseline） |
| ruff | PR-6 touched files clean；项目其他 `src/` / `tests/` / `scripts/dev/` / `scripts/archive/` 有 ~140 个 pre-existing 警告（非 PR-6 引入） |
| scripts/ 顶层 | 5 import-only + 2 production helper (`html_clipboard.py` / `keep_alive.py`) + 1 `__init__.py` + 3 `.sh` + `dev/` + `archive/` |
| v4 灰度 | `NOTION_READ_FROM_SQLITE=false` 默认；切 true 实测 OK（详见 `docs/phase4-complete.md`） |
| Webhook server | 远程 `mailagent-webhook` PM2 进程稳定，看板 + 8 个 event handler |
| 飞书集成 | 通知 + 卡片 form 交互 + 告警机器人 |
| LLM Agent | Sonnet 4.6 主 + GPT-5.4 / Opus 4.7 fallback；prompt caching 1h TTL；657 已处理（成功率 ~98%） |

---

## 4. 启动新 PR 的建议

1. **先看本文档 §1** 决定要做哪一项
2. **起独立 prd.json** 不复用 PR-6 的；session-scoped 在 `.omc/state/sessions/{sessionId}/prd.json`
3. **遵循 PR-5 / PR-6 的 Claude/Codex 工作流**（详见 `CLAUDE.md` § "Claude/Codex 分工"
   或 `docs/archive/pr5-handoff-scripts-migration.md`）：
   - Claude 规划 + 分解 + commit + 文档
   - Codex 写代码（通过 `~/.claude/skills/collaborating-with-codex/scripts/codex_bridge.py`）
   - 例外允许 Claude 直写: `docs/*.md` / `CLAUDE.md` / `prd.json` / `progress.txt` /
     测试 fixture / 一行 fix / ai-slop-cleaner 局部清理
4. **完成定义** = pytest ≥ baseline + 全 stories passes:true + codex critic round 2 APPROVE
   + ai-slop-cleaner pass + post-deslop regression 全绿

---

> 本 handoff 与 PR-5 / PR-6 ship 同步起草（commit `<PR-6 末位>`）。PR-7+ 实际启动
> 时间由用户决定，本文档可作起点。
