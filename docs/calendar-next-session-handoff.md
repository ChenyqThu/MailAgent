# Calendar Module — Next Session Handoff

**From**: Session @ 2026-05-23 15:00 (行为层 PR — §3.1/3.2/3.3/3.4 + §4.5, 1 commit)
**To**: 下个 session (UI polish 实测 + Phase 2 写能力评估)
**Status**: 行为层 5 件事 ship 完, 数据自动 refetch + 副 status bar 透明; UI polish 还要 dev server 视觉验; Phase 2 RSVP 未动
**Read first**:
  - `docs/calendar-module-prd.md` (产品需求 + 数据模型 + 视图规格, 不变)
  - 本文件 (新待办 + caveat)
  - 旧 handoff 已合入 §1 (commit `82943fe`), git history `48db62d` 是上一份

---

## 1. 本次 session ship 内容 (1 commit)

```
82943fe feat(frontend-calendar): handoff §3 行为层优化 — auto refetch + 副 status bar 自动同步显示
```

**核心变化** (4 file +90/-38):
- `hooks/useCalendarEvents.ts`:
  - `useCalendarEventsInWindow` 加 `refetchInterval: 60_000` + `refetchOnWindowFocus: true` + `refetchIntervalInBackground: false` (跟后端 worker 60s ctag 轮询同频)
  - `useCalendarSyncTrigger.trigger` 用 `useCallback` 包成 ref-stable (mut.mutate v5 stable, 让外部能放心当 dep)
  - **抽提 export**: `relativeTime(d: Date): string` + `useNowTick(tickMs?): number` (toolbar 和 status bar 共用, 不再各写一份)
- `CalendarPage.tsx`: recurring useQuery 去 lazy — 删 `enabled: false` / `staleTime: 5*60_000` / `refetchOnMount: 'always'` (Phase 1.5 后 discover_recurring 改读 SQL ~0.5s, 不再 davmail 慢路径); EmptyState 合并 undefined + length===0; `isFetching && !data` short-circuit (refetch in background 不闪屏)
- `CalendarToolbar.tsx`: 删本地 `relativeTime`, import hooks 版; `useNowTick()` 让 "上次同步 N 秒前" 自然走时; sync 按钮 title 改 "急刷 (⌘R) · 后台 worker 每 60s 自动同步, 此按钮触发立即全量拉取"
- `CalendarLayout.tsx`: 副 status bar 加 "自动同步 N 秒前" (从 `head?.last_incremental_sync_at_iso ?? head?.last_full_sync_at_iso` 拿); `setView` + `handleToday/Prev/Next/Sync/Help/Esc` 全部 `useCallback` 包 (§4.5 闭包问题 — 避免 keydown listener 每次 render unbind+re-bind)

---

## 2. 数据流现状 (跟 PRD §3 / CLAUDE.md §calendar 一致, **本次行为有变**)

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
     │   ├─ events:list  → useCalendarEventsInWindow (staleTime 60s, ✅ refetchInterval 60s, ✅ refetchOnWindowFocus)
     │   ├─ events:get   → useCalendarEvent (drawer lazy fields)
     │   ├─ sync:status  → useCalendarSyncStatus (✅ refetchInterval 60s)
     │   ├─ recurring:discover → useQuery ✅ 主动 fetch (staleTime 5min, refetchOnMount 'always')
     │   └─ sync:trigger → manual 同步按钮 (语义改为 "急刷")
     └─ mailagent calendar CLI (today/week/event-get/etc.)
