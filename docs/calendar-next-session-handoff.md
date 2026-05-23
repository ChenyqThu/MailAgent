# Calendar Module — Next Session Handoff

**From**: Session @ 2026-05-23 (Phase 0+1+2+3+1.5 ship)
**To**: 下个 session (跟 claude design mockup 一起做 UI 优化)
**Status**: 数据层 + 后端 + CLI + 前端 5 视图骨架全 ship; UI 视觉待 mockup 改进
**Read first**: `docs/calendar-module-prd.md` (产品需求 + 当前状态全描述)

---

## 1. 已 ship 内容 (5 commits)

```
d178c9b fix(frontend-calendar): /calendar/recurring 扫描结果映射
706788d refactor(calendar): Phase 1.5 — discover_recurring 改读 calendar_event 表
478baac feat(frontend-calendar): Phase 3 — /admin/calendar 月/周/日/agenda 视图 + SSoT IPC
c8d241d feat(calendar): SSoT inversion Phase 0+1+2 — CalDAV → SQLite + CLI
```

详细成果见 `docs/calendar-module-prd.md` §10 验收 checklist (已通过的勾掉了).

---

## 2. 下个 session 做什么

**主线**: 用户拿 PRD 给 claude design, 得到 mockup (Figma / 截图) → 按 mockup 改前端视图。

**关键文件 (按改动可能性排序)**:
1. `frontend/src/shared/components/calendar/views/` (4 文件) — 4 个视图组件
2. `frontend/src/shared/components/calendar/EventBlock.tsx` / `EventChip.tsx` — 单事件渲染
3. `frontend/src/shared/components/calendar/EventDetailDrawer.tsx` — 详情抽屉
4. `frontend/src/shared/components/calendar/CalendarToolbar.tsx` — 顶部工具栏
5. `frontend/src/shared/components/layout/CalendarLayout.tsx` — 视图调度 + PageFrame

**不需要碰 (除非用户明确要求)**:
- 数据层 / IPC handler (`frontend/src/electron/main/handlers/calendar.ts`)
- 路由 (`frontend/src/shared/router-instance.tsx`)
- API types (`frontend/src/shared/api/types.ts`)
- 后端 Python (`src/calendar_sync/` / `src/calendar_notion/`)

---

## 3. 重要 caveat (避开踩坑)

### 3.1 Electron main process 不会 HMR
**血泪教训**: `pnpm dev` 改 `frontend/src/electron/main/**/*.ts` 文件后, 必须**完全重启 electron** (Ctrl+C `pnpm dev` 再启) — Cmd+R 只 reload renderer, main process bundle 不会重编, 跑的还是 OLD handler。

Renderer 文件 (`frontend/src/shared/**/*.tsx`) 才能 HMR。

### 3.2 mail-sync (PM2) 加载新 Python 代码也要重启
改 `src/calendar_sync/` 或 `src/calendar_notion/` 后必须 `pm2 restart mail-sync` —
- CLI fork 新进程, 用新代码 ✓
- 但 PM2 内 worker 用 OLD Python bytecode, 不会自动 reload

### 3.3 caldav-only events 的 `internal_id=0`
RecurringInvitesPage 表里现在每行 `internal_id=0` (因为 caldav-only events 没邮件源), 点 [Replay] 会失败。**Phase 2 要重做 Replay 语义**: 改成"从 calendar_event 重导出 Notion", 不需要 email 重 fetch。

Mockup 阶段可以暂时移除/置灰 Replay 按钮, 或换成 "Re-sync to Notion" 按钮。

### 3.4 ctag 取不到 → 数据延迟
DavMail 6.7 CalDAV PROPFIND getctag XML 解析炸 (caldav lib bug). worker 兜底走 1h time-fallback. 现象:
- `mailagent calendar sync-status` 返 `ctag=null` 正常
- 用户在 Outlook 改了日历, 最多 1h MailAgent 才看到
- 急用 → toolbar [同步] 按钮 manual trigger

不要尝试再修这个 — 已加 try/except + 时间兜底, 进一步修需换成 sync-token 或 IMAP IDLE 信号, 工作量大。

### 3.5 CalDAV expand=False 后窗口外 master 也保留
Phase 1.5 改了 `cal.search(expand=False)`. 现在 SQLite 里:
- Master events with RRULE: 即使 dtstart 在 2025 年, 也保留 (因为 RRULE 在 2026 仍 valid)
- Single events: 严格按 dtstart 在窗口内才保留

前端 `eventsList` IPC handler 用 npm `rrule` 在 main process 展开 RRULE → 按窗口过滤 → 返 renderer。**不要在 renderer 里再次展开**, 会重复。

### 3.6 跟 Agent Harness 并行 session
之前一段时间有另一个 session 在做 Agent Harness 工作 (PR-1d.x). 他们的 commits 在我们前面 (08a1d52 / ae6f7ca / 13d3b9f / 07947ff). 偶尔会有文件 overlap (e.g. `frontend/src/shared/api/types.ts` 我加 calendar types, 他们加 chat types). 改这些文件前 `git diff` 看一眼最新。

