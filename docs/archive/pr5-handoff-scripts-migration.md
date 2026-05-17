# PR-5 Handoff: scripts/ 迁移 + PR-3 stub 实现 + thin wrapper deprecation

> **Mission**: 在 PR-4 ship 后, 把 `scripts/*` (~44 个文件) 整体迁进 `src/cli/` (R-05 + D2),
> 同时把 PR-3 / PR-4 留下的 stub 命令补真实现 (不再 subprocess wrap).
>
> **前置文档**:
> - [`agent-cli-rfc.md`](./agent-cli-rfc.md) §9 (scripts 迁移表) / §10.5 (PR-5 范围)
> - [`pr4-handoff-cli-batch.md`](./pr4-handoff-cli-batch.md) — PR-4 原 spec + PR-3 stub 清单
> - PR-4 ship 报告 (progress.txt 末尾段)

---

## 1. PR-4 ship 报告 (PR-5 起点)

| 项 | 状态 |
|---|---|
| git branch | main, clean |
| pytest 基线 | **610 passed** (PR-3 489 + PR-4 121) |
| `mailagent --version` | 3.0.0 |
| CLI 子命令 | 10 groups: email / admin / attachment / llm / notion / calendar / debug + backfill + project-progress + init |
| `docs/cli-schema/` | ~45 schemas + `_common.schema.json` + `error-codes.md` (11 个 `E_*` enum 含 `E_PM2_RUNNING` / `E_MAX_FAILURES`) |
| `data/sync_store.db` `db_version` | 6 (PR-4 升级了 + 加 `cli_checkpoints` + `v4_rollout_stats` 表) |
| pm2 mail-sync | 用户决定何时启动 (PR-4 加了 PM2 检测; 启动后 60s 内会写第一条 v4_rollout 快照) |
| 退出码体系 | 完整 (0/1/2/4/5/6/7/8/9/130), 每个 branch 有单测覆盖 |

**PR-4 critic 留下的 follow-ups / non-blocking deferred**:

1. `llm compare-paths` 非 dry-run **stub** (PR-3 / PR-4 都没接) — 用 `scripts/compare_llm_path.py` 临时替代
2. `notion page-orphans` 非 dry-run repair **stub** (PR-3 / PR-4 都没接)
3. `notion file-link-audit` 非 dry-run repair **stub**
4. `calendar expand` 非 dry-run **stub** (`_meeting_expansion_loop` 仍在 main.py 跑)
5. `attachment derive` 真 alias 没硬连到 `backfill derivatives` (改成 alias 还是 deprecation warning?)
6. `backfill body / derivatives` 现在是 subprocess wrap, PR-5 应直接迁逻辑进 CLI 模块 (handoff §2.4 commit 5 风险表批准的临时方案)
7. `project-progress sync` 同上, subprocess wrap → 直接迁
8. `init` 7 个 sub-action 同上, subprocess wrap → 直接迁
9. `admin cleanup-syncstore / cleanup-duplicates / repair-parents` 同上, subprocess wrap

---

## 2. PR-5 范围

### 2.1 scripts/* 迁移 (R-05 + D2)

按 RFC §9 表:

| 当前路径 | 迁移到 | 处置 |
|---|---|---|
| `scripts/initial_sync.py` | 已有 `src/cli/commands/init.py` (subprocess wrap) → 内联实现 | thin wrapper 保留, 加 deprecation warning |
| `scripts/run_llm_on_email.py` | 已有 `src/cli/commands/llm.py` `llm run` → 共享代码 | thin wrapper 保留 |
| `scripts/backfill_email_body.py` | 已有 `src/cli/commands/backfill.py` (subprocess wrap) → 内联 | thin wrapper |
| `scripts/backfill_derivatives.py` | 同上 | thin wrapper |
| `scripts/sync_project_progress.py` | 已有 `src/cli/commands/project_progress.py` (subprocess wrap) → 内联 | thin wrapper |
| `scripts/cleanup_syncstore.py` | 已有 admin `cleanup-syncstore` (subprocess wrap) → 内联 | thin wrapper |
| `scripts/cleanup_duplicate_message_ids.py` | 同上 cleanup-duplicates | thin wrapper |
| `scripts/cleanup_notion_db.py` | 同上 repair-parents | thin wrapper |
| `scripts/compare_llm_path.py` | 新内联到 `src/cli/commands/llm.py` `compare-paths` 真实现 | thin wrapper |
| `scripts/replay_recurring_invite.py` | 已有 `src/cli/commands/calendar.py` (PR-3 ship) → 共享代码 | thin wrapper |
| `scripts/resync_notion.py` | 已有 `src/cli/commands/email.py` `email resync` (PR-2 ship) → 共享代码 | thin wrapper |
| `scripts/manual_sync.py` | 迁到 `mailagent debug manual-sync` | thin wrapper |
| `scripts/debug_*.py` (10+ 个) | 已有 `src/cli/commands/debug.py` (PR-3 ship) → 共享代码 | thin wrapper |
| `scripts/check_*.py` / `test_*.py` (~15 个) | 迁到 `scripts/dev/` | git mv |
| `scripts/archive_*.py` (旧一次性 migration) | 迁到 `scripts/archive/` | git mv |
| `scripts/*.sh` (deploy / toggle 等) | 保留顶层 | 不动 |

