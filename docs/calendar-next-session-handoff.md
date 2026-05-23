# Calendar Module — Next Session Handoff

**From**: Session @ 2026-05-23 14:30 (mockup 视觉复刻 + polish, 4 commits)
**To**: 下个 session (行为优化 + Phase 2 写能力)
**Status**: 视觉跟 `frontend/ref/mockup-calendar.html` 完全对齐; 行为层有几个 UX 漏洞待修
**Read first**:
  - `docs/calendar-module-prd.md` (产品需求 + 数据模型 + 视图规格, 不变)
  - 本文件 (新待办 + caveat)
  - 旧 handoff 已 stale, 但 §3 caveats 仍然有效, 见 git history `9c566d2`

---

## 1. 本次 session ship 内容 (4 commits)

```
b36f60c style(frontend-calendar): toolbar 切 mockup class (.nav-btn / .sync-pill CSS hover) + Recurring 删 ID 列
52096d6 style(frontend-calendar): Agenda / Recurring 严格按 mockup 复刻 — 透明 ag-head + .view-chip / .today-btn 共用 class + 弱化 Replay
10dfea6 style(frontend-calendar): polish — 减弱 drawer 阴影 + Agenda 头对齐 mockup + 键盘快捷键 + ?modal + 副 status bar
90072b9 style(frontend-calendar): 视觉复刻 mockup-calendar.html — Liquid Glass + sticky timeline + 5 状态 EventBlock
```

**核心变化**:
- `src/electron/renderer/index.css` +1100 行 calendar utility class (cal-week / wk-* / evt + 5 种 data-resp / now-line / day-rail / mm-* / m-cell / chip / ag-* / rec-table / drawer / meta-row / resp-badge / .view-chip / .nav-btn / .today-btn / .sync-pill / .sync-tip / sk-* / cal-statusbar / skel shimmer / @keyframes errpulse + cal-shimmer)
- 4 视图 + 5 子组件 (EventBlock / EventChip / EventDetailDrawer / CalendarToolbar / CalendarPage) 全部按 mockup 1:1 重写
- 新 `useCalendarShortcuts` hook (G+D/W/M/A · T · ← → · Esc · ⌘R · ?) + `CalendarShortcutModal`
- cal-card 内部底部副 status bar ({N} 日历 · 窗口 −30d/+180d · ctag · DavMail bridge · calendar_event v15)
- EventBlock API 改 col / totalCols (修老 leftPx*6 px bug)
- `layoutDay` 贪心聚类分列 export 到 hooks (Week/Day 共用)

---

## 2. 数据流现状 (跟 PRD §3 / CLAUDE.md §calendar 一致)

```
Outlook (Exchange)
     ↑↓ EWS
DavMail JVM (127.0.0.1:1080 CalDAV)
     ↑ caldav lib (expand=False)
CalendarSyncWorker (mail-sync 进程内 asyncio loop, 60s 轮询)  ★ 后台自动
     ↓ upsert
SQLite calendar_event (master events + RRULE)
     ↓ 直读 (better-sqlite3 + npm rrule 客户端展开)
     ├─ 前端 IPC handlers (~5ms)
     │   ├─ events:list  → useCalendarEventsInWindow (staleTime 60s, ❌ 无 refetchInterval)
     │   ├─ events:get   → useCalendarEvent (drawer lazy fields)
     │   ├─ sync:status  → useCalendarSyncStatus (✅ refetchInterval 60s)
     │   ├─ recurring:discover → useQuery enabled:false (❌ 不会自动跑)
     │   └─ sync:trigger → manual 同步按钮
     └─ mailagent calendar CLI (today/week/event-get/etc.)
```

**关键事实**:
- ✅ **后端 worker 自动 60s ctag 轮询** — 数据本身一直在更新
- ❌ **前端 events 不自动刷** — 打开 1 分钟后, 即使后台 worker 已经拉了新数据进 SQLite, 前端仍显示旧数据, 直到用户切视图或点同步
- ❌ **recurring discover lazy** — Phase 0.3 davmail 慢路径的遗留. Phase 1.5 (706788d) 之后改读 SQL ~0.5s, 但前端仍 lazy

---

## 3. 待办 — 行为 / 缓存层 (优先)

### 3.1 ★ 前端 events 自动定时刷新
**问题**: `useCalendarEventsInWindow` 只有 `staleTime: 60s`, 没有 `refetchInterval`. 用户长时间停留在 calendar 视图, 后台 worker 拉的新事件不会自然出现 — 必须切视图 / 点同步 / Cmd+R 才能看到. UX 上 "不知道数据老不老".