---

## 4. 立即可跑的验收命令

```bash
# 1. 后端: 看 worker 状态 + 数据分布
KEY=$(grep "^MAILAGENT_CLI_API_KEY=" .env | cut -d= -f2-)
mailagent --api-key "$KEY" calendar sync-status -o json | jq '.data.calendars'
mailagent --api-key "$KEY" calendar today -o json | jq '.data | {total, events: .events | map({summary, start: .occurrence_start_iso[:16]})}'
mailagent --api-key "$KEY" calendar week -o json | jq '.data.total'
mailagent --api-key "$KEY" calendar recurring discover -o json | jq '.data.total_series'
# 预期: sync-status 1 calendar, week 总数 2-5, recurring 13

# 2. 数据分布
sqlite3 -header data/sync_store.db "
SELECT source, COUNT(*) AS n,
       SUM(CASE WHEN rrule != '' THEN 1 ELSE 0 END) AS with_rrule
FROM calendar_event WHERE deleted_at IS NULL GROUP BY source"
# 预期: caldav | 55 | 13

# 3. 前端
cd frontend && pnpm dev
# 浏览 /admin/calendar → 默认 ?view=week
# 切到 today / month / agenda 试新视图
# ?view=recurring → "扫描" 按钮, 0.5s 返 13 series
```

---

## 5. 工作流建议

**收到 mockup 后**:
1. 把 mockup 截图丢给 claude code → "按这个 mockup 改 frontend/src/shared/components/calendar/views/WeekView.tsx"
2. 一次只改一个视图, 不要 4 个一起改 (失败回滚成本高)
3. 每改一个视图: `pnpm typecheck:web` → 重启 pnpm dev → 视觉对比
4. Toolbar / EventDetailDrawer / EventChip / EventBlock 是跨视图共享的, 优先改这几个
5. 用 `pnpm test -- calendar` 跑现有测试, 避免 IPC handler 回归

**改完后**:
- `pnpm typecheck` 干净 (允许 Agent Harness chat 残留 5 个错, 跟 calendar 无关)
- `pnpm test -- tests/main/calendar.test.ts` 13/13 通过
- 视觉跟 mockup 对比一遍
- commit message 用 `feat(frontend-calendar):` 或 `style(frontend-calendar):` prefix

---

## 6. 联系点 / 参考文档

- **PRD**: `docs/calendar-module-prd.md` ← 主要文档, 含所有需求 + 数据模型 + 视图规格
- **架构 v15 SQLite schema**: `src/mail/sync_store.py:210` `DB_VERSION=15` 注释 + `_init_database()` 里 calendar_event 表 DDL
- **Plan 历史**: `~/.claude/plans/frontend-view-silly-knuth.md` ← 当初的多阶段计划
- **Python 单测**: `tests/calendar_sync/` (58 tests) + `tests/cli/test_calendar.py` (32 tests)
- **TS 单测**: `frontend/tests/main/calendar.test.ts` (13 tests)
- **CLAUDE.md**: 主项目指南, calendar 部分待补 (这次 session 一起更新)

---

## 7. Phase 2+ 路线图 (跟 mockup 一起规划)

| Phase | 内容 | 触发条件 |
|---|---|---|
| 2.1 RSVP | 抽屉里 [接受/暂定/拒绝] 按钮 → SMTP iTIP REPLY | UI mockup 稳定后 |
| 2.2 创建事件 | toolbar [+ 新建] 弹窗 → CalDAV PUT | 2.1 跑通后 |
| 2.3 编辑/删除 | 抽屉 [编辑] [删除] → CalDAV PUT/DELETE | 2.2 跑通后 |
| 2.4 Replay 重做 | 从 calendar_event 重导出 Notion | 跟 2.1 同期 |
| 3 Legacy 下线 | 删 calendar_main.py + src/calendar/ + PM2 calendar-sync | 2-4 周稳定运行后 |
| 4 多 calendar | 共享日历切换 chip | 2.x 全 ship 后 |
| 5 跨设备 | HttpApi proxy / 移动 | V2 |

详见 `docs/calendar-module-prd.md` §7.

---

## 8. 给下个 session 的开场白模板

```
继续 calendar 模块迭代. 上次 session 给 claude design 出了 mockup.

读这两份文档:
- docs/calendar-module-prd.md (产品需求 + 当前状态)
- docs/calendar-next-session-handoff.md (上次 ship + caveat)

这次 session 任务: 按 mockup 改前端视图. mockup 在 [图片/Figma 链接]. 优先级:
1. WeekView (主视图, landing)
2. EventDetailDrawer
3. EventChip + EventBlock
4. Toolbar
5. (MonthView / DayView / AgendaView 看 mockup 完整度)

电话亭/blocker:
- Electron main 文件改完必须重启 pnpm dev
- mail-sync 不动 (后端无改动)
```
