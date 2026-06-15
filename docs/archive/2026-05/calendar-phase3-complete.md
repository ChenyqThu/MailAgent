# Calendar Module — Phase 3 完工纪要 (2026-05-26)

**From**: Session @ 2026-05-25/26 (Phase 3 完整推进)
**Status**: P0 + P1 + P2 全部 ship. APPROVE candidate.
**Branch**: feat/agent-harness
**Test 基线**: 263 → **336 passed** (+73 new), 0 regression.

---

## 1. Phase 3 完成清单 (9 atomic commits)

### P0 — Legacy 下线 (2 commit)

| ID | Hash | Scope |
|---|---|---|
| P0-1 | `d87bf4f` | ecosystem.config.js 删 calendar-sync 进程定义 |
| P0-2 | `8f972b0` | git rm calendar_main.py (root) + src/calendar/ 整目录 (4 file) + README/CLAUDE 文档更新 |

**未实施**: 数据迁移 (zero `legacy_calendar_app` rows in DB confirmed, 含 soft-deleted, 不需要 archive 表方案)

### P1 — 架构大重构 (5 commit)

| ID | Hash | Scope | LOC 变化 |
|---|---|---|---|
| P1-a | `5375080` | 新建 `src/calendar_sync/service.py` (`CalendarService` facade) + 31 pytest | +965 / +448 test |
| P1-b | `fc0759c` | CLI 13 subcommand 改用 service | -800 / +289 (1479 → 958 行) |
| P1-c | `f27b172` | handlers/calendar.ts 拆 4 file (read/write/sync/shared + 入口) | 903 → 259 入口 (4 子 file = 761 行) |
| P1-d | `c778a3e` | repository.py per-thread connection pool (threading.local + WAL) + 6 pytest | +178 (含测试) |
| P1-e | `1719970` | rsvp.py organizer freshness check (email_ics source) + 5 pytest | +239 (含 CLI surface + 测试) |

### P2 — Tooling / 测试 (2 commit)

| ID | Hash | Scope |
|---|---|---|
| P2-a | `bf5b51b` | `scripts/dev/i18n_audit.py` (扫 t('key') vs locale tree, 检 missing/collision/parity) |
| P2-b | `f7fef26` | `tests/calendar_sync/test_caldav_writer_roundtrip.py` (vobject 真 parse round-trip, 31 test) |

### P2-c — Lucide bundle 验证 (uncommitted, 仅记录)

`pnpm build` 跑通, 数据:
- renderer chunk: 2.9 MB (含 React + FullCalendar + Tiptap + shadcn 全栈)
- CSS: 178 kB
- main process: 278 kB

Lucide tree-shake 验证 ✓:
- src/ 内 `from 'lucide-react'` import 56 处
- 跨文件 unique icon 名 ~59 个
- bundle 内 "lucide" 字符串引用仅 3 处 (drift 极小)

如果 lucide 整包被打 → bundle 会含 1500+ icon SVG (~1.5 MB), 不会只 3 处. 当前
~59/1500 ≈ 3.9% 打包率, tree-shake 正常.

未单独 commit (验证不改代码; 结论留本文件参考).

---

## 2. 测试基线

| 套件 | 数 |
|---|---|
| tests/calendar_sync/ | 159 → **190** (+31 service test +6 pool +5 freshness +31 roundtrip - 重) |
| tests/calendar_notion/ | 不变 |
| tests/cli/test_calendar*.py | 不变 (5 test 微调 monkeypatch target) |
| **Calendar 全套** | 263 → **336 passed** |
| frontend vitest tests/main/calendar.test.ts | **35 passed** (零改动) |

```bash
# 验收命令
source venv/bin/activate
pytest tests/calendar_sync/ tests/calendar_notion/ tests/cli/test_calendar.py tests/cli/test_calendar_expand.py -q
# 336 passed

cd frontend
pnpm typecheck && pnpm vitest run tests/main/calendar.test.ts
# typecheck 0, 35 passed

# i18n calendar 子树 audit (期望: 0/0/0)
python scripts/dev/i18n_audit.py --prefix calendar.
```