### 2.2 PR-3 / PR-4 stub 补真实现

#### 2.2.1 `llm compare-paths` (RFC §4.4)

当前 stub 返回 `E_NOT_IMPLEMENTED`。需求:

- 对 N (默认 20) 封随机邮件分别走两条路径喂 LLM:
  - 路径 A: SQLite markdown 路径 (新, v4 SSoT)
  - 路径 B: in-memory 正则路径 (老)
- diff AILabels 输出, 量化两条路径分类一致率
- `--internal-ids LIST` 覆盖 `--count N`
- `-o json` 每封 diff 详情

实现路径: 把 `scripts/compare_llm_path.py` 的逻辑迁进 `src/cli/commands/llm.py`,
分享 LLMRunner.run 内部 (传不同 `body_source_override` 参数).

#### 2.2.2 `notion page-orphans` 非 dry-run repair

需求: 扫到 Notion 有 page 但 SQLite 无 metadata 时, 选项:
- `--archive-orphan-pages --yes`: 在 Notion 上 archive 这些孤儿 page
- `--insert-stub-metadata --yes`: 在 SQLite 创建 stub email_metadata 行 (sync_status='dead_letter') 让用户后续处理

#### 2.2.3 `notion file-link-audit` 非 dry-run

需求: 扫 email_attachment.notion_file_id NULL 但 Notion 有 file block → 上传 (重新上传 + 回写)
死链 → 移除 / archive

#### 2.2.4 `calendar expand` 非 dry-run

需求: 把 main.py `_meeting_expansion_loop` 抽 `src/calendar_notion/expansion.py:run_expansion_tick`,
CLI 调一次后立即返回 (不 long-running).

#### 2.2.5 `attachment derive` alias

改成真 alias: 内部直接调 `backfill derivatives --internal-id <id>` 等价路径.
加 deprecation warning 提示用 `backfill derivatives`.

### 2.3 thin wrapper deprecation 阶段

PR-5 完成时所有 `scripts/*` (除 dev/ archive/ shell) 都是 thin wrapper:

```python
#!/usr/bin/env python3
"""DEPRECATED — use ``mailagent <new-command>`` instead.

This wrapper will be removed in PR-6 (release window 2-4 weeks after PR-5 ship).
"""
import sys
import warnings

warnings.warn(
    "scripts/foo.py is deprecated; use 'mailagent foo' instead. "
    "Will be removed in PR-6.",
    DeprecationWarning,
)
from src.cli.main import app
app(["foo", *sys.argv[1:]])
```

PR-6 (4 周后) 删除所有 thin wrappers, 文档全文 update.

### 2.4 实施拆分 (建议 10-12 commits)

1. **Commit 1**: backfill body/derivatives 内联实现 (从 scripts/backfill_*.py 迁) + 删 subprocess wrap
2. **Commit 2**: project-progress sync 内联 (从 scripts/sync_project_progress.py 迁)
3. **Commit 3**: init 7 个 sub-action 内联 (从 scripts/initial_sync.py 迁)
4. **Commit 4**: admin cleanup-syncstore/cleanup-duplicates/repair-parents 内联
5. **Commit 5**: llm compare-paths 真实现 (内联 + dry-run plan + 实跑)
6. **Commit 6**: notion page-orphans 真修复路径
7. **Commit 7**: notion file-link-audit 真修复路径
8. **Commit 8**: calendar expand 真实现 (抽 expansion module)
9. **Commit 9**: attachment derive 真 alias
10. **Commit 10**: scripts/*.py 全部改为 thin wrapper + git mv check_*/test_* 到 scripts/dev/
11. **Commit 11**: scripts/archive_*.py 迁到 scripts/archive/
12. **Commit 12**: pytest 回归 + CLAUDE.md 更新 + PR-5 ship report + PR-6 handoff

