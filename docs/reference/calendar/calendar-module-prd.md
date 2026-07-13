# Calendar Module — PRD

**Status**: Phase 1+2 全套 ship — 数据层 (c8d241d/478baac/706788d/d178c9b) +
Phase 2 写能力 (RSVP 98b017f / 事件 CRUD 719cf93 / Replay 重做 a9489ce) +
行为层 (82943fe) + 周视图列宽 fix (e47b9b7). 重心移到 UI polish + 多 calendar +
RRULE/全天事件 等高级写能力, **mockup 设计 brief 见 §12**
**Owner**: 内部产品 / MailAgent
**为谁写**: claude design (出 mockup) → 后续 frontend 实现 (1:1 复刻)
**Date**: 2026-05-23 (Phase 2 ship 时点)

---

## 1. 背景

MailAgent 用户 Lucien 同时在 Outlook (公司日历) 和 Notion (个人 PM 库) 之间工作. 现有路径:
- 邮件里收到的 .ics 邀请 → 解析 → 写 Notion calendar database
- 旧 `calendar_main.py` 进程读 macOS Calendar.app → 写 Notion (legacy, 待下线)

**问题**:
- Outlook 端用户直接创建的事件 (不通过邮件邀请) 在 MailAgent 里不可见
- 共享日历 / 别人没邀请你但你能看到的会议不可见
- 现有 `/admin/calendar` 页面只有一个"邮件邀请扫描"运维表, **不是日历**

**Phase 1 解决方案 (已实现)**:
DavMail CalDAV 桥接 Outlook → SQLite `calendar_event` 表 → 前端日历模块. 数据 SSoT 在 SQLite, 前端读, 后端 CalendarSyncWorker 每小时拉 master events + RRULE.

---

## 2. 目标用户 + 核心使用场景

**用户**: 单人, macOS Electron 桌面 (不考虑移动 / web)
**日均日历事件**: 5-15 个 (含展开)
**主要活动时段**: 9:00-19:00 工作时段, 周一-周五

**Top 5 场景**:

1. **早晨打开 app, 一眼看今天日程** → Today / Week 视图, 默认 landing
2. **快速看本周谁邀请我开会, 是不是已经接受** → Week 视图 + EventChip 显示 response status
3. **临时找下个月某周的 reserve 时间** → Month 视图, hover 看密度
4. **从邮件邀请跳到日历事件 (或反过来)** → EventDetail 抽屉里 "关联邮件" 跳转
5. **查所有定期会议, 决定哪个要取消** → Recurring 列表视图

### 反目标 (Phase 1 不做)
- 创建 / 编辑 / 删除事件 (Phase 2)
- RSVP (接受/拒绝邀请) (Phase 2)
- 多日历切换 / 共享日历单独列 (V2)
- 跨账户 (V2)
- 移动 / web (V2)

---

## 3. 数据模型 (SQLite SSoT)

### `calendar_event` 表 (DB v15, 已实现)

```
id                   INTEGER PRIMARY KEY        # 内部自增
ical_uid             TEXT NOT NULL              # RFC 5545 UID
recurrence_id        TEXT                       # 非空 = 单次跳脱 occurrence
sequence             INTEGER DEFAULT 0          # iTIP 版本号
calendar_name        TEXT                       # "日历" / "Work" / 共享日历名
summary              TEXT                       # 会议标题
description          TEXT                       # 描述 (含 Teams 链接)
location             TEXT                       # 地点
organizer            TEXT                       # 组织者 email (mailto 已剥)
attendees_json       TEXT (JSON)                # [{email, name, response, role}]
dtstart_utc          REAL NOT NULL              # 起始 UTC epoch
dtend_utc            REAL                       # 结束 UTC epoch
is_all_day           INTEGER                    # 全天事件标志
rrule                TEXT                       # FREQ=WEEKLY;BYDAY=MO;... (主事件才有)
exdates_json         TEXT (JSON)                # 跳过日期 list
rdates_json          TEXT (JSON)                # 额外发生日期 list
status               TEXT                       # CONFIRMED / TENTATIVE / CANCELLED
response_status      TEXT                       # ACCEPTED / TENTATIVE / DECLINED / NEEDS-ACTION
url                  TEXT                       # Teams / Zoom 链接
source               TEXT                       # caldav / email_ics / legacy_calendar_app
notion_page_id       TEXT                       # Notion 镜像 (可选)
related_email_internal_id INTEGER               # 邮件邀请派生时关联邮件
last_synced_at       REAL                       # CalendarSyncWorker 上次同步时间
deleted_at           REAL                       # 软删除 (服务端删除检测)
```

