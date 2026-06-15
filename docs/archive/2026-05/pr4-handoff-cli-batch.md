# PR-4 Handoff: CLI Batch 命令 + 长任务契约 + R-06 v4_rollout 持久化

> **Mission**: 在 PR-3 (CLI 完整 7 组命令 ship) 基础上, 实施 RFC v2 §4.2 (batch flags) / §4.5 / §4.7 / §4.9 / §5 长任务契约 / §8 R-06 v4_rollout 持久化. 共 6 个 batch 命令 + 长任务退出码体系 + DB_VERSION 5→6 migration + v4_rollout in-memory counter + flush loop.
>
> **前置文档**:
> - [`agent-cli-rfc.md`](./agent-cli-rfc.md) — RFC v2 (§4 命令树 / §5 通用约定 / §8 v4 rollout / §10 PR 拆分)
> - [`pr3-handoff-cli-rest.md`](./pr3-handoff-cli-rest.md) — PR-3 原 spec + §3 PR-4 spec 雏形
> - [`pr2-handoff-cli-mvp.md`](./pr2-handoff-cli-mvp.md) — PR-2 CLI 骨架
> - [`../CLAUDE.md`](../CLAUDE.md) — 项目总指南 (含 PR-3 CLI 章节)

---

## 1. PR-3 ship 报告 (PR-4 起点)

| 项 | 状态 |
|---|---|
| git branch | main, clean |
| 最近 PR-3 commits | `c1f11b0` `aee4544` `855f9e8` `fbf5cdc` `6d739ed` `98b7d28` (6 commits, 9 stories) |
| pytest 基线 | **487 passed** (PR-2 370 + PR-3 117 = 487) |
| `pip install -e ".[cli,dev]"` | OK; `mailagent --version` → 3.0.0 |
| CLI 子命令 | 7 groups: email / admin / attachment / llm / notion / calendar / debug |
| `docs/cli-schema/` | 30 schema + `_common.schema.json` + `error-codes.md` (9 个 `E_*` enum) |
| `CLAUDE.md` | CLI 章节列 20+ 子命令, 拆"读"/"写"两组 |
| `data/sync_store.db` `db_version` | 5 (PR-4 需升 6 加 `v4_rollout_stats` + `cli_checkpoints` 表) |
| pm2 mail-sync | stopped (与 PR-3 同) |
| 依赖更新 | `jsonschema>=4.18` + `referencing>=0.30` 已收紧 |

**PR-3 critic 留下的 non-blocking follow-ups** (待 PR-4 跟进):
1. `llm compare-paths` 非 dry-run 实跑 (R-15 灰度质量闸完整闭环, 当前临时用 `scripts/compare_llm_path.py`)
2. `attachment derive` 非 dry-run → 改为 `backfill derivatives` alias (PR-4)
3. `notion page-orphans` 修复路径 (PR-4 `admin repair-*` 系列)
4. `notion file-link-audit` 修复路径 (PR-4)
5. `calendar expand` 非 dry-run 实跑 (从 main.py 抽 `_run_expansion_tick` 成独立 helper)

---

## 2. PR-4 — Batch 命令 + 长任务契约 (RFC §4 / §5 / §8)

### 2.1 范围

| 命令组 | 子命令 | RFC § | 长任务? |
|---|---|---|---|
| **email resync (batch 扩展)** | `--range / --ids / --max-failures / --resume-from / --progress-every` | §4.2 | 是 |
| **backfill** | `body / derivatives` | §4.5 | 是 |
| **project-progress** | `sync` | §4.7 | 是 |
| **init** | `fetch-cache / analyze / fix-properties / fix-critical / update-parents / sync-new / all` | §4.9 | 是 |
| **admin** | `dead-letter list / retry / cleanup` | §4.8 | — |
| **admin** | `cleanup-syncstore / cleanup-duplicates / repair-parents` | §4.8 | 是 (写 SQLite) |
| **admin stats v4_rollout** | 真实数据 (R-06 持久化) | §4.8 / §8 | — |

### 2.2 长任务契约 (RFC §5)

新增 `src/cli/long_task.py` 共用 mixin / 装饰器:

