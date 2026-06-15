# Calendar Module — Phase 3 Handoff (2026-05-25) [STALE — 已 ship]

> ⚠ **本文件已 stale (2026-05-26)** — Phase 3 完整 ship.
> 请读 [`docs/calendar-phase3-complete.md`](./calendar-phase3-complete.md) 作
> 主参考 (含 10 commit 列表 + 336 pytest 基线 + Phase 4 prompt 模板).
> 本文件保留作历史记录, 不再更新.

**From**: Session @ 2026-05-24/25 (review-driven fix loop, F1-F32 全 ship)
**To**: 下个 session — Phase 3 legacy 下线 + 架构大重构 + tooling/测试
**Status**: 两轮 review (sonnet → opus max effort) 后 Critical/High/Medium 全清.
APPROVE-WITH-MINOR. 剩余都是中长期重构 + Phase 3 legacy 下线, 一个 session
全做完是可行的 (估 8-12h).

**Read first**:
- `docs/calendar-module-prd.md` — 产品需求 + 数据模型 + 视图规格 (不变)
- 本文件 §3 (Phase 3 待办) + §5 (caveat)
- 旧 handoff `docs/calendar-next-session-handoff.md` — Phase 2 ship 状态,
  已被本文件取代, 但 §5 (caveat) 仍参考用

---

## 1. F1-F32 累计 review fix 汇总 (24 项 / 22 commits)

两轮 review 后 fix list:
- **Round 1 (sonnet)**: Critical 6 / High 多个 / Medium 多个 — F1-F13
- **Round 2 (opus max effort)**: C1 + H1/H2/H3 + 5 Medium — F15-F23
- **i18n followup**: F24 (relTime), F22 (ErrorBoundary)
- **Backlog 清理 A+B 段**: F25-F32

### Round 1 — F1-F13 (前次 session 大头)

| ID | Hash | Scope |
|---|---|---|
| F1 | `7c471f3` | rsvp recurrence_id 8 format 容错 |
| F2 | `985a530` | repository.upsert INSERT...RETURNING atomic |
| F3 | `93fc3a0` | caldav_writer update_event 透传 attendees + RRULE |
| F4 | `0ca00a9` | IPC safeIpcHandle + senderFrame check |
| F5 | `80e6b48` | Drawer state 上提 Layout + onReopen |
| F6 | `e19df2f` | refetchInterval ±jitter + useCallback dep |
| F7 | `bb203cb` | CalendarErrorBoundary 包 5 view |
| F8 | `3be16c4` | worker._calendars 周期刷新 (60 ticks) |
| F9 | `54304e9` | list_event_occurrences SQL filter + index |
| F10 | `7acdcdd` | reconciler RRULE master soft_delete |
| F11+F12 | `437888a` | MonthView popover capture phase + DayView deps |
| F13 | `bceead3` | calendar 模块 i18n 抽 130 keys |

### Round 2 — F15-F24 (Opus review fix)

| ID | Hash | Scope |
|---|---|---|
| F15+F18 | `174814b` | worker snapshot+lock (C1) + F2/F8 concurrent test (H3) |
| F16 | `c5fd1a3` | i18n 3 key collision/missing (H1) |
| F17 | `c57f5ce` | assertSafeSender 空 URL 严格化 + 7 vitest (H2) |
| F19 | `7b9204b` | caldav_writer 透传 attendees PARTSTAT/ROLE/RSVP |
| F20 | `fcf973a` | worker ctag stale 取 max(incremental, full) |
| F21 | `4a4c64b` | _to_epoch 支持 date + DST 边界 |
| F22 | `4c3ba2a` | CalendarErrorBoundary 文案 i18n |
| F23 | `4f14129` | reconciler 加 occurrence override soft_delete |
| F24 | `18abd26` | relativeTime "N 秒前/分钟前" 漏抽 i18n |

### A+B 段 — F25-F32 (本 session)

| ID | Hash | Scope |
|---|---|---|
| F25-F28 | `dc8e0e1` | A 段 UX 4 项: refresh 退避 + active reset + source narrow + mousedown 协调 |
| F30+F31 | `6925d5b` | SOURCES_TRY_ORDER + escape_text/fmt_utc 提升 `_common.py` |
| F29 | `37ce8bf` | caldav_reader 移到 `calendar_sync/` 修反向 import |
| F32 | `713ea4b` | 7 文件重复 helpers 抽 `lib/format.ts` |

---

## 2. 当前测试状态

- **后端**: `pytest tests/calendar_sync/ tests/calendar_notion/ tests/cli/test_calendar.py tests/cli/test_calendar_expand.py` → **263 passed** (baseline 229 → 263, +34 new tests over 24 fixes)
- **前端**: `pnpm typecheck` (node + web) exit 0; `pnpm vitest run tests/main/calendar.test.ts` → **35 passed**
- 没有 e2e Playwright