```

**关键事实** (变化):
- ✅ **后端 worker 自动 60s ctag 轮询** — 数据本身一直在更新
- ✅ **前端 events 自动 refetch** (本次 ship) — 长停 calendar 视图也能 1min 内拿到新事件; 回 tab 立即刷; 后台 tab 不刷省功
- ✅ **recurring 主动 fetch** (本次 ship) — 切到 recurring tab 立即拉, 5min cache
- ✅ **副 status bar 自动同步可见** (本次 ship) — "自动同步 N 秒前" 让用户知道 worker 在跑

---

## 3. 待办 — UI Polish (中优先, 需要 dev server)

### 3.1 ★ dev server 实测 + 视觉对比 mockup
本次 session 全程 typecheck driven, 没启 `pnpm dev`. 下个 session 必须:
- `cd frontend && pnpm dev`
- 浏览 `/admin/calendar`, 切 5 视图对照 `frontend/ref/mockup-calendar.html` (Chrome 双窗口对比)
- 验:
  - 切 calendar 视图后 1 分钟内是否真有自动 refetch (打开 devtools Network 看 `/api/calendar/eventsList` 60s 调一次)
  - 副 status bar "自动同步 N 秒前" 是否每 30s 走时, 且后端 worker 跑完后从 "55 秒前" 跳回 "刚刚"
  - 切到 recurring tab 是否立即看到列表 (不需要点扫描)
  - 按 G+W / G+M / T / ← → / ⌘R / ? 测 hotkey, 看是否在 view 切换后仍生效 (useCallback 包 callback 后 listener 不该 leak)
- 截屏发 claude design / 用户 review

### 3.2 light 主题验证
mockup 是 dark first design. 我加的 sync-tip / cal-statusbar / drawer 都 dark 主题视觉测了 (mental model), light 主题没实测. 可能有色对比度问题. 切 light: 全局 settings → appearance → 切 Light, 验:
- drawer 阴影是否清晰
- sync-pill data-sync='err' 时 errpulse 颜色 (#E36262 fail) 在 light 下应该够鲜
- glass-2 cal-card 透明度

### 3.3 副 status bar 视觉重做
当前实现简单 inline (cal-statusbar class), 用户可能反馈"还不如不要". 可能改进:
- 边框 -t 太突兀 → 改成 cal-card 内 absolute 浮动条 (mockup 是 cal-card 之外 + 全局 statusbar 之上)
- 字体太小 11px → 改 11.5px / mono 加 letter-spacing
- 信息冗余 → 砍掉 "DavMail bridge" / "calendar_event v15" 运维向元数据, 改用户向 "上次同步 30s 前 · 47 events · 13 recurring"

### 3.4 EventChip empty title 兜底
我所有视图 `event.summary || '(无标题)'`, mockup 是 `event.summary` 直接. 实际数据无标题事件很少, 我加的 `(无标题)` fallback 视觉上略嘈杂. 改:
- 真正空 → 显示 `<span className="empty-field">未命名事件</span>` (italic 灰)

### 3.5 (可选) toolbar sync 按钮视觉降级
当前 sync 按钮 = `.nav-btn` 拉宽 (跟 nav 按钮同等显眼). 后台自动同步后, sync 应该弱化成 "急刷" 概念. 视觉降级方案:
- 改文案 "刷新" 而非 "同步"
- 移到 sync-pill 右侧而非左侧 (信息更优先)
- 或者直接砍掉, 完全靠 sync-pill 显示状态 + ⌘R 触发

PRD 没规定, 看 mockup 是保留显眼按钮. 本次只改了 hover title 文案明确"急刷"语义, 视觉不动. 用户实测后再评估是否进一步降级.

---

## 4. 待办 — 功能完善 (Phase 2+)

跟 PRD §7 + 旧 handoff §5 一致, 本次 session 没动 Phase 2:

| Phase | 内容 | 入口位置 | 当前状态 |
|---|---|---|---|
| **2.1 RSVP** | drawer 接受/暂定/拒绝 按钮 → SMTP iTIP REPLY | EventDetailDrawer dw-foot 3 个 .dw-act | disabled stub (visual only) |
| **2.2 创建事件** | toolbar [+ 新建] 弹窗 → CalDAV PUT | toolbar 加按钮 (mockup 无) | 未做 |
| **2.3 编辑/删除** | drawer [编辑] [删除] → CalDAV PUT/DELETE | drawer 加 2 个按钮 | 未做 |
| **2.4 Replay 重做** | 从 calendar_event 重导出 Notion | CalendarPage Row Replay 按钮 | placeholder for caldav-only events |
| **3 Legacy 下线** | 删 calendar_main.py + src/calendar/ + PM2 calendar-sync | — | 等 2-4 周稳定 |
| **4 多 calendar** | 共享日历切换 chip | toolbar 加 chip (mockup 未画) | 未做 |
| **5 跨设备** | HttpApi proxy / 移动 | — | V2 |

### Phase 2.1 RSVP 立项要点 (下次 session 评估)
- **后端**: 需要在 `src/calendar_sync/` 加 `send_itip_reply(ical_uid, response_status)` 方法
  - 拼 RFC 5546 iTIP REPLY (VCALENDAR with METHOD:REPLY + ATTENDEE PARTSTAT 字段)
  - 通过 DavMail SMTP (`127.0.0.1:1025`) 发回组织者
  - 同步更新 SQLite `calendar_event.response_status`
- **IPC**: 加 `calendar:rsvp` handler in `frontend/src/electron/main/handlers/calendar.ts`
- **前端**: `EventDetailDrawer.tsx` 3 个 `.dw-act` 改 button + useMutation
- **CLI**: `mailagent calendar rsvp <ical_uid> {accept|tentative|decline}` (跟 read 路径平行)
- **测试**: tests/main/calendar.test.ts 加 rsvp handler contract; pytest 加 iTIP REPLY 拼装单测
- **风险**: 误点拒绝按钮 → 已发送到组织者 (不可撤销). 需要 confirm dialog 或 undo within 5s.

---

## 5. 已知 caveat / 不要踩坑 (跟旧 handoff §6 一致, 此处保留高优先级几条)

### 5.1 Electron main process 不会 HMR
改 `frontend/src/electron/main/**/*.ts` 必须完全重启 `pnpm dev` (Ctrl+C 再启). Renderer (`frontend/src/shared/**/*.tsx`) 才能 HMR. **本次改动全在 renderer**, 走 HMR 即可.

### 5.2 mail-sync (PM2) 加载新 Python 代码也要重启
改 `src/calendar_sync/` 或 `src/calendar_notion/` 后 `pm2 restart mail-sync`.

### 5.3 ctag 取不到 → 数据延迟
DavMail 6.7 CalDAV PROPFIND getctag XML 解析炸 (caldav lib bug). worker 走 1h time-fallback. 用户改日历最多 1h MailAgent 才看到, 急用 → toolbar [同步]. **不要尝试再修这个** — 已加 try/except + 时间兜底, 进一步修需换 sync-token 或 IMAP IDLE, 工作量大.

### 5.4 caldav-only events `internal_id=0` Replay 失效
Phase 1.5 后 caldav-only events 没邮件源, internal_id=0. 当前实现是灰色 placeholder "Replay" 文字. Phase 2.4 改"基于 calendar_event 重导出 Notion".

### 5.5 react-query auto refetch 跟 worker poll 同频 (本次新增)
本次改成 `refetchInterval: 60_000`, 跟 worker 60s 同步. 最坏情况 (用户开 calendar 60s + worker poll 0s + worker 写完 → 前端 refetch 0s) 时刚好同时. 实际 race 影响小 — worker write 是单事务, 前端 read 拿到 commit 后的快照. 但若发现 events list 偶尔少 1-2 个新事件, 可能就是这个 race, 调成 `refetchInterval: 70_000` 错峰.

### 5.6 useNowTick 在 toolbar 和 layout 两处分别调用
两个独立 `setInterval(30_000)` — 不会冲突但稍微重复. React DevTools profiler 看应该是两个 useState tick 各自更新 toolbar / status bar. 若以后嫌冗余, 可以提升到 PageFrame 级别 Context, 但当前不值得.

### 5.7 useCalendarSyncTrigger 的 trigger 是 useCallback 包的 (本次新增)
`trigger` 现在 ref-stable (假设 `mut.mutate` v5 stable). 外部消费者 (CalendarLayout / CalendarToolbar / 未来 keyboard handler) 可以放心当 useEffect / useCallback 的 dep — 不会触发 re-bind. 若发现 isPending 状态没更新到外部, 看是不是 useMutation 内部 mut 引用确实有变 (v4 → v5 升级 edge case, 文档说稳定).

### 5.8 git race condition (上次 session 教训, 仍有效)
本 session 期间另一个并行 session 在 ship KOS PR-2c/2d/2e/2f. 本次 commit 用 `git commit -o <files> -F msg` 显式 only-commit 4 个 calendar 文件, 绕开 staging area, 没受 race 影响. 下次仍建议同样姿势.

### 5.9 ChatSidebar.tsx 3 个 pre-existing TS error (新发现)
KOS Sprint 14 PR J commit `7b6aed7` 留的债. `tsconfig` strict 模式下 `tsc --noEmit` 报:
```
ChatSidebar.tsx(181|194|209,X): Type '"left"' is not assignable to type '"bottom" | "top" | undefined'
```
跟 calendar 无关. 下次跑 typecheck 出现仍这 3 个, 不阻塞 calendar 工作, 但应该排查 — 看 Tooltip / Popover 的 side prop 是不是改过 enum.

---

## 6. 立即可跑的验收命令

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

# 3. 前端 — 重点验本次 ship 的自动 refetch
cd frontend && pnpm dev
# /admin/calendar 默认 week, devtools Network 看 60s 一次 eventsList 调用
# 切 recurring tab 不点扫描应该立即看到列表
# cal-card 底部副 status bar 应有 "自动同步 N 秒前", 每 30s 走时
# hover toolbar 同步按钮看 title "急刷 (⌘R) · 后台 worker 每 60s 自动同步..."
# 按 G+W / G+M / T / ← → / ⌘R / ? 验 hotkey 在 view 切换后仍工作
```