```python
class LongTaskContext:
    """SIGINT 二次语义 + max-failures 熔断 + checkpoint."""

    # 状态机:
    #   running → sigint_first_received → aborted (current unit 跑完后退出 130)
    #   running → sigint_second_received → sys.exit(130) 立即退
    #   running → max_failures_hit → exit 8
    #   running → pm2_conflict_detected → exit 9
    #   running → all_done → exit 0 (或 partial_failure → exit 6)
```

**退出码细分** (RFC §5.2):
- `0` 全 OK
- `6` `partial_failure` (含 failed list + summary)
- `7` SIGINT 第一次后正常退出 (aborted)
- `8` 连续失败 > `--max-failures` 熔断
- `9` PM2 mail-sync 正在跑 (写命令冲突, 默认拒)
- `130` SIGINT 二次强退

**PM2 检测** (写命令必须):

```python
def _check_pm2_conflict(cli, *, allow_concurrent: bool = False) -> None:
    """写类 batch 命令启动前检测 PM2 mail-sync 是否在跑."""
    if allow_concurrent or os.environ.get("MAILAGENT_CLI_ALLOW_CONCURRENT") == "true":
        return
    try:
        result = subprocess.run(
            ["pm2", "jlist"], capture_output=True, text=True, timeout=5,
        )
        for proc in json.loads(result.stdout or "[]"):
            if proc.get("name") == "mail-sync" and proc.get("pm2_env", {}).get("status") == "online":
                raise emit_cli_error(cli, CliError(
                    "PM2 mail-sync is running; concurrent writes may corrupt SyncStore.",
                    code="E_PM2_RUNNING",
                    exit_code=9,
                    hint="Stop pm2 first (pm2 stop mail-sync) or pass --allow-concurrent",
                ))
    except (FileNotFoundError, json.JSONDecodeError, subprocess.TimeoutExpired):
        return
```

**Checkpoint / resume**:

```sql
-- DB_VERSION 5 → 6 (新增表)
CREATE TABLE cli_checkpoints (
    command TEXT NOT NULL,
    target_kind TEXT NOT NULL,       -- 'range' / 'ids' / 'all'
    target_key TEXT NOT NULL,        -- '53000-53100' / ...
    last_completed_internal_id INTEGER,
    succeeded INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    aborted_at REAL,
    PRIMARY KEY (command, target_key)
);
```

每 N (默认 50) 个 unit 写一次. `--resume-from N` 从 `internal_id >= N` 续跑.

**进度回报**:
- text mode: `rich.progress.Progress` 显示 `[INTERNAL_ID 53050 / 53100]  87%  3/min  ETA 5m`
- ndjson: 每 unit 一行 `{internal_id, status, error?, duration_ms}` + 末行 `_meta`

### 2.3 R-06 v4_rollout 持久化

PR-3 admin stats 的 `v4_rollout` 段仍是 `_source: not_implemented_in_pr2`. PR-4 落地 (RFC §8 选项 A):

```sql
-- DB_VERSION 6 新表
CREATE TABLE v4_rollout_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flushed_at REAL NOT NULL,
    from_sqlite_hit INTEGER DEFAULT 0,
    fallback_miss INTEGER DEFAULT 0,
    fallback_error INTEGER DEFAULT 0,
    route_latency_p99_ms REAL DEFAULT 0,
    body_miss_internal_ids TEXT     -- JSON list, 最近 10 个
);
CREATE INDEX idx_v4_rollout_flushed_at ON v4_rollout_stats(flushed_at DESC);
```

`src/notion/sync.py` 加 in-memory counter (`_route_hit / _route_miss / _route_error`); 每分钟 `_flush_v4_stats()` 异步 task (在 `new_watcher` 主循环里) 写表. `admin stats` 读最新 row + `_snapshot_at`.

### 2.4 实施拆分 (9-12 commits)

