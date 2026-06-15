# PR-3 / PR-4 Handoff: CLI 剩余命令 + 长任务契约

> **Mission**: 在 PR-2 (CLI 骨架 + email/admin MVP) 基础上, 补完 RFC v2 §4 的 `attachment / llm / notion / calendar / debug` 子命令 (PR-3), 然后落地 `backfill / project-progress / init` 批量命令 + 长任务契约 + R-06 v4 rollout 监控持久化 (PR-4)。
>
> **前置文档**:
> - [`agent-cli-rfc.md`](./agent-cli-rfc.md) — RFC v2（含 §4 命令树 / §5 通用约定 / §8 v4 rollout 监控 / §10 PR 拆分）
> - [`pr2-handoff-cli-mvp.md`](./pr2-handoff-cli-mvp.md) — PR-2 (已 ship 13 commits, 370 passed)
> - [`pr1-handoff-cli-prep.md`](./pr1-handoff-cli-prep.md) — PR-1 (已 ship 8 commits)
> - [`../CLAUDE.md`](../CLAUDE.md) — 项目总指南（含 CLI 章节）

---

## 1. PR-2 ship 报告（PR-3 起点）

| 项 | 状态 |
|---|---|
| git branch | main, clean |
| 最近 PR-2 commits | `4c098cf` ~ `ff0d2fb` (13 个 commit) |
| pytest 基线 | **370 passed** (PR-1 323 + PR-2 47 个 CLI / schema / 回归 test) |
| `pip install -e ".[cli]"` | OK; `mailagent --version` → 3.0.0 |
| CLI 子命令 | `email get/list/body/search/resync` (单封) + `admin stats/health/db-version` |
| `docs/cli-schema/` | 10 文件 (9 schema + error-codes.md), 已用 jsonschema 契约测试覆盖 |
| `CLAUDE.md` | 含 CLI 章节 (放在"项目概述"之后) |
| `data/sync_store.db` `db_version` | 5 (PR-4 需升 6 加 `v4_rollout_stats` 表) |
| pm2 mail-sync | stopped |

**PR-2 critic 留下的非阻塞 follow-ups**（codex round 4 列, 不阻 PR-2 merge）:

1. `email resync` 非 dry-run 路径的 contract test (created / skipped / replaced / archive-failure 真实场景) → 留 PR-3 (因为 PR-3 也补 mock Notion 的测试 infrastructure)
2. NDJSON stream 的 schema 契约测试 → 留 PR-3
3. 是否给每个命令 schema 都加 error wrapper 一致性 → 留 PR-3
4. `jsonschema` dev extras 收紧到 `>=4.18` 并显式声明 `referencing` 依赖 → 直接加, 1 行改动 (放 PR-3 commit 1)

---

## 2. PR-3 — 补全 CLI 命令（attachment / llm / notion / calendar / debug）

### 2.1 范围

| 命令组 | 子命令 | RFC § | 说明 |
|---|---|---|---|
| **attachment** | `list / download / derive / cleanup-orphans` | §4.3 | 走 `EmailRepository.get_attachments / get_attachment_bytes / AttachmentStore` |
| **llm** | `run / selftest / retry-failed / stats / compare-paths` | §4.4 | 走 `src/llm_agent/runner.LLMAgentRunner`; `compare-paths` 是 R-15 质量闸 |
| **notion** | `resync / update-flag / page-orphans / file-link-audit / archive` | §4.6 | `resync` 是 `email resync` 的 alias; `page-orphans` / `file-link-audit` v2 新拆 |
| **calendar** | `expand / recurring discover / recurring replay` | §4.10 | `expand` 是 `_meeting_expansion_loop` 单次手动版 |
| **debug** | `email-source / mail-structure / inline-images / applescript-fetch / notion-page` | §4.11 | 都是只读, 调底层 Mail.app / AppleScript / Notion API |

### 2.2 不在 PR-3 scope

- **不动** `backfill / project-progress / init` 子命令（这些走 PR-4，要长任务契约）
- **不动** `email resync --range / --ids / --max-failures / --resume-from / --progress-every` batch flags（PR-4）
- **不动** `scripts/*` 任何文件（PR-5 范围）
- **不引入** 新业务依赖（typer/rich/pyyaml/jsonschema/referencing 已有；`requests` 等可能需要走 LLM/Notion gateway，按需补到 `[cli]` extras）

