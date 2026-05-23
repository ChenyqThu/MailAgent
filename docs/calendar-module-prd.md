# Calendar Module — PRD

**Status**: Phase 1 数据层落地 (commits c8d241d / 478baac / 706788d / d178c9b), UI 待 mockup
**Owner**: 内部产品 / MailAgent
**为谁写**: claude design / 后续 frontend 实现
**Date**: 2026-05-23

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

## 7. Phase 2+ 待办 (路线图, 视频面试参考)

### Phase 2: 写能力 (后续 1-2 sprint)
- **RSVP**: 抽屉里加 [接受/暂定/拒绝] 按钮, 走 SMTP iTIP REPLY 路径
- **创建事件**: toolbar 加 [+ 新建], 表单弹窗 → CalDAV PUT
- **修改/删除**: 抽屉里加 [编辑]/[删除], CalDAV PUT/DELETE
- **重新设计 Replay 语义**: 当前基于"邮件重 fetch"对 caldav-only 失效, 改成"从 calendar_event 重导出 Notion"

### Phase 3: legacy 下线 (前端 V2 稳定后)
- 删除 `calendar_main.py` + `src/calendar/` 目录 + PM2 `calendar-sync` 进程
- DB 软迁移: 老 `source='legacy_calendar_app'` 行加 `deleted_at`

### Phase 4: 数据质量增强
- **CTag fallback 优化**: 当前 DavMail PROPFIND CTag 返 XML 解析失败, worker 走 1h time-fallback. 可换 sync-token (RFC 6578) 或 IMAP IDLE 信号
- **多 calendar 支持**: 当前只看 `calendar_name="日历"` (默认 Outlook 日历), 添加共享 / 子 calendar 切换 chip
- **FTS5 搜索**: `calendar_event_fts` 表 + 顶栏 ⌘K 搜会议

### Phase 5: 跨设备
- Web SPA: `HttpApi.calendar.*` 走 FastAPI proxy (当前 stub `notImplemented`)
- iOS / Android: 移动专属视图设计

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

## 10. 验收 checklist (给后续实现 + QA 用)

### 数据 (已通过)
- [x] DB v15 calendar_event + calendar_sync_state 表
- [x] CalendarSyncWorker 启动后 60s 内拉到 events
- [x] 55 events 落 SQLite, 13 个 RRULE 保留完整 RRULE 字符串
- [x] `mailagent calendar today/week/recurring discover` 都返正确数据

### 视图 (Phase 1 已实现, 待 mockup 优化)
- [x] 5 个视图都能渲染 (today/week/month/agenda/recurring)
- [x] EventBlock 按时长 stretch + 并发分列
- [x] EventChip 响应状态视觉编码
- [x] EventDetailDrawer 显示完整字段 + 关联邮件跳转
- [ ] 视觉密度 / 配色 / 间距 ← **claude design 优化**
- [ ] DayView 当前时间线
- [ ] MonthView "+N 更多" popover (现 in-place 展开不太好)
- [ ] Recurring 视图整体布局优化 (现 Sprint 6 老表格)

### 边缘状态 (待补强)
- [x] 空状态 (3 个视图都有 EmptyState)
- [x] 加载 skeleton
- [ ] 同步失败的 toolbar 红点
- [ ] 抽屉里 "数据加载中..." vs 字段为空的区分

### 交互 (待 mockup)
- [x] 视图切换 (URL ?view=)
- [x] 日期导航 (上一/今天/下一)
- [x] 手动同步按钮
- [ ] keyboard shortcuts (G+T 今日 / G+W 周 / etc.)
- [ ] 右键菜单 (复制链接 / 跳邮件 / etc.)