### 关键不变量
- 主事件: `recurrence_id IS NULL`, 可能有 `rrule != ''`
- 跳脱 occurrence: `recurrence_id` = 该 occurrence 的原始 dtstart ISO
- 时间一律 UTC epoch, 前端 `toLocaleString` 转本地展示
- UNIQUE `(ical_uid, COALESCE(recurrence_id, ''), source)` — NULL 也参与去重
- CalendarSyncWorker 拉的 master events 不在客户端展开 — 客户端用 `rrule` npm lib 按窗口展开

### 当前实测数据样本 (用户 Lucien 的 DB)
- 55 master events (~7 月窗口 -30d/+180d)
- 13 个含 RRULE (SaaS 双周 / ENBU 日总结 / Omada 双周 / 网安周 / B2B SIOP 月 / PM 双周 / etc)
- 42 个单次 event
- 所有事件 `calendar_name="日历"` (中文, 默认 Outlook calendar 名)

---

## 4. 视图规格

URL 形态: `/admin/calendar?view=<view>` (TanStack Router)

| view | 路径 | 默认 | 用途 |
|---|---|---|---|
| `today` | `/admin/calendar?view=today` |  | 单日 24h timeline |
| `week` | `/admin/calendar?view=week` | ✓ | 7 列 × 24h timeline (周视图) |
| `month` | `/admin/calendar?view=month` |  | 6×7 grid (月视图) |
| `agenda` | `/admin/calendar?view=agenda` |  | 按日 group 的列表 |
| `recurring` | `/admin/calendar?view=recurring` |  | 定期邀请运维表 |

### 4.1 公共布局
- **顶部 Toolbar** (所有视图共享):
  - 左: 模块标题 "日历" + 当前日期范围 (e.g. "5/22 周五" / "5/22 - 5/28" / "2026年 5月")
  - 中: 日期导航 [上一段] [今天] [下一段] (today/week/month 视图才有)
  - 右: 视图切换 chip 组 [今日 / 周 / 月 / Agenda / 定期邀请]
  - 最右: [同步] 按钮 + "上次同步: 5分钟前" 相对时间

- **主内容区**: 一个 `bg-ink-2 border` 卡片, 内部按视图渲染
- **右侧抽屉** (EventDetailDrawer): 点击任意事件浮出, 420px 宽

### 4.2 EventChip (月/Agenda 单格事件)
```
┌──────────────────────────────┐
│ ◾ 09:00 智能助手周例会 🎦  │   ← time + summary + meeting link 图标
└──────────────────────────────┘
```
- 高度 ~26px, 可点击 → 打开 EventDetailDrawer
- **响应状态视觉编码**:
  - `ACCEPTED` / `CONFIRMED`: 正常显示
  - `TENTATIVE`: 75% opacity
  - `DECLINED`: 50% opacity + 删除线
  - `NEEDS-ACTION`: coral border 1px (需要回复提醒)
  - `status=CANCELLED`: 40% opacity + 删除线
  - 过期事件: 60% opacity (但不删除线)

### 4.3 EventBlock (周/日 timeline 块)
```
┌─────────────────┐
│ 09:00 🎦        │   ← 时间 + 会议链接
│ Weekly Sync     │   ← summary
│ Teams Meeting   │   ← location (高度足够才显示)
└─────────────────┘
```
- 按事件持续时间 stretch 高度 (40px/小时 在 week, 48px/小时 在 day)
- 最小高度 24px 防文字溢出
- 并发事件横向分列 (贪心算法)

### 4.4 EventDetailDrawer (右侧抽屉)
```
┌──── 标题 (truncate) ────────────────── × ─┐
│                                            │
│  时间        2026-05-26 10:00 → 11:00     │
│  日历        日历                          │
│  地点  📍   Teams Meeting                  │
│  组织者 👤  boss@example.com               │
│  与会者 👥  (4):                           │
│             - Lucien Chen [已接受]         │
│             - Alice <a@x> [暂定]           │
│             ...                            │
│  我的回复   已接受                         │
│  会议链接 🎦 https://teams.microsoft.com/.│
│  关联邮件 📨 #53120 ↗                      │
│                                            │
│  重复规则   FREQ=WEEKLY;BYDAY=MO          │
│  描述       (multi-line, max-h-48)         │
│                                            │
│  ─────────────────────────────────────     │
│  UID: 040000008200E00074C5...              │
│  源: caldav (RRULE 实例)                   │
└────────────────────────────────────────────┘
```
- ESC 关闭 / 点 backdrop 关闭
- "关联邮件" 链接跳 `/?internal_id=<id>` (回 inbox 选中该邮件)
- "会议链接" 在浏览器外开

### 4.5 各视图细节

#### DayView (单日 timeline)
- 24h 网格, 60min 间隔, 每小时 48px
- 全天事件顶部 strip
- 时间段并发分列 (贪心)
- 当前时间一条 coral 横线 (可选, Phase 1 没做)