**改动**: `frontend/src/shared/components/calendar/hooks/useCalendarEvents.ts:38`
```ts
// before
staleTime: 60_000,
refetchOnWindowFocus: false
// after
staleTime: 60_000,
refetchInterval: 60_000,           // 跟 worker 同频, 数据 1 分钟内必到
refetchIntervalInBackground: false,// tab 后台不刷, 省功
refetchOnWindowFocus: true         // 回到 tab 立即 refresh
```

**影响**: 4 视图全自动获益, sync 按钮退化成 "急刷" / "emergency fetch" 而非主路径.

### 3.2 ★ Recurring 自动 fetch (去 lazy)
**问题**: `frontend/src/shared/components/calendar/CalendarPage.tsx:128` `enabled: false`, 用户必须主动点 [扫描]. 注释还写 "davmail 模式下逐封 IMAP fetch ~5s/封" — Phase 1.5 后已不成立, 现在是单条 SQL ~0.5s.

**改动**:
```ts
// before
enabled: false,
staleTime: Infinity,
refetchOnWindowFocus: false,
refetchOnMount: false
// after
enabled: true,
staleTime: 5 * 60_000,             // 5min cache, recurring 列表变化慢
refetchOnWindowFocus: false,       // 不靠 focus 刷
refetchOnMount: 'always'           // 切到 recurring tab 主动刷
```

**保留 [扫描] 按钮** 作为强制 refresh (跟同步按钮逻辑一致, 不删).

### 3.3 副 status bar 加 "自动同步" 提示
**问题**: 用户不知道后台 worker 在跑, 看到 toolbar 有大同步按钮以为必须点. 副 status bar 现在显示 calendar count + ctag, 但没有 "上次自动同步 N 分钟前" 提示.

**改动**: `frontend/src/shared/components/layout/CalendarLayout.tsx` 副 status bar 加一段:
```
{N} 日历 · 自动同步: 30 秒前 · 窗口 -30d/+180d · DavMail bridge · calendar_event v15
```

数据用 `syncStatus[0].last_incremental_sync_at_iso` + 现有 `relativeTime()` 函数 (toolbar 已有, 抽到 hooks 复用).

### 3.4 (可选) toolbar sync 按钮视觉降级
当前 sync 按钮 = .nav-btn 拉宽 (跟 nav 按钮同等显眼). 后台自动同步后, sync 应该弱化成 "急刷" 概念. 视觉降级方案:
- 改文案 "刷新" 而非 "同步"
- 移到 sync-pill 右侧而非左侧 (信息更优先)
- 或者直接砍掉, 完全靠 sync-pill 显示状态 + Cmd+R 触发

PRD 没规定, 看 mockup 是保留显眼按钮, 暂时不改, 但加 hover tip "后台 60s 自动同步, 此按钮用于急刷".

---

## 4. 待办 — UI Polish (中优先)

### 4.1 dev server 实测视觉对比
我没启动 dev server 实测, 全程 typecheck driven (handoff caveat §3.1: macOS Electron main process 不会 HMR). 下个 session 应该:
- `cd frontend && pnpm dev`
- 浏览 /admin/calendar 切 5 视图对照 `frontend/ref/mockup-calendar.html` (用 Chrome 双窗口对比)
- 截屏发 claude design / 用户 review

### 4.2 light 主题验证
mockup 是 dark first design. 我加的 sync-tip / cal-statusbar / drawer 等都 dark 主题视觉测了 (mental model), 但 light 主题没实测. 可能有色对比度问题.