### 2.3 实施拆分（建议 7-9 commits）

每个 commit 都过 pytest + 不破坏 PR-2 的 370 baseline。

1. **Commit 1**: `attachment list / download / derive` + schema + 单测
   - `list <internal_id> [-o text/json]` 调 `repo.get_attachments(internal_id)`
   - `download <attachment_id> [--dest PATH]` 调 `repo.get_attachment_bytes`; 默认 stdout (二进制)
   - `derive <internal_id> [--dry-run]` alias → `backfill derivatives --internal-id N` (PR-4 才有实现，PR-3 stub 直接打 PR-4 warning)
2. **Commit 2**: `attachment cleanup-orphans [--dry-run --yes]`
   - 扫 `data/attachments/` 下没有对应 `email_metadata` 行的目录
   - 涉及写盘，要 `ctx.require_auth()`
3. **Commit 3**: `llm run / selftest / retry-failed`
   - `llm run <internal_id> [--dry-run --force --no-overwrite]` 调 `src.llm_agent.runner.LLMAgentRunner.process_single`
   - `llm selftest` 直调 `client.health_check()`，不烧 token
   - `llm retry-failed [--limit N]` 扫 `llm_processing.status='failed'` 且 `next_retry_at<=now`
4. **Commit 4**: `llm stats / compare-paths`
   - `llm stats [--days N]` SQL aggregate `llm_processing` 表 (cost / cache hit / latency)
   - `compare-paths [--count N --internal-ids LIST --dry-run]` 同时跑 SQLite markdown vs regex-stripped HTML 两条路径，diff AILabels（R-15 灰度质量闸）
5. **Commit 5**: `notion resync (alias) / update-flag / archive`
   - `notion resync` 直接 delegate 到 email resync 实现
   - `update-flag <internal_id> [--is-read --is-flagged --processing-status]` 调 `client.pages.update`
   - `archive <page_id> [--yes]` 调 `client.pages.update(archived=True)`
6. **Commit 6**: `notion page-orphans / file-link-audit`
   - `page-orphans [--dry-run --limit N]` query Notion DB → diff `email_metadata` 找 Notion 有 page 但本地无 metadata 的
   - `file-link-audit [--internal-id N --dry-run]` 扫 `email_attachment.notion_file_id`
7. **Commit 7**: `calendar expand / recurring discover / recurring replay`
   - `expand [--horizon-weeks W --dry-run]` 调 `meeting_sync._expand_recurring`
   - `recurring discover [--since DATE --discover-limit N]` 走 `scripts/replay_recurring_invite.py --discover-recurring`
   - `recurring replay --internal-id N / --ids LIST [--dry-run]` 走 `replay_recurring_invite.py` 的 replay 路径