#### WeekView (7 列 × 24h)
- ISO 周 (周一开始)
- 每列 fr 1 (均分)
- 今天列 `bg-coral/5` 高亮
- 全天事件跨 7 天 strip
- 每小时 40px (周视图缩 vs day 视图)

#### MonthView (6×7 grid)
- 起始周一
- 当前月外的格子 `bg-ink-2/60`
- 每格显示日期 + 最多 3 个 EventChip
- 第 4+ 个事件: "+N 更多" 按钮 → 点击展开该格 (popover 或 in-place)
- 当前日期 `bg-coral/5` 高亮 + "今天" 角标

#### AgendaView (列表)
- 默认 14 天窗口
- 按本地日期 group, 每组一个 header (`今天 (5/22)` / `明天 (5/23)` / `5/24 周日`)
- 单行 EventChip, 紧密排列
- 顶部"刷新"按钮 (manual refetch)

#### RecurringView (`/admin/calendar?view=recurring`, 老 CalendarPage)
- 表格列: `ID | 标题 | 组织者 | RRULE | 首次 | 末次 | 计数 | 操作`
- "扫描" 按钮主动触发 (enabled: false, 不 auto fetch)
- "Replay" 按钮 (current: caldav-only events `internal_id=0` 无效, **Phase 2 重做**)
- 日期范围 chip 30/90/180/365

---

## 5. 交互 + 状态

### 5.1 加载状态
- 视图切换瞬间: skeleton row (现有 `SkeletonRow`)
- 同步进行: toolbar 同步按钮 spinner

### 5.2 空状态
- 单日无事件 → "本日无日程" + 日历 icon
- 整周无事件 → "本周无日程"
- 整月无事件 → "本月无日程"
- Recurring 默认未扫描 → "未扫描" + 提示点击扫描

### 5.3 错误状态
- DavMail 连接失败 → toolbar "上次同步" 显示 `[ERR]`, hover 看详情
- CalDAV reader probe 失败 → 同步按钮 disabled, toast 提示
- IPC handler timeout → React Query onError → toast 显示

### 5.4 关键交互流
1. **App 启动 → /admin/calendar → 默认 week view**
2. **点击 EventBlock → 右抽屉浮出**
3. **抽屉里点击关联邮件 → 跳 /?internal_id=X (邮件视图选中)**
4. **抽屉里点击 Teams 链接 → 外部浏览器**
5. **toolbar 切 month → URL ?view=month, 显示当月**
6. **toolbar 切日期 → 仅在 today/week/month 视图改 currentDate state, URL 不变**
7. **点击同步 → 跑 `mailagent calendar sync-now`, 完成后 toast + invalidate 事件 query**

---

## 6. 视觉风格 (跟现有 design system 对齐)

### 6.1 现有 token (在 tailwind config 里)
- `text-display` / `text-aux` / `text-meta` / `text-micro` — 字号阶梯
- `text-ink-fg` / `text-ink-fg-1` / `text-ink-fg-2` / `text-ink-fg-3` — 灰阶
- `bg-ink-1` / `bg-ink-2` / `bg-ink-3` — 背景灰阶 (1 浅 3 深, 用作 popover / page / element)
- `border-ink-border` / `border-ink-border-soft` — 边框 (soft 用于内部分隔)
- `bg-coral/15` / `text-coral` — accent color (品牌/选中态), `coral/5` 用作淡背景
- `duration-fast` — transition (~150ms)

### 6.2 参考其他模块的视觉密度
- 跟 `EmailList` 一致的密度 (tabular-nums + text-aux + 紧凑 padding)
- 跟 `LlmDashboardPage` 一致的卡片层级 (`rounded-md border bg-ink-2`)

### 6.3 inspiration (可参考但不抄)
- **Fantastical** (macOS): 月视图密度 + 全天事件 chip 渲染
- **Notion Calendar (Cron)**: timeline 块的浮动 + 抽屉详情
- **Outlook web**: 周视图列分隔 + 当前时间线
- **Schedule-X demo**: 视图切换流畅度

### 6.4 设计约束 (claude design 必须遵守)
- 主色仅用 `coral`, 不引入新颜色
- 不引入新 lib (除现有 `lucide-react` icons + `@radix-ui/*` 已装)
- 字体: 仅系统默认 + 数字处用 `font-mono tabular-nums`
- 没有任何 emoji 装饰 (功能 emoji 如 🎦 表示 Teams 链接 OK)
- 间距用 Tailwind 4px 阶梯 (gap-1/2/3, p-1/2/3 等)
- 必须支持 dark mode (ink-* 系列自动适配)

---