**预估**: 3-5 天 (主要是 5 个 stub 实现需要 LLM / Notion API 集成测试)

### 2.5 验收

```bash
pip install -e ".[cli,dev]"

# pytest 全过
pytest tests/ -q --tb=no | tail -2
# 期望 ≥ 650 passed (PR-4 610 + PR-5 ≥ 40)

# DB 不变 (PR-5 不动 schema)
sqlite3 data/sync_store.db "SELECT value FROM sync_state WHERE key='db_version'"  # 6

# 老 script 仍可调 (deprecation warning) → 同结果
python scripts/initial_sync.py --action fetch-cache --inbox-count 100
# 期望 stderr warning + 内部走 mailagent init fetch-cache

# 新 CLI 不走 subprocess
mailagent backfill body --dry-run --limit 5 -o json | jq .data.mode
# 期望: "inline" (不再是 "subprocess")

# 5 个 stub 都接通
mailagent llm compare-paths --count 10
mailagent notion page-orphans --archive-orphan-pages --yes
mailagent notion file-link-audit --no-dry-run --yes
mailagent calendar expand --horizon-weeks 4
mailagent attachment derive 53677  # 应直接调 backfill 逻辑
```

---

## 3. 跨 PR-4 → PR-5 约束

- **不破坏 PR-4 已 ship 接口**: 10 个命令 group 不变, 全局 flags 不变, 退出码不变
- **不破坏 schema 契约**: 现有 45+ schema 文件保持向后兼容, 新加字段必须 optional
- **db_version 不变**: PR-5 不动 SQLite schema (PR-6 也不动, PR-7 才考虑 v7)
- **PM2 检测保留**: 写命令默认 PM2 detect; `--allow-concurrent` / env 仍可绕过
- **退出码体系冻结**: 0/6/7/8/9/130 不再加新值
- **thin wrapper 是合同**: 不删 scripts/*.py 入口, 但内部转发到 mailagent

---

## 4. 风险 / 缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 内联实现 (从 scripts/) 改变行为 | 中 | 加 e2e test 对比旧 script vs 新 CLI 输出 (`scripts/check_pr5_parity.py`); diff > 5% 时报警 |
| LLM compare-paths 内联耗费 cost | 中 | dry-run 默认; 真跑需 `--yes`; 加 cost preview |
| notion page-orphans 真修复误删 | 高 | dry-run 默认; `--archive` (不删) 优先于 `--delete`; 加 `--max-pages N` 上限 |
| calendar expand 抽 module 引入 bug | 中 | main.py 仍调老 loop, CLI 用新 module; 两者并存 1 release |
| thin wrapper 部署后第三方调用断 | 低 | 4 周 deprecation window, PR-5 ship 后向用户公告 |

---

## 5. PR-5 启动 prompt (新 session)

```
/oh-my-claudecode:ralph --critic=codex 实施 RFC v2 PR-5: scripts/* 迁移 + 5 个 stub 补真实现 + thin wrapper deprecation

前置文档 (按顺序读):
1. docs/pr5-handoff-scripts-migration.md (本文档, 含 PR-4 ship 报告 + 12 commit 拆分 + 验收 + 风险)
2. docs/agent-cli-rfc.md §9 / §10.5 (scripts 迁移表 + PR-5 范围)
3. docs/pr4-handoff-cli-batch.md (PR-4 spec, 含 PR-3 stub 清单)
4. progress.txt 末尾 PR-4 ship 段 (含 12 stories + 610 passed + DB 6)

PRD scaffold 用本文档 §2.4 的 12 commits 作为 12 user stories:
- US-001..US-004: 内联 backfill / project-progress / init / admin cleanup (从 subprocess wrap → inline)
- US-005..US-009: 5 个 stub 真实现 (llm compare-paths / notion page-orphans /
  notion file-link-audit / calendar expand / attachment derive)
- US-010: thin wrapper 化 scripts/*.py
- US-011: scripts/dev + scripts/archive 整理
- US-012: 回归 + CLAUDE.md + PR-5 ship report + PR-6 handoff

关键约束:
- 不破坏 PR-4 已 ship 的 10 组 CLI + 45 schema + 退出码体系
- 不动 sync_store.db schema (db_version 仍 6)
- thin wrappers 必须保留 (PR-6 才删)
- pytest ≥ 650 passed (PR-4 610 + PR-5 ≥ 40)
- 每个 stub 真实现必须有 e2e test (含 Notion API mock)
- 不动 main.py 主循环 (calendar expand 抽 module 不改 loop 调用)

关键决策:
- compare-paths 默认 dry-run; 实跑需 `--yes` + cost preview (避免误烧 token)
- page-orphans 默认 archive 而非删除 (Notion 上 archive 可恢复, 删除不可)
- file-link-audit 默认上传修复 (NULL → upload), 死链才删
- attachment derive 改 alias 而非删 (向后兼容)
- thin wrapper 用 warnings.warn + ``DeprecationWarning``, 不强制 stderr 显示

Final critic 用 codex: ralph Step 7 自动调
  omc ask codex --agent-prompt critic
给它:
  (a) prd.json 12 个 stories 的 acceptance criteria
  (b) 改动文件 + 相关文件 (scripts/* + src/cli/* + src/notion/* + src/llm_agent/*)
  (c) optimality 问题: "Is there a meaningfully simpler approach? 内联 vs 共享 helper 函数?"

完成 = 全 stories passes:true + codex critic APPROVE + ai-slop-cleaner deslop +
post-deslop regression 全绿 (≥ 650 passed)。

实操步骤 (睡前):
1. 开新 session (/clear 或新 terminal)
2. 复制上面整段 prompt 粘贴
3. backfill 继续后台跑 (PR-5 改 backfill, 但 thin wrapper 还可调)
4. pm2 mail-sync 保持 stopped (一些迁移会动 SQLite)
5. 早上回来检查:
   git log --oneline 7b4fec7..HEAD            # 期望 PR-4 12 + PR-5 ≥ 10 个 commit
   pytest tests/ -q --tb=no | tail -2          # 期望 ≥ 650 passed
   mailagent backfill body --dry-run --limit 5 -o json | jq .data.mode
   # 期望 "inline" (不再 "subprocess")
   cat scripts/initial_sync.py | head -5       # 期望 thin wrapper + DeprecationWarning
```

---

## 6. 完成检查清单

PR-5 ship 前必须 ✅:

- [ ] backfill / project-progress / init / admin cleanup-* 5 个命令组全部内联 (不再 subprocess wrap)
- [ ] llm compare-paths / notion page-orphans / file-link-audit / calendar expand / attachment derive 5 个 stub 全部接通
- [ ] scripts/*.py 全部改为 thin wrapper + DeprecationWarning
- [ ] scripts/{dev,archive} 子目录建好, 旧 debug/migration 脚本 git mv 进去
- [ ] pytest ≥ 650 passed
- [ ] CLAUDE.md "PR-4 (当前)" → "PR-5 (当前)", 移除 stub 说明
- [ ] 所有 stub 的非 dry-run 路径有 e2e test
- [ ] 旧 script 调用回归测试: `python scripts/initial_sync.py --action all --inbox-count 0 --sent-count 0 --yes` 等价 `mailagent init all --yes --inbox-count 0 --sent-count 0`
- [ ] codex critic APPROVE + ai-slop-cleaner pass + post-deslop regression 全绿

---

## 7. PR-6 / PR-7 预告

| PR | 范围 | 预估 |
|---|---|---|
| **PR-6** | thin wrapper deprecation cleanup — 删 `scripts/*.py` thin wrappers (除 shell), 不再 mention 老脚本 | 0.5 天 |
| **PR-7 (未来)** | sync_store.db v7? — 待具体需求决定 (LLM cache 表? 反向 sync 队列表?) | TBD |

详见 RFC §10.6 / §10.7.

---

> 本 handoff 由 RFC v2 §9 / §10.5 + PR-4 ship 报告派生. PR-4 已 ship 12 stories, 610 passed,
> codex critic APPROVE. 等 PR-5 ship + merge 后, PR-6 handoff 另开.