8. **Commit 8**: `debug email-source / mail-structure / inline-images / applescript-fetch / notion-page`
   - 5 个只读子命令，全部基于现有 scripts/* 逻辑（不删脚本，只新接 CLI 入口）
9. **Commit 9**: 综合回归 + PR-2 follow-up 补:
   - `email resync` 非 dry-run mock test (created / skipped / replaced / archive-failure)
   - NDJSON schema/contract test (`email list -o ndjson` / `email search -o ndjson`)
   - 决定 error wrapper schema 一致性策略并落到 `_common.schema.json` 或每个 schema
   - 收紧 `jsonschema>=4.18` + 加 `referencing>=0.30` dev 依赖

### 2.4 schema 文件清单（新加 ~15 个）

```
docs/cli-schema/
├── attachment-list.schema.json
├── attachment-download.schema.json       # 二进制下载, 仅 dry-run / 失败时返回 JSON
├── attachment-derive.schema.json
├── attachment-cleanup-orphans.schema.json
├── llm-run.schema.json                   # 含 v2 字段拆数字 (input_tokens / output_tokens / cache_*) + key/label 双字段
├── llm-selftest.schema.json
├── llm-stats.schema.json
├── llm-retry-failed.schema.json
├── llm-compare-paths.schema.json
├── notion-update-flag.schema.json
├── notion-page-orphans.schema.json
├── notion-file-link-audit.schema.json
├── notion-archive.schema.json
├── calendar-expand.schema.json
├── calendar-recurring-discover.schema.json
├── calendar-recurring-replay.schema.json
└── debug-*.schema.json (5 个)
```

每个新 schema 都加到 `tests/cli/test_schema_contract.py` 自动验证 (PR-2 已搭好 infrastructure)。

### 2.5 验收

```bash
pip install -e ".[cli]" && mailagent --help
# 期望看到 email / admin / attachment / llm / notion / calendar / debug 七组

mailagent attachment list 53675 -o json | jq '.data | length'
mailagent llm selftest -o json | jq .data.healthy
mailagent llm run 53675 --dry-run -o json
mailagent notion file-link-audit --internal-id 53675 -o json
mailagent calendar recurring discover --since 2026-04-01 -o json
mailagent debug mail-structure -o json

pytest tests/ -q --tb=no
# 期望 ≥ 410 passed (PR-2 370 + PR-3 ≥ 40 new test cases)
```

**预估**: 2-3 天。

---

## 3. PR-4 — 批量命令 + 长任务契约 + v4_rollout 持久化

### 3.1 范围

| 命令组 | 子命令 | RFC § | 长任务? |
|---|---|---|---|
| **email resync (batch)** | `--range / --ids / --max-failures / --resume-from / --progress-every` | §4.2 | 是 |
| **backfill** | `body / derivatives` | §4.5 | 是 |
| **project-progress** | `sync` | §4.7 | 是 |
| **init** | `fetch-cache / analyze / fix-properties / fix-critical / update-parents / sync-new / all` | §4.9 | 是 |
| **admin** | `stats v4_rollout 真实数据 (R-06)` | §4.8 / §7.5 / §8 | — |
| **admin** | `dead-letter list / retry / cleanup` | §4.8 | — |
| **admin** | `cleanup syncstore / cleanup duplicates / repair-parents` | §4.8 | 是（写 SQLite） |

### 3.2 长任务契约（RFC §5）

新增 `src/cli/long_task.py`（或类似）作为 共用 mixin / 装饰器，所有 batch 命令都遵守:

```python
class LongTaskContext:
    """SIGINT/SIGTERM 两次语义 + max-failures 熔断 + checkpoint."""

    # 状态机:
    #   running → sigint_first_received → aborted (current unit 跑完后退出 130)
    #   running → sigint_second_received → sys.exit(130) 立即退
    #   running → max_failures_hit → exit 8
    #   running → pm2_conflict_detected → exit 9
    #   running → all_done → exit 0 (或 partial_failure → exit 6)
```

**退出码细分**（RFC §5.2）:
- `0` 全 OK
- `6` `partial_failure` (含 failed list + summary)
- `7` SIGINT 第一次后正常退出 (aborted)
- `8` 连续失败 > `--max-failures` 熔断
- `9` PM2 mail-sync 正在跑 (写命令冲突, 默认拒)
- `130` SIGINT 二次强退

**PM2 检测**（写命令必须）:

```python
def _check_pm2_conflict(cli, *, allow_concurrent: bool = False) -> None:
    """写类 batch 命令启动前检测 PM2 mail-sync 是否在跑."""
    if allow_concurrent or os.environ.get("MAILAGENT_CLI_ALLOW_CONCURRENT") == "true":
        return
    import subprocess
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
        # pm2 不存在或解析失败: 视为干净环境, 通过
        return
```

**Checkpoint / resume**:

```sql
-- DB_VERSION 5 → 6, 新增表
CREATE TABLE cli_checkpoints (
    command TEXT NOT NULL,           -- 'backfill_body' / 'email_resync' / ...
    target_kind TEXT NOT NULL,       -- 'range' / 'ids' / 'all'
    target_key TEXT NOT NULL,        -- '53000-53100' / 'inbox-failed' / ...
    last_completed_internal_id INTEGER,
    succeeded INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    aborted_at REAL,
    PRIMARY KEY (command, target_key)
);
```

每 N (默认 50) 个 unit 写一次。`--resume-from N` 从 `internal_id >= N` 续跑。退出（成功 / 中止）时打印 "Resume: mailagent ... --resume-from \<N\>"。

**进度回报**:
- text mode: `rich.progress.Progress` 显示 `[INTERNAL_ID 53050 / 53100]  87%  3/min  ETA 5m`
- ndjson: 每 unit 一行 `{internal_id, status, error?, duration_ms}` + 末行 `_meta`

### 3.3 R-06 v4_rollout 持久化（admin stats）

PR-2 admin stats 的 `v4_rollout` 段是 `_source: not_implemented_in_pr2`。PR-4 落地（RFC §8 选项 A）:

```sql
-- 新表 (DB_VERSION 6)
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

`src/notion/sync.py` 加 in-memory counter:
- `_route_hit / _route_miss / _route_error` 每次 `create_email_page_v2` 路由都 +1
- 每分钟一个 `_flush_v4_stats()` 异步 task (在 `new_watcher` 主循环里调) 写表

`admin stats` 读最新 row + `_snapshot_at`:
```json
{
  "v4_rollout": {
    "from_sqlite_hit": 421,
    "fallback_miss": 0,
    "fallback_error": 0,
    "rollout_route_latency_p99_ms": 12,
    "body_miss_internal_ids_sample": [],
    "_source": "stats_reporter_last_snapshot",
    "_snapshot_at": "2026-05-16T01:30:00+08:00",
    "_warn_if_stale_sec": 300
  }
}
```

**`stats_reporter_last_snapshot` 同样要落 watcher / handlers 段**（PR-2 暂标 not_implemented_in_pr2 的两段）。

### 3.4 实施拆分（建议 9-12 commits）

1. **Commit 1**: DB_VERSION 5 → 6 migration + `cli_checkpoints` + `v4_rollout_stats` 表 + tests/mail/test_sync_store_v6_migration.py
2. **Commit 2**: `src/cli/long_task.py` 共用 (SIGINT 二次 / max-failures 熔断 / checkpoint write/read / progress) + 单测
3. **Commit 3**: `src/cli/pm2_check.py` (PM2 检测 + `--allow-concurrent` opt-in) + 单测 (mock subprocess)
4. **Commit 4**: `email resync` 加 batch 模式 (`--range / --ids / --max-failures / --resume-from / --progress-every`)
5. **Commit 5**: `backfill body / derivatives` (替换 `scripts/backfill_email_body.py` / `scripts/backfill_derivatives.py` 的入口；脚本继续 thin wrapper)
6. **Commit 6**: `project-progress sync` (含 `--all-history / --limit / --sheets / --dry-run / --force / --backfill-project-start`)
7. **Commit 7**: `init fetch-cache / analyze / fix-properties / fix-critical / update-parents / sync-new / all` (7 个子命令)
8. **Commit 8**: R-06 v4_rollout 持久化 (in-memory counter + flush loop + admin stats 真实数据)
9. **Commit 9**: `admin dead-letter list/retry`, `admin cleanup-deadletter`, `admin cleanup-syncstore/duplicates`, `admin repair-parents`
10. **Commit 10**: 长任务测试套件 (`tests/cli/test_long_task_contract.py`): SIGINT/SIGTERM、熔断、checkpoint resume、PM2 检测、partial_failure schema
11. **Commit 11**: schema 文件落位 (~15 新文件) + contract test 覆盖
12. **Commit 12**: 综合回归 + CLAUDE.md CLI 章节扩充 (加 PR-4 命令 + 退出码表)

### 3.5 验收

```bash
# DB migration
sqlite3 data/sync_store.db "SELECT value FROM sync_state WHERE key='db_version'"  # 期望 6
sqlite3 data/sync_store.db ".tables" | grep -E "cli_checkpoints|v4_rollout_stats"

# 长任务契约
mailagent email resync --range 53000-53010 --dry-run
# 期望: rich progress bar + 末尾 summary

mailagent email resync --range 53000-53100 --max-failures 5
# 期望 (mock 失败超 5): exit 8 + E_MAX_FAILURES

# SIGINT 一次 + 二次
mailagent backfill body --since-date 2026-03-01 &
sleep 2 && kill -INT $! ; sleep 2 && kill -INT $!
# 期望 exit 130

# Checkpoint resume
mailagent email resync --range 53000-53100 ... # 跑到 53050 死掉
mailagent email resync --range 53000-53100 --resume-from 53051  # 续跑

# PM2 检测
pm2 start mail-sync && mailagent email resync 53675
# 期望 exit 9 + E_PM2_RUNNING + hint

mailagent email resync 53675 --allow-concurrent  # 显式跳过

# R-06 v4_rollout 持久化
pm2 start mail-sync  # 跑 5 min
mailagent admin stats --section v4_rollout -o json | jq '.data.v4_rollout | {hit: .from_sqlite_hit, _source}'
# 期望 hit > 0, _source: stats_reporter_last_snapshot, _snapshot_at 不是 stale

# pytest
pytest tests/ -q --tb=no
# 期望 ≥ 450 passed (PR-3 ≥ 410 + PR-4 ≥ 40)
```

**预估**: 3-4 天（含 SIGINT race condition / PM2 mock / checkpoint 边界 case 测试）。

---

## 4. 跨 PR-3 / PR-4 约束

- **不破坏 PR-2 接口**: `EmailRepository.list_metadata` / `NotionSync.create_email_page_from_sqlite` 返回值不能变 (CLI 已消费)
- **不破坏 v4 灰度**: `NOTION_READ_FROM_SQLITE` 切换语义保持
- **不删除 `scripts/*`**: PR-5 才动 (PR-3/PR-4 期间 scripts 与 CLI 并存)
- **DB_VERSION 升级安全**: PR-4 migrate 5→6 必须幂等 + 现有 6131 封邮件不丢; 准备 rollback SQL (drop 新表)
- **PM2 检测必须可绕过**: 测试 / 内部脚本 / 灰度场景需 `--allow-concurrent` 或 env `MAILAGENT_CLI_ALLOW_CONCURRENT=true`
- **`pytest tmp_path` 隔离**: 所有 CLI batch 测试用 tmp SQLite, 不动 `data/sync_store.db`

---

## 5. 风险 / 缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| SIGINT 二次语义在 Python asyncio 下不直观 | 中 | 用 `signal.SIGINT` 在 main thread 注册 + `asyncio.shield` 包裹 current unit; 单测用 `asyncio.create_task` + `task.cancel()` 模拟 |
| PM2 检测 false positive (开发机没装 pm2) | 低 | `FileNotFoundError` 自动 graceful skip + log warning |
| `cli_checkpoints` 表跨命令冲突 (两个 `email resync` 同时跑) | 中 | 用 `(command, target_key)` 做 PK; 启动时检测同 key 未 done 警告; 加 `--force-restart` flag |
| v4_rollout flush loop 影响 watcher 性能 | 低 | flush 一次约 1ms; 每分钟一次; 用 `asyncio.create_task` fire-and-forget |
| init 命令的 7 个 sub-action 与 `scripts/initial_sync.py` 行为漂移 | 中 | 第一版 CLI 直调脚本 (subprocess) + 慢慢迁移逻辑; 加 e2e test 对比输出 |

---

## 6. 启动 prompt（新 session 复制粘贴）

**PR-3 推荐模式: ralph + `--critic=codex`**（与 PR-2 一致, 适合"睡前挂"模式）:

```
/oh-my-claudecode:ralph --critic=codex 实施 RFC v2 PR-3: CLI 补全命令 (attachment / llm / notion / calendar / debug)

前置文档（按顺序读）:
1. docs/pr3-handoff-cli-rest.md（本文档，含完整 spec + 9 commit 拆分 + 验证 checklist）
2. docs/agent-cli-rfc.md §4.3 / §4.4 / §4.6 / §4.10 / §4.11（5 个命令组的命令树）
3. docs/pr2-handoff-cli-mvp.md（PR-2 已 ship 13 commits, 370 passed; CLI 骨架 + email/admin MVP）
4. PR-2 critic round 4 提的 4 个 follow-up（本 handoff §1）

PRD scaffold 时把本 handoff §2.3 的 9 个 commit 作为 9 个 user stories:
- US-001: Commit 1 — attachment list / download / derive
- US-002: Commit 2 — attachment cleanup-orphans (写盘, 含 auth)
- US-003: Commit 3 — llm run / selftest / retry-failed
- US-004: Commit 4 — llm stats / compare-paths (R-15 灰度质量闸)
- US-005: Commit 5 — notion resync (alias) / update-flag / archive
- US-006: Commit 6 — notion page-orphans / file-link-audit
- US-007: Commit 7 — calendar expand / recurring discover / replay
- US-008: Commit 8 — debug 5 个只读子命令
- US-009: Commit 9 — 综合回归 + PR-2 4 个 follow-up

每个 story 的 acceptance criteria 来自本 handoff §2.5 + RFC § 引用 + PR-2 已 ship 的契约。

关键约束:
- PR-3 不动 backfill / project-progress / init 子命令 (PR-4)
- 不动 email resync batch flags (PR-4)
- 不动 scripts/* (PR-5)
- 完成时 pytest ≥ 410 passed (PR-2 370 + PR-3 ≥ 40 新增)
- 所有新 schema 必须通过 tests/cli/test_schema_contract.py 自动验证

关键决策（已批准默认值, 无需 AskUserQuestion）:
- attachment download 二进制默认 stdout, --dest 写文件 (RFC §4.3)
- llm run --dry-run 跳过 Notion 写但仍跑 LLM (烧 token, 类似 scripts/run_llm_on_email.py)
- llm compare-paths 抽样 default 20, 用 --internal-ids 强制 (R-15 质量闸预生产用)
- notion file-link-audit 只标 (NULL but Notion has file blocks) + (NOT NULL but Notion file_upload 过期), 不修复 (修复留 PR-4 admin repair-*)
- calendar recurring replay 默认 skip_parent_lookup=True (与 scripts/replay_recurring_invite.py 一致)
- debug 命令全部 read-only, 不要 auth

Final critic 用 codex: 执行 omc ask codex --agent-prompt critic, 给它:
(a) prd.json 9 个 stories 的 acceptance criteria
(b) 本次改动的所有文件 + 相关文件
(c) 评估"是否存在更简单/快速/可维护的实现路径"

完成 = 所有 9 stories passes:true + codex critic APPROVE + deslop pass + post-deslop regression 全绿。
```

**PR-4 等 PR-3 ship 后再开新 session**, prompt 类似但参考本 handoff §3 (尤其 §3.2 / §3.3 / §3.4 12 commits 拆分)。

---

## 7. 完成检查清单

### PR-3 ship 前必须 ✅:
- [ ] 5 个新命令组（attachment / llm / notion / calendar / debug）全部就位
- [ ] `mailagent --help` 列 7 组命令（email / admin / attachment / llm / notion / calendar / debug）
- [ ] `docs/cli-schema/` 新增 ~15 个 schema 文件
- [ ] PR-2 的 4 个 follow-up 处理完（resync mock test / NDJSON contract / schema 一致性 / jsonschema 依赖）
- [ ] pytest ≥ 410 passed
- [ ] `pip install -e ".[cli]"` 成功
- [ ] CLAUDE.md CLI 章节扩充

### PR-4 ship 前必须 ✅:
- [ ] DB_VERSION 5 → 6 migration 通过, `cli_checkpoints` + `v4_rollout_stats` 表存在
- [ ] 6 个 batch 命令就位 (email resync / backfill body / backfill derivatives / project-progress sync / init / admin cleanup-*)
- [ ] 长任务契约 (SIGINT 二次 / max-failures / PM2 检测 / checkpoint) e2e 测试通过
- [ ] R-06 v4_rollout 持久化跑通 (pm2 start 5min 后 admin stats 真实 hit > 0)
- [ ] `mailagent --help` 列 7 组命令 + 完整 batch flags
- [ ] pytest ≥ 450 passed
- [ ] CLAUDE.md "长任务退出码" 表新增, scripts/README 标 PR-5 deprecation 时间表

---

## 8. PR-5 / PR-6 之后预告

| PR | 范围 | 预估 |
|---|---|---|
| **PR-5** | `scripts/*` 大扫除 — `git mv` ~47 个文件 + 顶层 6 个 thin wrappers 改 forwarding + docs 全文 update | 1-2 天 |
| **PR-6** | deprecation cleanup — 删 thin wrappers, 不再 mention 老脚本 (release window 2-4 周后) | 0.5 天 |

详见 RFC §10 + §9 scripts 迁移表。

---

> 本 handoff 由 RFC v2 §4 / §5 / §8 / §10 + PR-2 ship 报告派生。PR-2 已 ship 13 commits, 370 passed, codex critic APPROVE。等 PR-3 ship + merge 后, PR-4 handoff 另开（或直接复用本文档 §3）。