---

## 3. Phase 3 待办 — 下个 session 全做完 (~8-12h)

### 3.1 ★ Phase 3 Legacy 下线 (★ P0, ~3-4h)

CLAUDE.md "Calendar Module" 段 + PRD §7 都明确:
- `calendar_main.py` (root) 老 EventKit-based 独立同步服务
- `src/calendar/` 整目录(老 Calendar.app reader / sync logic)
- PM2 进程 `calendar-sync` (跑老路径)
- DB 含 `source='legacy_calendar_app'` 行

**Phase 1 已 cutover 4 周** (2026-04-23 至今), 该下线了:

**P0-a**: 删 `calendar_main.py` (root)
- 之前可能有 cron / manual 调用, grep 确认无 ref
- ecosystem.config.js 删 calendar-sync 进程定义

**P0-b**: 删 `src/calendar/` 整目录
- `from src.calendar import ...` 反向 grep 全清, 没人 import 才删
- 注意 `src/calendar_sync/` ≠ `src/calendar/`

**P0-c**: 数据迁移 — `source='legacy_calendar_app'` rows 处理
- 选项 A (推荐): archive 表 `calendar_event_legacy` 移过去 + 主表 hard delete
- 选项 B: hard delete 直接(若用户接受丢这部分历史)
- 选项 C: 留着不动(`legacy_calendar_app` 行继续显示但不再更新)
- CLI 已有 `mailagent admin cleanup-syncstore` mode, 可加 `--legacy-calendar` 选项

**风险**:
- 生产数据,先 backup `data/sync_store.db` 再 migrate
- 用户可能仍在看 `legacy_calendar_app` 行(前端展示)
- PM2 删进程要 `pm2 stop calendar-sync && pm2 delete calendar-sync`,先验证 mail-sync 还跑

**验收**:
- pytest tests/calendar_sync/ tests/calendar_notion/ 全 green
- `pm2 status` 不再有 calendar-sync 进程
- `grep -r "from src.calendar import"` zero hit
- `sqlite3 data/sync_store.db "SELECT source, COUNT(*) FROM calendar_event GROUP BY source"` 看 legacy 是否如预期处理

### 3.2 C 段 — 架构大重构 (P1, ~6-10h)

之前 review 标为 P2 留待项目化, 既然 Phase 3 一次性做就一起:

**P1-a**: CLI 1479 行 `cli/commands/calendar.py` 抽 service layer (~4h)
- 13 subcommand 各自 import reader/writer/repo + cfg + error mapping, 平均 100+ 行/个
- 新建 `src/calendar_sync/service.py` `CalendarService` facade
- subcommands 降到 ~40 行/个 (parse args → service.method → format response)
- IPC handlers/calendar.ts 也可复用 service 概念(虽然前端是 TS,但 service API surface 让 CLI + 前端语义对齐)
- 参考 `src/notion/sync.py` 的 facade / PageOps / ThreadOps 拆法

**P1-b**: `handlers/calendar.ts` 861 行按职能拆 (~2h)
- `calendar-read.ts` (eventsList / eventGet / syncStatus / calendarNames / recurringDiscover)
- `calendar-write.ts` (eventCreate / Update / Delete / Replay / RecurringReplay / Rsvp)
- `calendar-sync.ts` (syncTrigger / Expand)
- 共享 `safeIpcHandle` / `assertSafeSender` 提到 `calendar-shared.ts`
- 每个 file ~250-300 行

**P1-c**: `repository.py` connection pool (~1h)
- 60s × N calendars × multiple read/write 一轮上百次 sqlite open/close
- 加 per-thread 长连接(threading.local + WAL mode 兼容)
- 或者用 `contextlib.contextmanager` cache 模式

**P1-d**: RSVP `organizer` stale 复检 (~1h)
- `email_ics` 派生 row organizer 来自原邮件
- 邮件被删后 row.organizer 已 stale, RSVP 发到不存在地址
- 加 `validate_organizer_email_still_reachable` mechanism (简单 SMTP MX 查询)
- 或者: rsvp.py 检测 source='email_ics' 时跑 freshness check, 失败提示用户

### 3.3 D 段 — Tooling / 测试 backlog (P2, ~5-7h)

**P2-a**: i18n build-time check script (~1h)
- `scripts/dev/i18n_audit.py` 扫所有 `t('calendar.xxx')` 调用 vs locale JSON tree
- 检测 missing key + collision (calendar.empty string vs object 这种)
- 加到 `pnpm run lint` 链或独立 CI step
- 同步检测 zh/en parity (一边定义另一边漏)