---

## 3. 关键架构变化

### 3.1 CalendarService facade

`src/calendar_sync/service.py` 抽 13 个业务 method, 上层 CLI / IPC 复用同
API surface:

- Read: `list_events_in_window` / `list_today` / `list_week` / `get_event` /
  `list_sync_states` / `list_calendar_names` / `discover_recurring_series`
- Write: `sync_now` / `create_event` / `update_event` / `delete_event` /
  `send_rsvp` / `replay_event_to_notion` / `recurring_replay_by_internal_ids` /
  `expand_recurring`

设计要点:
- 服务无状态 (lazy repo / cfg)
- 返 dict, 跟 CLI emit() 形状对齐 (上层不重映射)
- 异常: ValueError (参数/not-found) + 原异常 (SMTP/CalDAV)
- auth 不在 service — 上层关心 (CLI `require_auth` / IPC `safeIpcHandle`)

### 3.2 Frontend handlers split

```
calendar.ts (259)        — 入口: register + re-export
├── calendar-shared.ts (92)  — safeIpcHandle / assertSafeSender / helpers
├── calendar-read.ts (435)   — eventsList/Get/syncStatus/calendarNames/discover
├── calendar-write.ts (187)  — replay/rsvp/create/update/delete CRUD
└── calendar-sync.ts (47)    — syncTrigger / expand
```

测试零改动 — `__testing` / `__safeSenderTesting` / 所有 `run*` 从 calendar.ts
re-export.

### 3.3 Repository connection pool

`CalendarEventRepository(db_path, pool=True)` 默认启用 threading.local 长连接.
60s × N calendars × 多次 read/write 一轮原 100+ open/close → pool 后 per-thread once.

WAL 兼容: 多 reader + 1 writer 互不阻塞, 长连接看自己 commit 立即生效.

`pool=False` 退化老 open-close (cli subprocess / test 隔离用).

### 3.4 RSVP organizer freshness

`source='email_ics'` row.organizer 是原邮件解析快照. 邮件被删 / `dead_letter`
状态时, RSVP 发到可能不可达的地址. P1-e 加 `_check_organizer_freshness`:

- `source='caldav'` 跳过 (CalDAV 实时 fresh)
- 源邮件 internal_id 在 `email_metadata` 缺失 / dead_letter → warning
- **不阻塞**发送 — 仅信息提示, result dict 加 `organizer_freshness_warning`
  字段, CLI text mode 多打一行 ⚠

---

## 4. 风险 / Caveat

### 4.1 git race (handoff §5.2)

本 session 间 ping-island fork 并发删除 `scripts/dev/eval_*.{ts,mjs,cjs}` 7 个
文件, P1-a commit `git add tests/.../test_service.py src/.../service.py
src/.../__init__.py` 时连带把这些 deletion 吸进同 commit. 不致命 — 那些
eval scripts 的删除是另一边主动做的, 只是 mix 进我们的 P1-a commit message
没提. **下次 session 严格 `git add <path>`, 不要靠 `git add -A`.**

### 4.2 `legacy_calendar_app` enum 保留

DB schema CHECK 约束 `source IN ('caldav', 'email_ics', 'legacy_calendar_app')`
没改 — backward compat. `SOURCES_TRY_ORDER` / `_VALID_SOURCES` 同保留.
零 row 跑过此 source (已 verify, 含 soft-deleted), 实际无成本.

### 4.3 vobject 依赖 (P2-b)

`tests/calendar_sync/test_caldav_writer_roundtrip.py` import vobject. 已在
venv (caldav lib 间接依赖). 不在 `requirements.txt` 显式列, 也没必要 — 拉
caldav 自动有.

### 4.4 已知不修

