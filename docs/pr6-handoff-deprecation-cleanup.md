# PR-6 Handoff: thin wrapper deprecation cleanup

> **Mission**: 4 周 release window 后，删除 PR-5 留下的 thin DeprecationWarning
> wrapper、清理文档对 `scripts/*.py` 老用法的提及、收口 `scripts/` 顶层目录。
>
> **预计工作量**: 0.5 天（纯删除 + 文档更新，不动业务代码）。
>
> **触发条件**: PR-5 ship 后 2-4 周用户都换到 `mailagent <subcommand>`，无
> stderr DeprecationWarning 反馈持续出现。

---

## 1. PR-5 ship 起点

| 项 | 状态 |
|---|---|
| git branch | main, clean |
| pytest 基线 | **650 passed** (PR-4 612 + PR-5 38 = 11 stories 各 1-7 case + 11 个 US-012 边界 case) |
| `mailagent --version` | 3.0.0 |
| CLI 子命令 | 10 group 不变（email / admin / attachment / llm / notion / calendar / debug + backfill + project-progress + init），所有 stub 接通 + subprocess wrap 全部 inline |
| `docs/cli-schema/` | 45+ schema 文件不变（部分扩 oneOf 支持 dry-run / repair 双形） |
| `data/sync_store.db` `db_version` | 6（PR-5 不动 schema） |
| 退出码体系 | 完整冻结（0/1/2/4/5/6/7/8/9/130，单测覆盖） |
| pm2 mail-sync | 行为不变（v4_rollout 60s flush 仍走 NotionSync → sync_store） |
| `scripts/` 顶层 | 11 个 module-with-DeprecationWarning（生产仍可调）+ `__init__.py` + 3 个 `.sh` + 2 个 production 脚本（html_clipboard / keep_alive） |
| `scripts/dev/` | 25 个 dev / inspect / debug / 一次性 harness（PR-5 US-010 移入） |
| `scripts/archive/` | 4 个真正历史 migration / PoC（PR-5 US-011 进一步分层） |

---

## 2. PR-6 范围

### 2.1 删 `scripts/*.py` thin wrappers / DeprecationWarning 入口

PR-5 之后 `scripts/` 顶层留了 11 个有 `__main__` DeprecationWarning 的 module
（CLI 还会 import 其中函数 / 类，所以模块不能整体删，但可以收口）：

| 文件 | 处置 | 备注 |
|---|---|---|
| `scripts/backfill_email_body.py` | 删 thin wrapper（已是 20 行 dep-warning + app(…) 转发） | CLI 不 import 此文件 |
| `scripts/backfill_derivatives.py` | 同上 | CLI 不 import |
| `scripts/sync_project_progress.py` | 同上 | CLI 不 import |
| `scripts/compare_llm_path.py` | 同上 | CLI 不 import（PR-5 把逻辑迁进了 `src/cli/commands/llm.py`） |
| `scripts/run_llm_on_email.py` | 删 thin wrapper（顶层只剩 dep-warning + asyncio.run(main()) 入口） | CLI 不 import |
| `scripts/resync_notion.py` | 同上 | CLI 不 import |
| `scripts/replay_recurring_invite.py` | 同上 | CLI 不 import |
| `scripts/initial_sync.py` | **保留**（CLI import `InitialSync` 类 + AnalysisReport）；移除 `__main__` 块即可 | CLI **依赖此 module** |
| `scripts/cleanup_syncstore.py` | **保留**（CLI import `show_stats` / `reset_sync_status`）；移除 `__main__` 块 | CLI 依赖 |
| `scripts/cleanup_duplicate_message_ids.py` | **保留**（CLI import `get_all_pages` / `extract_page_info` / `archive_page`）；移除 `__main__` 块 | CLI 依赖 |
| `scripts/cleanup_notion_db.py` | **保留**（CLI import `NotionDBCleaner` 类）；移除 `__main__` 块 | CLI 依赖 |

**判定原则**: 若 `grep -rn "from scripts.X import" src/` 返回非空 → 保留 module + 删 `__main__` block；否则整文件删除。

### 2.2 CLI 模块归位（可选优化）

PR-5 为了避免 1500 行大挪动，让 CLI `import from scripts.initial_sync import InitialSync` 之类的反向依赖（`src/` import `scripts/`，方向不健康）。PR-6 可以把 4 个被 CLI 依赖的 module 迁到 `src/`：

- `scripts/initial_sync.py` → `src/init/initial_sync.py`（CLI 改 `from src.init.initial_sync import InitialSync`）
- `scripts/cleanup_syncstore.py` → `src/cleanup/syncstore.py`
- `scripts/cleanup_duplicate_message_ids.py` → `src/cleanup/duplicate_message_ids.py`
- `scripts/cleanup_notion_db.py` → `src/cleanup/notion_db.py`

迁移后 `scripts/__init__.py` 可删，`scripts/` 只剩 `dev/` + `archive/` + `*.sh`。

**这一步是 nice-to-have**，PR-6 可以只做 2.1 的 thin wrapper 删除，迁移延后。

### 2.3 文档收口

- CLAUDE.md 全文搜 `scripts/*.py` / `python scripts/...` 提及，确认仅指 `dev/` `archive/` 或 `.sh`
- `docs/agent-cli-rfc.md` §9 scripts 迁移表标 "PR-5/PR-6 已完成"
- `docs/pr5-handoff-scripts-migration.md` 不动（历史快照）
- 移除 PR-3/PR-4 stub 描述（CLAUDE.md / agent-cli-rfc.md 里如还有遗漏）
- 把 [`docs/pr6-handoff-deprecation-cleanup.md`](./pr6-handoff-deprecation-cleanup.md)（本文件）和 [`docs/pr5-handoff-scripts-migration.md`](./pr5-handoff-scripts-migration.md) 一起归档到 `docs/archive/`（与代码 `scripts/archive/` 对齐）