**P2-b**: Lucide tree-shake bundle size 验证 (~30min)
- `pnpm build` 看 prod bundle calendar chunk size
- 确认 Crown/Mail/Lock 等 icon 都被 tree-shaken 不打包整 lucide
- 之前 review 担心 lucide-react 大量 import 影响 bundle

**P2-c**: e2e Playwright 完整 RSVP/编辑/删除链 (~3-4h)
- 触摸 `pnpm dev` 真实场景
- 测 RSVP accept → SMTP 真发 (mock organizer)
- 编辑/删除 → CalDAV PUT/DELETE → 验证 SQLite reconcile
- 撤销 undo → drawer reopen
- 之前没做(没 Playwright 环境)

**P2-d**: PARTSTAT round-trip 真 caldav lib test (~2h)
- F19 mock 验证 transmute, 但没用真 caldav lib build/parse vEvent
- 加 round-trip: create → caldav.save → re-fetch → parse → assert PARTSTAT/ROLE/RSVP 完整
- 不需要真 DavMail, 用 vobject 直接 parse/serialize

---

## 4. 不在 scope (Phase 4 项目化)

PRD §11.7-11.9 + handoff §4 长期 backlog:
- 多 calendar 支持(toolbar chip 切换器 + EventFormModal create 加 calendar 选)
- 全天事件 + 跨时区(EventFormModal toggle + tz select)
- 周期事件 RRULE 创建/编辑(modal 加 "重复" 段 + 改这一次/改未来/改整个系列)
- 跨设备 V2(HttpApi proxy 给 Web/Mobile)

这些是新功能不是 fix, Phase 4 时单独立项, 不放本 session.

---

## 5. 风险 / Caveat / Don't踩

### 5.1 Phase 3 legacy 下线生产风险
**必须先 backup**: `cp data/sync_store.db data/sync_store.db.pre-phase3-backup`. 不可 reversible 操作前必 backup.

PM2 progression: 先 `pm2 stop calendar-sync` 跑 1-2 天看 mail-sync 是否 OK + caldav 路径数据持续, 再 `pm2 delete` + 删代码.

### 5.2 git race (本 session 期间 ping-island fork 在改 `src/notify/island_*.py`)
本 session 用 `git add <files>` 显式 stage 避开。下个 session 同样姿势。

### 5.3 macOS Sequoia provenance lock
之前 session 偶遇 Claude Code 改过的文件被 `com.apple.provenance` 锁。修法:
```bash
sudo xattr -dr com.apple.provenance <path>
```

### 5.4 Electron main process 不会 HMR
改 `frontend/src/electron/main/**/*.ts` 必须重启 `pnpm dev`. Renderer (shared/**/*.tsx) HMR 正常.

### 5.5 mail-sync (PM2) Python 改后需重启
改 `src/calendar_sync/` 后 `pm2 restart mail-sync` 才会加载.

### 5.6 ctag 不可用走 1h 兜底
DavMail 6.7 PROPFIND getctag XML 解析炸. ctag 始终 None → worker 走 1h time-fallback. **不要再修这个**, 工作量大.

### 5.7 i18n parity
F24 后中文/英文 keys 全平行, 但下次新加翻译记得 **同时** 加 zh-CN + en-US, 否则 silent fallback. 配套 P2-a i18n_audit 上线后可自动 catch.

### 5.8 prefer i18n.t (singleton) over hook in non-component
class component (ErrorBoundary) + 纯 function (relativeTime) 不能 useTranslation hook, 用 `import i18n from 'i18next'` + `i18n.t(key, fallback, params)`. 跟 F22/F24 同款.

### 5.9 IPC sender frame F17 严格化
所有新加 IPC handler 用 `safeIpcHandle` wrapper, 不要直接 `ipcMain.handle` (绕 safety check). 加新 channel 跟着写 vitest case (4 个: file/localhost/evil/empty).

---

## 6. 立即可跑的验收命令

```bash
# 1. backend 全测试
cd /Users/chenyuanquan/Documents/MailAgent
source venv/bin/activate
pytest tests/calendar_sync/ tests/calendar_notion/ tests/cli/test_calendar.py tests/cli/test_calendar_expand.py -q
# 期望: 263 passed (Phase 3 改动后可能 ↑)

# 2. frontend
cd frontend
pnpm typecheck
pnpm vitest run tests/main/calendar.test.ts
# 期望: typecheck pass + 35 passed

# 3. legacy 数据分布 (Phase 3 下线前 snapshot)
sqlite3 -header data/sync_store.db "
SELECT source, COUNT(*) AS n,
       SUM(CASE WHEN rrule != '' THEN 1 ELSE 0 END) AS with_rrule
FROM calendar_event WHERE deleted_at IS NULL
GROUP BY source"

# 4. legacy import refs (Phase 3 下线 P0-b 前 must zero)
grep -rn "from src.calendar import\|from src.calendar\." src tests 2>/dev/null | grep -v "src/calendar_"
# 期望: 0 hit 才可删 src/calendar/

# 5. PM2 看 calendar-sync 进程
pm2 status | grep calendar-sync
# 期望: 还跑着. Phase 3 下线时 stop + delete.

# 6. backup pre-phase3
cp data/sync_store.db data/sync_store.db.pre-phase3-backup
```