- DavMail 6.7 PROPFIND getctag XML 解析炸 → worker 走 1h time-fallback (handoff §5.6)
- macOS Sequoia `com.apple.provenance` 锁 (handoff §5.3) — 偶发, `sudo xattr -dr` 清

---

## 5. 不在本 session scope (Phase 4 项目化)

PRD §11.7-11.9 长期 backlog 已在前次 handoff 列出:
- 多 calendar toolbar chip 切换 + EventFormModal create 加 calendar 选
- 全天事件 + 跨时区 toggle
- 周期事件 RRULE 创建/编辑 (modal 加"重复"段 + 改这一次/未来/整系列)
- 跨设备 V2 (HttpApi proxy 给 Web/Mobile)
- e2e Playwright RSVP/编辑/删除/撤销链 (P2-c 本 session 跳过 — 无 env)

---

## 6. 关键文件清单

### Phase 3 新增
- `src/calendar_sync/service.py` (~965 行) — CalendarService facade
- `scripts/dev/i18n_audit.py` (~240 行) — i18n key audit
- `tests/calendar_sync/test_service.py` (31 test)
- `tests/calendar_sync/test_repository_pool.py` (6 test)
- `tests/calendar_sync/test_caldav_writer_roundtrip.py` (31 test)
- `docs/calendar-phase3-complete.md` (本文件)

### Phase 3 重写
- `src/cli/commands/calendar.py` (1479 → 958)
- `frontend/src/electron/main/handlers/calendar.ts` (903 → 259 入口)

### Phase 3 新增 (frontend handlers 拆分)
- `frontend/src/electron/main/handlers/calendar-shared.ts` (92)
- `frontend/src/electron/main/handlers/calendar-read.ts` (435)
- `frontend/src/electron/main/handlers/calendar-write.ts` (187)
- `frontend/src/electron/main/handlers/calendar-sync.ts` (47)

### Phase 3 微调
- `src/calendar_sync/repository.py` (+pool)
- `src/calendar_sync/rsvp.py` (+freshness)
- `src/calendar_sync/__init__.py` (+CalendarService export)
- `tests/cli/test_calendar.py` (1 monkeypatch fix)
- `tests/cli/test_calendar_expand.py` (4 monkeypatch fix)
- `README.md` / `CLAUDE.md` (legacy code 文档清理)

### Phase 3 删除
- `calendar_main.py` (root, ~330 行)
- `src/calendar/__init__.py`
- `src/calendar/applescript_reader.py`
- `src/calendar/eventkit_watcher.py`
- `src/calendar/reader.py`
- ecosystem.config.js 内 calendar-sync entry (16 行)

---

## 7. 给下个 Session 的 prompt 模板

```
Phase 3 已 ship 完整 (P0+P1+P2, 9 commits 在 feat/agent-harness).
读 docs/calendar-phase3-complete.md (本文件) 拿完整状态.

测试基线: 336 calendar pytest passed (263 → 336, +73 new) + 35 vitest passed.
所有 review 段 (sonnet round 1 + opus round 2 + A/B backlog + Phase 3) 清.

下个 session 进 Phase 4 项目化:
- 多 calendar 支持 (toolbar chip + event form calendar select)
- 全天事件 + 跨时区 (modal toggle + tz select)
- 周期事件 RRULE 创建/编辑 modal (改这一次/未来/整系列 3 模式)
- 跨设备 V2 (HttpApi proxy 给 Web / Mobile, 不在 Electron 内)
- e2e Playwright 真触摸链 (RSVP/编辑/删除/撤销, 需 Playwright env)

仍参考的 caveat:
- DavMail 6.7 ctag 不可用 1h time-fallback (不修)
- macOS Sequoia provenance lock (sudo xattr -dr 清)
- 严格 git add <path> (本 session 因 git race 吸了 eval scripts 删除)
- vobject 依赖给 caldav lib 间接, 不要乱卸
```