1. **Commit 1**: DB_VERSION 5 → 6 migration + `cli_checkpoints` + `v4_rollout_stats` 表 + tests/mail/test_sync_store_v6_migration.py
2. **Commit 2**: `src/cli/long_task.py` (SIGINT 二次 / max-failures 熔断 / checkpoint / progress) + 单测
3. **Commit 3**: `src/cli/pm2_check.py` (mock subprocess + `--allow-concurrent` opt-in)
4. **Commit 4**: `email resync` 加 batch flags
5. **Commit 5**: `backfill body / derivatives` (替换 `scripts/backfill_email_body.py` + `scripts/backfill_derivatives.py` 入口)
6. **Commit 6**: `project-progress sync` (含 7 个 sub-flag)
7. **Commit 7**: `init fetch-cache / analyze / fix-properties / fix-critical / update-parents / sync-new / all`
8. **Commit 8**: R-06 v4_rollout 持久化 (counter + flush + admin stats 真实数据)
9. **Commit 9**: `admin dead-letter list/retry`, `admin cleanup-deadletter`, `admin cleanup-syncstore/duplicates`, `admin repair-parents`
10. **Commit 10**: 长任务测试套件 (SIGINT/SIGTERM, 熔断, checkpoint resume, PM2 检测, partial_failure schema)
11. **Commit 11**: schema 文件落位 (~15 新文件) + contract test 覆盖
12. **Commit 12**: 综合回归 + CLAUDE.md CLI 章节扩补 (加 PR-4 命令 + 退出码表) + PR-3 follow-ups (compare-paths 实跑等)

### 2.5 schema 文件清单 (新加 ~15 个)

```
docs/cli-schema/
├── email-resync-batch.schema.json         # partial_failure wrapper 扩展
├── backfill-body.schema.json
├── backfill-derivatives.schema.json
├── project-progress-sync.schema.json
├── init-fetch-cache.schema.json
├── init-analyze.schema.json
├── init-fix-properties.schema.json
├── init-fix-critical.schema.json
├── init-update-parents.schema.json
├── init-sync-new.schema.json
├── init-all.schema.json
├── admin-dead-letter.schema.json
├── admin-cleanup.schema.json
├── admin-repair-parents.schema.json
└── admin-stats-v4-rollout.schema.json     # extends existing admin-stats with real v4 data
```

### 2.6 验收

```bash
pip install -e ".[cli,dev]"

# DB migration
sqlite3 data/sync_store.db "SELECT value FROM sync_state WHERE key='db_version'"  # 期望 6
sqlite3 data/sync_store.db ".tables" | grep -E "cli_checkpoints|v4_rollout_stats"

# 长任务契约
mailagent email resync --range 53000-53010 --dry-run
# 期望: rich progress bar + 末尾 summary

mailagent email resync --range 53000-53100 --max-failures 5
# (mock 失败超 5): exit 8 + E_MAX_FAILURES

# SIGINT 二次
mailagent backfill body --since-date 2026-03-01 &
sleep 2 && kill -INT $! ; sleep 2 && kill -INT $!
# 期望 exit 130

# Checkpoint resume
mailagent email resync --range 53000-53100 ... # 跑到 53050 死掉
mailagent email resync --range 53000-53100 --resume-from 53051

# PM2 检测
pm2 start mail-sync && mailagent email resync 53675
# 期望 exit 9 + E_PM2_RUNNING + hint

mailagent email resync 53675 --allow-concurrent

# R-06 v4_rollout 持久化
pm2 start mail-sync  # 跑 5 min
mailagent admin stats --section v4_rollout -o json | jq '.data.v4_rollout'
# 期望 from_sqlite_hit > 0, _source: stats_reporter_last_snapshot, _snapshot_at 不 stale

# pytest
pytest tests/ -q --tb=no
# 期望 ≥ 540 passed (PR-3 487 + PR-4 ≥ 50)
```

**预估**: 3-4 天 (含 SIGINT race / PM2 mock / checkpoint 边界 case).

---

## 3. 跨 PR-3 → PR-4 约束