---

## 7. 关键文件 (按改动可能性排序)

### Phase 3.1 legacy 下线
1. `calendar_main.py` (root) — **删**
2. `src/calendar/` 整目录 — **删** (grep 验证零 ref 后)
3. `ecosystem.config.js` (PM2) — 删 calendar-sync 进程
4. `src/cli/commands/admin.py` 或 `cleanup-syncstore` 命令 — 加 `--legacy-calendar` 选项

### Phase 3.2 大重构
5. `src/calendar_sync/service.py` — **新建** facade
6. `src/cli/commands/calendar.py` (1479 行) — 13 subcommand 改用 service
7. `frontend/src/electron/main/handlers/calendar.ts` (861 行) — 拆成 read/write/sync 3 file
8. `src/calendar_sync/repository.py` — 加 connection pool
9. `src/calendar_sync/rsvp.py` — organizer freshness check

### Phase 3.3 tooling
10. `scripts/dev/i18n_audit.py` — **新建**
11. `tests/e2e/calendar-rsvp-edit-delete.spec.ts` — **新建** (Playwright)
12. `tests/calendar_sync/test_caldav_writer_roundtrip.py` — **新建** vobject round-trip

### Stay-out (除非用户明确要求)
- 数据层 / IPC 公共 schema (`shared/api/types.ts` — Phase 2 完整)
- 路由 (`router-instance.tsx`)
- mockup ref (`frontend/ref/mockup-calendar*.html` — 视觉基线锁定)
- PRD (`docs/calendar-module-prd.md` — 产品需求不变)

---

## 8. 给下个 Session 的开场白模板 (handoff prompt)

```
继续 Calendar 模块. 上次 session ship F1-F32 共 24 项 review fix (sonnet 第一
轮 Critical+High + opus max-effort 第二轮 C1+H1/H2/H3+Medium + A/B backlog 段
清理). 22 atomic commits ship 到 feat/agent-harness 分支.

读 docs/calendar-phase3-handoff.md (本文件) — 完整状态 + Phase 3 待办 + 风险.
不要重读 docs/calendar-next-session-handoff.md (已 stale, 被本文件取代).

本 session 目标: Phase 3 完整做完 ~8-12h:

1. P0 (3-4h): Legacy 下线
   - backup data/sync_store.db
   - grep verify zero src.calendar import refs
   - 删 calendar_main.py + src/calendar/ + PM2 calendar-sync 进程
   - source='legacy_calendar_app' rows 数据迁移 (推荐 archive 表方案)

2. P1 (6-10h): 架构大重构
   - src/calendar_sync/service.py 新建 CalendarService facade
   - cli/commands/calendar.py 1479 行 13 subcommand 改用 service
   - handlers/calendar.ts 861 行拆 read/write/sync 3 file
   - repository.py 加 connection pool (threading.local)
   - rsvp.py 加 organizer freshness check

3. P2 (5-7h): tooling/测试 (时间够就做, 否则留 Phase 4)
   - scripts/dev/i18n_audit.py: 扫 t(...) vs locale tree, 检 missing/collision
   - Lucide tree-shake bundle size 验证
   - e2e Playwright RSVP/编辑/删除/撤销链
   - caldav_writer PARTSTAT round-trip 真 vobject parse/serialize 测

策略:
- 每个 P0/P1/P2 子项独立 atomic commit
- 后端改完跑 pytest, 前端跑 typecheck + vitest, 全 green 才下一项
- P0 风险高: 先 backup db, PM2 progression 是 stop → 观察 24h → delete
- 顺手做 i18n parity 检查的话 P2-a 优先(防新增 collision)

预期 commit 数: P0 ~3 + P1 ~5 + P2 ~4 = ~12 commits
预期最终 pytest: 263+ passed (含新 round-trip / e2e 测试)

电话亭 / blocker:
- caldav-only events related_email_internal_id=0 — Phase 2.4 已解决
- ctag 走 1h time-fallback — DavMail 6.7 known bug, 不要再修 (§5.6)
- macOS Sequoia provenance lock — sudo xattr -dr 清 (§5.3)
- git race (ping-island fork concurrent) — git add <files> 显式 stage (§5.2)
- i18n: zh + en 同时加, 用 i18n.t singleton for class/纯 function (§5.7/§5.8)
- IPC: 所有新 channel 用 safeIpcHandle wrapper + 4 个 vitest case (§5.9)
```