### 2.4 验证

```bash
pytest tests/ -q --tb=no | tail -2
# 期望仍 ≥ 650 passed（不应因删 thin wrapper 掉测试）

mailagent backfill body --dry-run --limit 5 -o json | jq .data.mode
# 期望: "inline"（PR-5 起就是 inline，PR-6 不变）

python scripts/backfill_email_body.py --dry-run --limit 5 2>&1 | head -3
# 期望: "No such file or directory" 或类似（thin wrapper 已删）

ls scripts/
# 期望: dev/ archive/ __init__.py? *.sh html_clipboard.py keep_alive.py initial_sync.py cleanup_*.py
# （4 个保留 module + dev/archive 子目录 + production .sh / py）
```

---

## 3. 启动 prompt（PR-6 新 session）

```
/oh-my-claudecode:ralph --critic=codex 实施 PR-6: scripts/* thin wrapper deprecation cleanup

完整 spec 看 docs/pr6-handoff-deprecation-cleanup.md (本文档)。

PR-5 已 ship 在 commit <PR-5 ship 末位 commit>（650 passed, codex critic APPROVE, ai-slop-cleaner pass, ruff clean）。

PR-6 期望（简单, 0.5 天）:
- 7 个 thin wrapper script 直接 git rm（backfill_email_body / backfill_derivatives /
  sync_project_progress / compare_llm_path / run_llm_on_email / resync_notion /
  replay_recurring_invite）
- 4 个 CLI 依赖的 module 保留 module，删 __main__ block（initial_sync /
  cleanup_syncstore / cleanup_duplicate_message_ids / cleanup_notion_db）
- CLAUDE.md / agent-cli-rfc.md 收口提及；移到 docs/archive/ 归档 PR-5 / PR-6 handoff
- pytest ≥ 650 不掉
- 不动 db schema / 不动 10 个 CLI group / 不动退出码 / 不动 .sh

可选 (nice-to-have):
- 把 4 个被 CLI 依赖的 module 迁到 src/{init,cleanup}/（CLI import 路径改）

工作流 (同 PR-5 严格分工):
- Claude: 规划 + 分解 + commit + 文档
- Codex: 写代码（每个 thin wrapper 删除 + 文档更新 + 测试调整都委托 codex）
- 通过 collaborating-with-codex skill (codex_bridge.py --sandbox workspace-write)
  调用 codex CLI, 不要用 codex:codex-rescue subagent

完成 = pytest ≥ 650 + thin wrapper 全删除 + 文档收口 + codex critic APPROVE +
ai-slop-cleaner pass + post-deslop regression 全绿。
```

---

## 4. 已知风险 / 缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 用户脚本调用 `python scripts/backfill_email_body.py` 后突然找不到 | 中 | 4 周 release window；PR-5 已发布 deprecation warning 至少 2 周 |
| CLI 反向 import 链断（CLI import `scripts.initial_sync`）| 高 | PR-6 §2.1 列出 4 个保留 module；其他 7 个可放心删；用 grep 校验依赖 |
| 移到 `src/init/` 的可选迁移让 import 一次性大改 | 中 | 不做这步也能完成 PR-6；只做 2.1 thin wrapper 删除是安全最小集 |

---

## 5. 不在 PR-6 范围（PR-7+）

- `db_version` 升 7：未来需求（LLM cache 表 / 反向 sync 队列）才动
- 删 `scripts/__init__.py`：仅当 2.2 module 迁移完成后才可删
- CLI 新加命令：PR-5 contract 冻结，新加另开 PR
- 重构 `src/cli/long_task.py` / `pm2_check.py`：PR-4 ship 稳定，没需求别动

详见 [agent-cli-rfc.md](./agent-cli-rfc.md) §10.6 / §10.7。

---

## 6. PR-5 → PR-6 cleanup 命令清单（参考）

```bash
# 已确认 CLI 不依赖的 7 个 thin wrapper → 直接删
git rm scripts/backfill_email_body.py
git rm scripts/backfill_derivatives.py
git rm scripts/sync_project_progress.py
git rm scripts/compare_llm_path.py
git rm scripts/run_llm_on_email.py
git rm scripts/resync_notion.py
git rm scripts/replay_recurring_invite.py

# CLI 依赖的 4 个 module → 用编辑器删 __main__ 块（保留 class / functions）
# scripts/initial_sync.py 末尾删 main() + asyncio.run + DeprecationWarning
# scripts/cleanup_syncstore.py 末尾删 main()
# scripts/cleanup_duplicate_message_ids.py 末尾删 main() + asyncio.run
# scripts/cleanup_notion_db.py 末尾删 main() + asyncio.run

# 校验
grep -rn "from scripts\." src/ tests/ main.py *.py | grep -v "scripts.__init__"
# 期望: 只剩 scripts.initial_sync / cleanup_syncstore / cleanup_duplicate_message_ids /
# cleanup_notion_db 的引用

pytest tests/ -q --tb=no | tail -2
```

---

> 本 handoff 是 PR-5 ship 时同步起草（commit `<PR-5 末位>`）。PR-6 实际启动时间
> 由用户决定（推荐 PR-5 ship 后 2-4 周）。