---

## 7. 给下个 session 的开场白模板

```
继续 calendar 模块. 上次 session ship 1 commit (82943fe) 完成 handoff §3
行为层 — events / recurring 自动 refetch + 副 status bar 自动同步显示 +
keyboard shortcut callback useCallback. 数据流现在用户长停 1min 内能拿到
后端 worker 拉的新事件, recurring 也不再 lazy.

读这两份文档:
- docs/calendar-module-prd.md (产品需求 / 数据模型)
- docs/calendar-next-session-handoff.md (本次 ship + §3 UI Polish 待办)

本次 session 优先级:
1. ★ §3.1 dev server 实测 — 启 pnpm dev 真跑一遍 calendar /admin/calendar,
   devtools Network 验自动 refetch, 验副 status bar 走时, 验 hotkey 在
   view 切换后仍 work. 截屏 review.
2. §3.2 light 主题验证 — 切 Light, 验 drawer 阴影 / sync-pill 错误态 / glass-2
   透明度.
3. §3.3 副 status bar 视觉重做 (依据用户反馈)
4. §3.4 EventChip empty title 改成 italic 灰
5. §4 Phase 2.1 RSVP 立项 (见本文 §4 立项要点)

电话亭 / blocker:
- Electron main 不动, 所有改动 renderer HMR (§5.1)
- ChatSidebar.tsx pre-existing TS error 不阻塞但应排查 (§5.9)
- React DevTools profiler 验 useNowTick 两次调用是否真的 30s tick (§5.6)
```