- **不破坏 PR-3 接口**: 5 个新 typer App 注册顺序 + 命令树不变
- **不破坏 PR-2 / PR-3 schema 契约**: 已存在 30 个 schema 文件保持向后兼容; 新加 wrapper 必走 `_common.schema.json` $ref
- **db_version 升级安全**: 5→6 migration 幂等 + 现有 6131 封邮件不丢; 准备 rollback SQL (drop 新表)
- **PM2 检测必须可绕过**: 测试 / 内部脚本 / 灰度场景需 `--allow-concurrent` 或 env `MAILAGENT_CLI_ALLOW_CONCURRENT=true`
- **pytest tmp_path 隔离**: 所有 CLI batch 测试用 tmp SQLite, 不动 `data/sync_store.db`
- **不动 scripts/***: PR-5 才动 (PR-4 期间 scripts 与 CLI 并存; backfill 命令首版可走 subprocess 包装老脚本)
- **PR-3 stub 命令补真实现**: `attachment derive` / `llm compare-paths` / `notion page-orphans` / `notion file-link-audit` / `calendar expand` 非 dry-run 路径

---

## 4. 风险 / 缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| SIGINT 二次语义在 asyncio 下不直观 | 中 | `signal.SIGINT` 注册 + `asyncio.shield` 包裹 current unit; 单测用 `task.cancel()` 模拟 |
| PM2 检测 false positive | 低 | `FileNotFoundError` graceful skip + log warning; `--allow-concurrent` opt-in |
| `cli_checkpoints` 跨命令冲突 (两个 `email resync` 同 key 同时跑) | 中 | PK `(command, target_key)`; 启动时检测 + `--force-restart` flag |
| v4_rollout flush loop 影响 watcher 性能 | 低 | flush 一次 ~1ms; 每分钟一次; `asyncio.create_task` fire-and-forget |
| `init` 命令与 `scripts/initial_sync.py` 行为漂移 | 中 | 第一版 CLI 直调脚本 (subprocess) + 慢慢迁移; 加 e2e test 对比输出 |
| PR-3 stub 命令补实现可能漏 schema 更新 | 低 | schema_contract test 自动 catch (additionalProperties:false 会触发 fail) |

---

## 5. 启动 prompt (PR-4 新 session 复制粘贴)

**推荐模式: ralph + `--critic=codex`** (与 PR-3 / PR-2 一致, 适合"睡前挂"):

```
/oh-my-claudecode:ralph --critic=codex 实施 RFC v2 PR-4: CLI batch 命令 + 长任务契约 + R-06 v4_rollout 持久化

前置文档 (按顺序读):
1. docs/pr4-handoff-cli-batch.md (本文档, 含 PR-3 ship 报告 + 12 commit 拆分 + 验收 checklist + 风险)
2. docs/agent-cli-rfc.md §4.2 / §4.5 / §4.7 / §4.8 / §4.9 / §5 / §8 (RFC 原文)
3. docs/pr3-handoff-cli-rest.md §3 (PR-4 spec 雏形, 本 handoff 已合并)
4. docs/pr2-handoff-cli-mvp.md (CLI 骨架基础)

PRD scaffold 时把本 handoff §2.4 的 12 个 commit 作为 12 个 user stories:
- US-001: Commit 1 — DB_VERSION 5→6 + cli_checkpoints + v4_rollout_stats 表 + migration test
- US-002: Commit 2 — src/cli/long_task.py 共用 (SIGINT 二次 / 熔断 / checkpoint / progress)
- US-003: Commit 3 — src/cli/pm2_check.py (mock subprocess)
- US-004: Commit 4 — email resync 加 batch flags (--range / --ids / --max-failures / --resume-from / --progress-every)
- US-005: Commit 5 — backfill body / derivatives
- US-006: Commit 6 — project-progress sync (7 sub-flags)
- US-007: Commit 7 — init 7 个 sub-action
- US-008: Commit 8 — R-06 v4_rollout 持久化 (counter + flush + admin stats 真实数据)
- US-009: Commit 9 — admin dead-letter + cleanup-* + repair-parents
- US-010: Commit 10 — 长任务测试套件 (SIGINT/SIGTERM/熔断/resume/PM2/partial_failure schema)
- US-011: Commit 11 — schema 文件落位 (~15 新) + contract test
- US-012: Commit 12 — 综合回归 + CLAUDE.md CLI 章节 + PR-3 stub 补真实现 (compare-paths / calendar expand 等)

每个 story 的 acceptance criteria 来自本 handoff §2.6 + RFC § 引用 + PR-3 已 ship 的契约。

关键约束:
- PR-4 不破坏 PR-3 已 ship 的 7 组 CLI 子命令 + 30 个 schema
- 不动 scripts/* (PR-5 范围)
- 完成时 pytest ≥ 540 passed (PR-3 487 + PR-4 ≥ 53)
- DB_VERSION 5→6 migration 幂等 + rollback SQL 就位
- 长任务退出码体系 (0/6/7/8/9/130) 完整, 单测覆盖每个 exit branch
- PM2 检测可被 --allow-concurrent / env 绕过 (测试和灰度需要)
- 所有 batch 命令默认 require_auth(); --dry-run 跳过

关键决策 (已批准默认值, 无需 AskUserQuestion):
- 长任务 progress 默认每 50 unit 写 checkpoint + 显示进度
- partial_failure (exit 6) 仅当 ≥1 succ + ≥1 fail; 全 fail 走 max-failures 路径 (exit 8)
- v4_rollout flush 间隔 60s, 命中阈值阈值无 (任何 hit/miss 都计)
- backfill 命令第一版 CLI 可走 subprocess 包装 scripts/backfill_*.py, 后续 PR 平迁
- init 7 个 sub-action 完整复刻 scripts/initial_sync.py --action 全集, 不漂移行为
- E_PM2_RUNNING (exit 9) + E_MAX_FAILURES (exit 8) + E_ABORTED (exit 7) 是新加 code

Final critic 用 codex: ralph Step 7 自动调
  omc ask codex --agent-prompt critic
给它:
  (a) prd.json 12 个 stories 的 acceptance criteria
  (b) 改动文件 + 相关文件 (callers / callees / shared types)
  (c) optimality 问题: "是否存在更简单/快速/可维护的实现路径达到同样 acceptance criteria?"

完成 = 全 stories passes:true + codex critic APPROVE + ai-slop-cleaner deslop +
post-deslop regression 全绿 + 用户已收到 final summary。
```

**实操步骤 (睡前)**:

1. 开新 session (`/clear` 或新 terminal)
2. 复制上面整段 prompt 粘贴
3. backfill 继续后台跑 (与 PR-4 无冲突 — PR-4 不动 scripts/backfill_*.py)
4. pm2 mail-sync 保持 stopped
5. 早上回来检查:
   ```bash
   git log --oneline 98b7d28..HEAD                       # 期望 ≥ 10 个 PR-4 commit
   pytest tests/ -q --tb=no | tail -2                    # 期望 ≥ 540 passed
   sqlite3 data/sync_store.db "SELECT value FROM sync_state WHERE key='db_version'"  # 期望 6
   sqlite3 data/sync_store.db ".tables" | grep -E "cli_checkpoints|v4_rollout_stats"
   mailagent backfill body --dry-run --limit 10 -o json  # 长任务契约
   cat .omc/state/sessions/*/prd.json | jq '.stories[] | {id,title,passes}'
   tail -100 progress.txt
   ```

---

## 6. 完成检查清单

PR-4 ship 前必须 ✅:
- [ ] DB_VERSION 5 → 6 migration 通过, 现有 6131 封邮件不丢
- [ ] `cli_checkpoints` + `v4_rollout_stats` 表存在
- [ ] 6 个 batch 命令就位 (email resync batch / backfill body+derivatives / project-progress sync / init / admin cleanup-*)
- [ ] 长任务契约 (SIGINT 二次 / max-failures / PM2 检测 / checkpoint) e2e 测试通过
- [ ] R-06 v4_rollout 持久化跑通 (pm2 start 5 min 后 admin stats 真实 hit > 0)
- [ ] `mailagent --help` 列 7 组命令 + 完整 batch flags
- [ ] pytest ≥ 540 passed
- [ ] CLAUDE.md "长任务退出码"表新增 (0/6/7/8/9/130) + PR-4 命令章节
- [ ] PR-3 5 个 stub 命令的非 dry-run 路径全部接通 (attachment derive / llm compare-paths / notion page-orphans / file-link-audit / calendar expand)
- [ ] codex critic APPROVE + ai-slop-cleaner pass + post-deslop regression 全绿

---

## 7. PR-5 / PR-6 之后预告

| PR | 范围 | 预估 |
|---|---|---|
| **PR-5** | `scripts/*` 大扫除 — `git mv` ~47 个文件 + 顶层 thin wrappers 改 forwarding + docs 全文 update | 1-2 天 |
| **PR-6** | deprecation cleanup — 删 thin wrappers, 不再 mention 老脚本 (release window 2-4 周后) | 0.5 天 |

详见 RFC §10.

---

> 本 handoff 由 RFC v2 §4 / §5 / §8 / §10 + PR-3 ship 报告派生. PR-3 已 ship 6 commits, 487 passed, codex critic 验证完成. 等 PR-4 ship + merge 后, PR-5 handoff 另开.