## 7. Phase 2+ 路线图 (Phase 2 ✅ ship, 新 Phase 2.5/3/4/5 在路上)

### Phase 2: 写能力 ✅ **2026-05-23 全套 ship** (6 commits)

- [x] **2.1 RSVP** (commit `98b017f`): drawer 3 button 真发 RFC 5546 iTIP REPLY 给
      organizer (DavMail SMTP 1025); response_status 高亮当前状态; native confirm 防误点;
      CLI `mailagent calendar rsvp <ical_uid> {accept|tentative|decline}`; 49 pytest
- [x] **2.2 创建事件** (commit `719cf93`): toolbar [+ 新建] → EventFormModal 表单
      (标题/起止/地点/描述/与会者) → CalDAV PUT (1080); CLI `calendar create`
- [x] **2.3 编辑/删除** (commit `719cf93`): drawer [编辑] 复用同 modal (预填) →
      CalDAV PUT + SEQUENCE+1; [删除] confirm → CalDAV DELETE; CLI `calendar update/delete`;
      29 pytest (test_caldav_writer)
- [x] **2.4 Replay 重做** (commit `a9489ce`): 基于 SQLite calendar_event 行重导出 Notion,
      任何 source 都可 (caldav-only events 也能 replay); CLI `calendar replay <ical_uid>`;
      22 pytest

### Phase 2.5: UI polish (mockup 引领, §11/§12 详)

- [ ] **EventFormModal 视觉 polish** (§11.1) — 当前 inline Tailwind 简洁但糙; 抽
      .modal-* class + attendees chip 输入 + 改 datetime picker
- [x] **删除 undo toast** (§11.2) — 5s 撤销窗口 (替代 native confirm); 已 ship
      `UndoToastStack.tsx` + `shared/state/calendar-undo.ts`
- [ ] **light 主题验证** (§11.3) — Phase 2 全程 dark first 设计, light 主题没实测
- [ ] **EventChip empty title 兜底** (§11.4) — `(无标题)` 改 italic 灰 `未命名事件`
- [ ] **副 status bar 视觉重做** (§11.5) — 用户向 vs 运维向元数据分离
- [x] **RSVP vs owner ops 视觉分流** (§11.6) — 已 ship: `EventDetailDrawer.tsx`
      isOwner (organizer === user.email) 二分 owner 操作行 vs RSVP 行 + dw-role badge

### Phase 3: legacy 下线 (Phase 2 跑稳 2-4 周后)

- [ ] 删 `calendar_main.py` + `src/calendar/` 整目录 + PM2 `calendar-sync` 进程
- [ ] `source='legacy_calendar_app'` 老 events: archive 表 / soft delete / 留着不动
- [ ] CLI `admin cleanup-syncstore --legacy-calendar` 清残留

### Phase 4: 数据质量 + 高级写能力 (中期)

- [ ] **CTag fallback 优化**: 换 sync-token (RFC 6578) 或 IMAP IDLE 信号 (当前 1h
      time-fallback, 用户改日历最多 1h 才同步)
- [x] **多 calendar 支持** (★ 高优先级, §11.7) — 已 ship: toolbar 多日历 chips
      (`CalendarToolbar` selectedCalendars) + EventFormModal create calendar 选择 +
      worker F8 自动拉全部 calendars