---

## 8. 关键文件 (按改动可能性排序)

行为层稳定后, 重心移到 UI polish + Phase 2 写能力:

1. `frontend/src/shared/components/calendar/EventDetailDrawer.tsx` ★★ Phase 2.1 RSVP 入口
2. `frontend/src/shared/components/calendar/CalendarToolbar.tsx` — §3.5 sync 视觉降级 / Phase 2.2 新建按钮
3. `frontend/src/shared/components/layout/CalendarLayout.tsx` — §3.3 副 status bar 重做
4. `frontend/src/shared/components/calendar/EventChip.tsx` — §3.4 empty title 兜底
5. `frontend/src/shared/components/calendar/EventBlock.tsx` — §3.4 同上 (week/day timeline 用)
6. `frontend/src/electron/renderer/index.css` — utility class 库 (calendar 段在末尾)
7. `frontend/src/shared/components/calendar/hooks/useCalendarEvents.ts` — 加 RSVP mutation
8. `frontend/src/shared/components/calendar/CalendarPage.tsx` — Phase 2.4 Replay 改 "重导出"
9. `frontend/src/electron/main/handlers/calendar.ts` — Phase 2 写 IPC handlers (calendar:rsvp / create / update / delete)
10. `src/calendar_sync/` (Python) — Phase 2 后端 send_itip_reply + CalDAV PUT/DELETE 实现

**不需要碰 (除非用户明确要求)**:
- 行为层 hooks (本次已稳定): `useCalendarEvents.ts` 的 refetch/staleTime
- 路由 (`frontend/src/shared/router-instance.tsx`)
- API types (`frontend/src/shared/api/types.ts`) — 除非 Phase 2 加 RSVP 字段
- mockup ref (`frontend/ref/mockup-calendar.html` — 锁定基线)