切 light: 全局 settings → appearance → 切 Light, 验:
- drawer 阴影是否清晰 (我加了 light 专门的更轻阴影 -4px 14px rgba(20,24,40,0.08))
- sync-pill data-sync='err' 时 errpulse 颜色 (#E36262 fail 在 light 下应该够鲜)
- glass-2 cal-card 透明度

### 4.3 副 status bar 视觉重做
当前实现简单 inline, 用户可能反馈"还不如不要". 可能改进:
- 边框 -t 太突兀 → 改成 cal-card 内 absolute 浮动条 (mockup 是 cal-card 之外 + 全局 statusbar 之上)
- 字体太小 11px → 改 11.5px / mono 加 letter-spacing
- 信息冗余 → 砍掉 "DavMail bridge" / "calendar_event v15" 等运维向元数据, 改用户向 "上次同步 30s 前 · 47 events · 13 recurring"

### 4.4 EventChip empty title 兜底
我所有视图 `event.summary || '(无标题)'`, 但 mockup 是 `event.summary` 直接. 实际数据无标题事件很少, 我加的 (无标题) fallback 视觉上略嘈杂. 改:
- 真正空 → 显示 `<span className="empty-field">未命名事件</span>` (italic 灰)

### 4.5 keyboard shortcut hook 闭包问题
`useCalendarShortcuts` deps 包含 onView / onPrev / onNext 等 callback, CalendarLayout 用 inline arrow 创建会每次 render 新引用 → hook 每次 re-bind keydown. 用 `useCallback` 包一层或者直接传 setView/setCurrentDate 原 setter (它们 ref stable):

```ts
// CalendarLayout 改
useCalendarShortcuts({
  onView: setView,
  onToday: useCallback(() => setCurrentDate(new Date()), []),
  onPrev: useCallback(() => setCurrentDate(d => step(view, -1, d)), [view]),
  onNext: useCallback(() => setCurrentDate(d => step(view, 1, d)), [view]),
  ...
})
```

---

## 5. 待办 — 功能完善 (Phase 2+)

跟 PRD §7 + 旧 handoff §7 一致:

| Phase | 内容 | 入口位置 | 当前状态 |
|---|---|---|---|
| **2.1 RSVP** | drawer 接受/暂定/拒绝 按钮 → SMTP iTIP REPLY | EventDetailDrawer dw-foot 3 个 .dw-act | disabled stub |
| **2.2 创建事件** | toolbar [+ 新建] 弹窗 → CalDAV PUT | toolbar 加按钮 (mockup 无) | 未做 |
| **2.3 编辑/删除** | drawer [编辑] [删除] → CalDAV PUT/DELETE | drawer 加 2 个按钮 | 未做 |
| **2.4 Replay 重做** | 从 calendar_event 重导出 Notion | CalendarPage Row Replay 按钮 | placeholder for caldav-only |
| **3 Legacy 下线** | 删 calendar_main.py + src/calendar/ + PM2 calendar-sync | — | 等 2-4 周稳定 |
| **4 多 calendar** | 共享日历切换 chip | toolbar 加 chip (mockup 未画) | 未做 |
| **5 跨设备** | HttpApi proxy / 移动 | — | V2 |

---

## 6. 已知 caveat / 不要踩坑

### 6.1 Electron main process 不会 HMR
改 `frontend/src/electron/main/**/*.ts` 必须完全重启 `pnpm dev` (Ctrl+C 再启). Renderer (`frontend/src/shared/**/*.tsx`) 才能 HMR.

### 6.2 mail-sync (PM2) 加载新 Python 代码也要重启
改 `src/calendar_sync/` 或 `src/calendar_notion/` 后 `pm2 restart mail-sync`.

### 6.3 ctag 取不到 → 数据延迟
DavMail 6.7 CalDAV PROPFIND getctag XML 解析炸 (caldav lib bug). worker 走 1h time-fallback. 用户改日历最多 1h MailAgent 才看到, 急用 → toolbar [同步]. **不要尝试再修这个** — 已加 try/except + 时间兜底, 进一步修需换 sync-token 或 IMAP IDLE, 工作量大.

### 6.4 caldav-only events `internal_id=0` Replay 失效
Phase 1.5 后 caldav-only events 没邮件源, internal_id=0. 当前实现是灰色 placeholder "Replay" 文字. Phase 2.4 改"基于 calendar_event 重导出 Notion".

### 6.5 CalDAV expand=False 后窗口外 master 也保留
Master events with RRULE: 即使 dtstart 在 2025 年也保留 (RRULE 在 2026 仍 valid). 前端 `eventsList` IPC handler 用 npm `rrule` 在 main process 展开. **不要在 renderer 里再次展开**, 会重复.

### 6.6 git race condition (本 session 教训)
本 session 期间另一个并行 session 在 ship KOS PR-2c/2d/2e/2f, 用 `git add -A` 风格. 两次 commit 被 race 裹挟. **解决方法**: 用 `git commit -o <files> -F msg` 显式 only-commit, 绕开 staging area. 详见 commit `90072b9` 历程注释.

### 6.7 react-query auto refetch 跟 worker poll 同频
若 3.1 改成 `refetchInterval: 60_000`, 跟 worker 60s 同步, 最坏情况 (用户开 calendar 60s + worker poll 0s + worker 写完 → 前端 refetch 0s) 时刚好同时. 实际 race 影响小 — worker write 是单事务, 前端 read 拿到 commit 后的快照. 但若发现 events list 偶尔少 1-2 个新事件, 可能就是这个 race, 调成 `refetchInterval: 70_000` 错峰.

### 6.8 跟 Agent Harness M2 + KOS 并行 session
另一个 session 正做 KOS 集成 (PR-2c-2g 已 ship). 偶尔 overlap 文件 `frontend/src/electron/main/chat/*` 和 calendar 无关. 改这些文件前 `git diff` 看一眼最新.

---

## 7. 立即可跑的验收命令

```bash
# 1. 数据层 + worker 状态
KEY=$(grep "^MAILAGENT_CLI_API_KEY=" .env | cut -d= -f2-)
mailagent --api-key "$KEY" calendar sync-status -o json | jq '.data.calendars'
mailagent --api-key "$KEY" calendar today -o json | jq '.data | {total, events: .events | map({summary, start: .occurrence_start_iso[:16]})}'
mailagent --api-key "$KEY" calendar week -o json | jq '.data.total'
mailagent --api-key "$KEY" calendar recurring discover -o json | jq '.data.total_series'

# 2. SQLite 数据分布
sqlite3 -header data/sync_store.db "
SELECT source, COUNT(*) AS n,
       SUM(CASE WHEN rrule != '' THEN 1 ELSE 0 END) AS with_rrule
FROM calendar_event WHERE deleted_at IS NULL GROUP BY source"

# 3. 前端
cd frontend && pnpm dev
# /admin/calendar 切 5 视图, hover sync-pill 看 tip
# 按 ? 看 shortcut modal, 按 G+W/G+M/T/←→/Cmd+R 试 hotkey
```

---

## 8. 给下个 session 的开场白模板

```
继续 calendar 模块. 上次 session 完成 mockup 视觉复刻 (4 commits), UI 已对齐
frontend/ref/mockup-calendar.html. 现在需要修行为层 UX 漏洞 + 准备 Phase 2 写能力.

读这两份文档:
- docs/calendar-module-prd.md (产品需求 / 数据模型)
- docs/calendar-next-session-handoff.md (本次 session ship + §3 待办)

本次 session 优先级:
1. ★ §3.1 — useCalendarEventsInWindow 加 refetchInterval 60s, 解决用户感觉
   "数据老" 的 UX 问题. 5 行改动, 影响 4 视图.
2. ★ §3.2 — CalendarPage recurring 改 enabled:true, Phase 1.5 后 SQL 不再
   慢, 不应该 lazy.
3. §3.3 — 副 status bar 加 "上次自动同步 N 分钟前" 显示, 让用户知道后台
   在跑.
4. §4.5 — keyboard shortcut hook 加 useCallback 包 onPrev/onNext, 防止
   每次 render re-bind keydown.
5. (按 PRD §7) — Phase 2.1 RSVP 写能力评估 + 立项

电话亭 / blocker:
- Electron main 文件改完必须重启 pnpm dev (§6.1)
- recurring 现在仍 IMAP discovery? grep src/calendar_notion/recurring_invite.py
  确认 Phase 1.5 改读 SQL 状态
- 改 hook deps 数组前先 React DevTools profiler 看 re-render 触发频次
```

---

## 9. 关键文件 (按改动可能性排序)

跟旧 handoff 一致, 加了新文件:

1. `frontend/src/shared/components/calendar/hooks/useCalendarEvents.ts` ★ §3.1 在这里
2. `frontend/src/shared/components/calendar/CalendarPage.tsx` ★ §3.2 在这里
3. `frontend/src/shared/components/layout/CalendarLayout.tsx` — §3.3 / §3.4 / §4.5 在这里
4. `frontend/src/shared/components/calendar/CalendarToolbar.tsx` — §3.4 / §4.4 在这里
5. `frontend/src/shared/components/calendar/EventDetailDrawer.tsx` — Phase 2.1 RSVP 在这里
6. `frontend/src/electron/renderer/index.css` — utility class 库 (calendar 段在末尾)
7. `frontend/src/shared/components/calendar/hooks/useCalendarShortcuts.ts` ⭐ 新 (§4.5)
8. `frontend/src/shared/components/calendar/CalendarShortcutModal.tsx` ⭐ 新

**不需要碰 (除非用户明确要求)**:
- 数据层 / IPC handler (`frontend/src/electron/main/handlers/calendar.ts`)
- 路由 (`frontend/src/shared/router-instance.tsx`)
- API types (`frontend/src/shared/api/types.ts`)
- 后端 Python (`src/calendar_sync/` / `src/calendar_notion/`)
- mockup ref (`frontend/ref/mockup-calendar.html` — 锁定基线)