- [x] **全天事件** (§11.8 前半) — 已 ship: EventFormModal [全天] toggle + CalDAV
      `VALUE=DATE`; **跨时区 tz select 未做** (= issue #10, icebox)
- [x] **周期事件创建/编辑 (RRULE)** (§11.9) — 已 ship: EventFormModal "重复" 段
      (`RRuleEditor.tsx`) + 编辑分 "改这一次 / 改未来 / 改整个系列" 3 模式
      (update_occurrence / split_series)
- [ ] **FTS5 搜索**: `calendar_event_fts` 表 + 顶栏 ⌘K 搜会议
- [ ] **右键菜单** (§11.10) — EventBlock/Chip 右键弹 [打开/复制链接/跳邮件/复制 UID/删除]

### Phase 5: 跨设备 (V2)

- [ ] Web SPA: `HttpApi.calendar.*` 走 FastAPI proxy (当前 stub `notImplemented`)
- [ ] iOS / Android: 移动专属视图设计

---

## 8. 性能 + 可观察性

### 8.1 现状 (Phase 1 实测)
- CLI `mailagent calendar today` / `week`: ~0.4s (含 CLI 冷启动 ~0.3s + SQLite ~0.05s)
- IPC `calendar:eventsList` (better-sqlite3 直读): **目标 <50ms**, 实测受 npm rrule 展开影响
- Worker `sync-now` (CalDAV → SQLite): ~6-10s (DavMail 单次 round-trip + reconcile)
- DB size: 55 events ≈ 50 KB

### 8.2 监控
- `mailagent calendar sync-status` 实时看 ctag / last_full_sync_at / last_error
- `pm2 logs mail-sync` grep `calendar-sync-worker` 看 tick 行为
- `sqlite3 data/sync_store.db "SELECT source, COUNT(*) FROM calendar_event GROUP BY source"` 看分布

### 8.3 错误降级
- DavMail 不可用 → 前端按上次 SQLite 缓存渲染 + toolbar 提示
- caldav lib bug → 按已实现的 try/except 兜底返 None
- 任何 IPC handler 异常 → React Query onError → toast

---

## 9. 已知限制 + 风险

| 限制 | 影响 | Mitigation |
|---|---|---|
| CalDAV `cal.search` 默认 limit 100/请求, DavMail 端原始事件 1462+ (±2y) | 远期 events 不全 | 默认窗口 -30d/+180d 内事件够看; 想看更远改 `.env CALENDAR_CALDAV_SYNC_WINDOW_FUTURE_DAYS` |
| DavMail PROPFIND getctag 返非标准 XML | ctag 取不到, worker 1h time-fallback 才主动 sync | 用户改了日历最多 1h 延迟; 急用点同步按钮 |
| caldav-only event `related_email_internal_id=0` | Replay 按钮无效 | Phase 2 改 Replay 语义 |
| CalDAV server 偶尔不响应 expand=False | 单次同步空结果 | reconciler 不做 soft-delete (空集合不算 "事件被删") |
| 时区: 跨时区会议显示需要 `toLocaleString` | UTC epoch 存储, 渲染时转 | 已实现, 但夏令时切换边界没测 |
| 多人共享日历事件可能在 attendees 里没我 | 自己的 response_status 取不到 | EventDetailDrawer 显示 `—` 而非误判 |

---

## 10. 验收 checklist (功能交付状态)

### 数据层 (Phase 1 ✅)
- [x] DB v15 calendar_event + calendar_sync_state 表
- [x] CalendarSyncWorker 启动后 60s 内拉到 events
- [x] 55 events 落 SQLite, 13 个 RRULE 保留完整 RRULE 字符串
- [x] `mailagent calendar today/week/recurring discover` 都返正确数据

### 视图 (Phase 1 ✅, 等 mockup 优化)
- [x] 5 个视图都能渲染 (today/week/month/agenda/recurring)
- [x] EventBlock 按时长 stretch + 并发分列
- [x] EventChip 响应状态视觉编码
- [x] EventDetailDrawer 显示完整字段 + 关联邮件跳转
- [x] **周视图列宽对齐** (commit `e47b9b7` scrollbar-gutter fix)
- [ ] 视觉密度 / 配色 / 间距 ← **claude design 优化 (§11)**
- [ ] DayView 当前时间线
- [ ] MonthView "+N 更多" popover (现 in-place 展开不太好)
- [ ] Recurring 视图整体布局优化 (现 Sprint 6 老表格)

### 边缘状态
- [x] 空状态 (3 个视图都有 EmptyState)
- [x] 加载 skeleton
- [x] **副 status bar "自动同步 N 秒前" 显示** (commit `82943fe`)
- [ ] 同步失败的 toolbar 红点
- [ ] 抽屉里 "数据加载中..." vs 字段为空的区分

### 交互 (Phase 1+ ✅)
- [x] 视图切换 (URL ?view=)
- [x] 日期导航 (上一/今天/下一)
- [x] 手动同步按钮 / 急刷
- [x] **events 60s 自动 refetch + window focus refetch** (commit `82943fe`)
- [x] **recurring 主动 fetch** (commit `82943fe`, 不再 lazy)
- [x] **keyboard shortcuts** G+D/W/M/A · T · ← → · ⌘R · ? · Esc
- [ ] 右键菜单 (§11.10)

### Phase 2 写能力 ✅ **全套 ship 2026-05-23**
- [x] **2.1 RSVP**: drawer 3 button 真发 iTIP REPLY (commit `98b017f`)
- [x] **2.2 创建事件**: toolbar [+ 新建] modal → CalDAV PUT (commit `719cf93`)
- [x] **2.3 编辑事件**: drawer [编辑] modal → CalDAV PUT + SEQUENCE+1 (commit `719cf93`)
- [x] **2.3 删除事件**: drawer [删除] confirm → CalDAV DELETE (commit `719cf93`)
- [x] **2.4 Replay**: 任何 source 重导出 Notion (commit `a9489ce`)
- [x] **测试**: 后端 pytest 78 全过 (22 replay + 49 RSVP/iTIP + 29 caldav_writer);
      前端 vitest 28 全过

### Phase 2.5 UI polish (待 mockup 引领, §11/§12 详)
- [ ] EventFormModal 视觉 polish (§11.1)
- [x] 删除 undo toast (§11.2) — `UndoToastStack.tsx` + `calendar-undo.ts`
- [ ] light 主题验证 (§11.3)
- [ ] EventChip empty title fallback (§11.4)
- [ ] 副 status bar 视觉重做 (§11.5)
- [x] RSVP vs owner ops 视觉分流 (§11.6) — EventDetailDrawer isOwner 二分

### Phase 4 (待 mockup + impl)
- [x] 多 calendar chip 切换器 (§11.7) — CalendarToolbar selectedCalendars chips
- [x] 全天事件 (§11.8 前半) — [全天] toggle + `VALUE=DATE`; 跨时区 tz select 未做 (= #10)
- [x] 周期事件 RRULE 创建/编辑 (§11.9) — `RRuleEditor.tsx` + 改这一次/改未来/改整系列

---

## 11. 待实现功能 — 详细 spec (给 claude design + impl 用)

每项包含 **需求 / 交互流程 / 后台设计 / UI 设计要求** 4 段, mockup 阶段必读.

### 11.1 ★ EventFormModal 视觉 polish

**需求**: 当前 inline Tailwind 实现简洁但糙. 用户每天会用 (新建/编辑事件), 视觉重要.

**交互流程**:
1. toolbar [+ 新建] 或 drawer [编辑] 触发
2. modal 居中淡入 (backdrop blur), 标题 "新建事件" / "编辑事件"
3. 字段: 标题 (必填) / 起止时间 / 地点 / 描述 / 与会者
4. 用户填表 → 点 [创建] / [保存]
5. modal 关闭, toast "事件已创建" / "已更新"

**后台设计**: 已实现 (`mailApi.calendar.eventCreate/eventUpdate`)

**UI 设计要求 (给 claude design)**:
- modal-card glass-2 style, 宽 480-520px, 圆角 12px, shadow xl
- 字段 vertical stack, label uppercase + 11.5px + tracking-wide
- 起止时间 grid 2 col 并排
- **与会者: chip 输入** (输入 email + Enter 加 chip, 点 × 删) — 当前用 textarea, 必改
- 主要 button [创建] / [保存] 用 coral; secondary [取消] 透明 + hover
- Esc 关闭 + Tab focus trap (a11y)
- 失败时 inline 错误显示 (标题为空 / 结束 ≤ 开始 等), 不弹 toast 干扰
- light + dark 两套截图

### 11.2 删除 undo toast (5s 撤销窗口)

**需求**: 当前 [删除] 是 native confirm + 立即 DELETE, 误点不可撤销. 用户怕.

**交互流程**:
1. drawer [删除] → 立即关 drawer, 弹 toast "事件已删除 [撤销]" 5s
2. 5s 内未撤销 → 真发 CalDAV DELETE
3. 5s 内点撤销 → cancel, drawer 重开

**后台设计**: 纯前端 setTimeout(5000) + flag, 不改后端

**UI 设计要求**:
- toast 屏幕底中, glass-2 + 5s 计时进度条 (圈圈或线条)
- [撤销] coral 描边突出
- 多 toast 时叠 (类似 macOS notification)

### 11.3 light 主题验证

**需求**: Phase 2 全程 dark first 设计, light 主题没实测.

**交互流程**: 用户切 settings → Light → calendar 视图功能不破坏.

**UI 设计要求 (给 claude design)**:
- 所有新加 component (EventFormModal / 编辑删除 button / 副 status bar) 在 light 下:
  - 对比度足够 (WCAG AA, 4.5:1)
  - coral 描边在 light 背景下足够鲜
  - glass-2 透明度调整
- **dark + light 两套 mockup 截图对照**

### 11.4 EventChip empty title fallback

**需求**: 偶有 summary 为空的事件; 当前显示 `(无标题)` 视觉嘈杂.

**UI 设计要求**:
- 月视图 EventChip / 周/日视图 EventBlock / Agenda 列表 / drawer 标题 全部统一
- 文本: italic + color: `ink-fg-3` (灰)
- 内容: **"未命名事件"** (不要 quoted, 不要括号)

### 11.5 副 status bar 视觉重做

**需求**: 当前 cal-card 底部 inline 一行, 内容混杂用户向 + 运维向.

**当前内容**: `47 日历 · 自动同步 30 秒前 · 窗口 -30d/+180d · ctag a3f8c2d · DavMail bridge · calendar_event v15`

**改进方向**:
- 用户向: `47 events · 13 recurring · 自动同步 30 秒前`
- 运维向: hover ℹ️ icon 弹 popover (DavMail bridge / db version / ctag)

**后台设计**: useCalendarSyncStatus 已有数据, 加 `events_total` (新 IPC 或 client-side count)

**UI 设计要求**:
- 视觉重做: cal-card 内底部浮动条 (类 mockup status pill) 还是保留 inline?
- font-size 11.5px → 12px + letter-spacing 0.02em
- 用户向 metric mono font (47 / 13 / 30s) 强调数字

### 11.6 RSVP vs owner ops 视觉分流

**需求**: drawer 同时显示 [接受/暂定/拒绝] (RSVP) + [编辑]/[删除] (owner ops).
实际:
- 自己组织 (organizer === user.email): RSVP 没意义, 服务端会拒
- 别人邀请: [编辑] [删除] 服务端会拒 (CalDAV 403)

**交互流程**:
1. drawer 加载时判断 `occurrence.organizer === user.email`
2. me === organizer: 隐藏 RSVP, 突出 [编辑] [删除]
3. me ≠ organizer: 突出 RSVP, [编辑] [删除] 标灰 + title "只能由组织者修改"

**后台设计**:
- 前端 user.email: 已有 settings.get() 但调用多, 加 user context 全局
- 后端不变

**UI 设计要求**:
- 两种模式视觉编码:
  - **owner 模式**: dw-actions 单行 [编辑] [删除] coral; 无 RSVP 段
  - **attendee 模式**: dw-actions 第一行 RSVP 3 button highlight; 第二行 [编辑] [删除] disabled
- 隐藏不显示 toggle 切换 (aria-hidden)
- (可选) drawer 顶部 badge "[组织者]" / "[与会者]" 标角色

### 11.7 多 calendar chip 选择器 (★ Phase 4 优先)

**需求**: 当前只默认 "日历". 用户可能有共享日历 / 个人多日历 / 订阅日历.

**交互流程**:
1. toolbar 加 chip 切换器 (类似 view chips 风格)
2. chip: [全部] [日历] [Work] [Shared] [Personal] (从 useCalendarNames)
3. 点 chip → URL `?calendar=Work` → events list 过滤
4. EventFormModal create 表单加 "添加到日历" 选项

**后台设计**:
- useCalendarNames 已 ship (Phase 1)
- CLI `mailagent calendar events --calendar X` 已支持
- eventsList opts 已有 calendarName 参数
- EventFormModal create 已支持 calendarName 参数

**UI 设计要求**:
- 跟 view chips 同视觉规范, 放在 view chips **左侧** (calendar 切 > view 切层次)
- [全部] chip 默认激活
- chip 数 > 5 时滚动 scroll-x

### 11.8 全天事件 + 跨时区 (Phase 4)

**需求**: 当前 EventFormModal 只支持 datetime, 全天事件不能新建; 只本地 tz 输入.

**交互流程**:
1. modal 顶部加 [全天] toggle
2. 勾选 → 隐藏 time inputs, dtstart/end 只 date
3. tz select 默认本地, 可选 UTC / 其他 IANA tz
4. 编辑现有全天事件: toggle 自动勾选 (从 occurrence.is_all_day)

**后台设计**:
- caldav_writer.build_vevent 需支持 `DTSTART;VALUE=DATE:20260530` (vs `DTSTART:20260530T140000Z`)
- CLI `mailagent calendar create --all-day --start 2026-05-30 --end 2026-05-31`
- tz: 前端 datetime-local + tz select → ISO with offset

**UI 设计要求**:
- [全天] toggle 用 switch (视觉重) 不是 checkbox
- toggle ON 时 time inputs 灰隐
- tz select 默认折叠, "高级" 按钮展开

### 11.9 周期事件 (RRULE) 创建/编辑 (Phase 4)

**需求**: 当前 EventFormModal 只能创建单次, RRULE 不支持. 编辑 RRULE 事件 save 会清掉.

**交互流程 (create)**:
1. modal 加 "重复" 段, 默认 "不重复"
2. 选 "重复" → 频率 select (每天 / 每周 / 每月 / 自定义)
3. 频率展开:
   - 每周: BYDAY 多选 (M T W T F S S)
   - 每月: 第 N 个 X 或 第 N 天
   - 自定义: RRULE 字符串 input (高级用户)
4. UNTIL: 永远 / 直到 X 日 / N 次后停

**交互流程 (edit RRULE 事件)**:
1. drawer [编辑] → 弹 dialog "改这一次 / 改未来 / 改整个系列"?
2. 改这一次: 创建 occurrence override (RECURRENCE-ID + 不带 RRULE)
3. 改未来: 老事件加 UNTIL = 改动前一秒, 新事件接着 RRULE
4. 改整个系列: 直接改 master event (SEQUENCE +1)

**后台设计**:
- caldav_writer.build_vevent 加 rrule 字段
- 改这一次: 新事件 UID 跟系列同 + RECURRENCE-ID
- CLI `mailagent calendar create --rrule "FREQ=WEEKLY;BYDAY=MO"`
- CLI `mailagent calendar update <uid> --rrule X --recurrence-id Y --mode single|future|all`

**UI 设计要求**:
- "重复" 段视觉收纳 (默认折叠 "不重复"), 类 Outlook/Google
- BYDAY 7 个小 chip toggle
- "改这一次/改未来/改整个系列" dialog radio + apply button
- 编辑 RRULE event 时 dialog 必弹 (不可绕过)

### 11.10 右键菜单 (Phase 4, 可选)

**需求**: EventBlock / EventChip 右键弹菜单, 快速 [打开] / [复制链接] / [跳关联邮件] / [复制 UID] / [删除].

**UI 设计要求**: native context menu style, glass-2 背景, 项之间 1px 分割.

---

## 12. Mockup 设计 brief (给 claude design)

下个 session 需 claude design 出 mockup 的 view / component (按优先级):

### 必出 mockup (Phase 2.5)

| # | 设计内容 | 参考 § | 输出文件 |
|---|---|---|---|
| 1 | EventFormModal 完整设计 (dark+light 两版) | §11.1 | `frontend/ref/mockup-event-form.html` |
| 2 | 副 status bar 重做 (用户向 metric + hover popover) | §11.5 | `mockup-calendar.html` §cal-statusbar 更新 |
| 3 | 删除 undo toast (5s 计时进度条) | §11.2 | `mockup-calendar.html` 加段 或 `mockup-toast.html` |
| 4 | RSVP vs owner ops 视觉分流 (drawer 两种模式) | §11.6 | `mockup-calendar.html` §EventDetailDrawer dw-foot 更新 |

### Phase 4 mockup

| # | 设计内容 | 参考 § | 输出文件 |
|---|---|---|---|
| 5 | 多 calendar chip 切换器 (toolbar 左侧) | §11.7 | `mockup-calendar.html` §toolbar 更新 |
| 6 | 全天事件 + 跨时区 UI (EventFormModal toggle) | §11.8 | `mockup-event-form.html` 变种 |
| 7 | 周期事件 (RRULE) UI ("重复" 段 + dialog) | §11.9 | `mockup-event-form.html` 变种 |

### 低优先 / 不必专门 mockup

| # | 设计内容 | 参考 § | 说明 |
|---|---|---|---|
| 8 | 右键菜单 | §11.10 | 标准 native context menu, impl 直接用 |
| 9 | EventChip empty title fallback | §11.4 | 文本统一 + italic + 灰色, impl 一行改 |

### 设计约束 (跟 §6.4 一致)

- 设计 token: 已在 `frontend/src/electron/renderer/index.css` (`--c-accent` / `--ink-*` 等)
- 视觉密度: 跟 inbox 模块对齐 (`mockup-inbox.html` 是参考)
- **dark 模式 first, light 主题必有**
- 不引新依赖 (现有 lucide-react / Tailwind / 自定义 class)
- a11y: focus visible / aria-label / keyboard nav

### 反馈 + iterate 流程

1. claude design 出 mockup HTML (按上表优先级 + 文件输出)
2. user 浏览器打开 review (`open frontend/ref/mockup-X.html`)
3. user / impl 反馈 — "这段太宽 / color 不够鲜 / 缺 hover state / 用 inbox 已有的 X pattern 复用"
4. claude design iterate 直到 user 满意
5. impl (本 agent) 按 mockup 1:1 复刻 (跟 calendar Phase 1 视觉实现路径一致, 见 commit `90072b9` 等)

### Impl 工作量预估 (mockup 完成后)

| Phase 2.5 工作量 | 估时 (Claude session) |
|---|---|
| EventFormModal polish (§11.1) | 2-3h |
| 删除 undo toast (§11.2) | 1h |
| light 主题验证 + 调 (§11.3) | 1-2h |
| EventChip empty title (§11.4) | 30min |
| 副 status bar 重做 (§11.5) | 1h |
| RSVP vs owner ops 分流 (§11.6) | 1.5h |
| **Phase 2.5 总** | **7-9h, 一个 session 内可完成** |

| Phase 4 工作量 | 估时 |
|---|---|
| 多 calendar chip (§11.7) | 2-3h |
| 全天事件 + 跨时区 (§11.8) | 3-4h (后端 + 前端 + 测试) |
| RRULE 创建/编辑 (§11.9) | 6-8h (后端 RRULE 拼装 + edit 3 模式 + 前端复杂表单) |
| **Phase 4 总** | **11-15h, 2-3 个 session** |
