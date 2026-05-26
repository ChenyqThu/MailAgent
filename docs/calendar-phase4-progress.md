# Calendar Module — Phase 4 进度纪要 (2026-05-26)

**From**: Session @ 2026-05-26 (Phase 4 启动, 用户要求"全做")
**Status**: 3 功能完整 ship (4 commits). 剩余 4 项各有实测/架构/schema 依赖, 留后续 session.
**Branch**: feat/agent-harness
**Test 基线**: calendar pytest 336 → **349 passed** (+13); vitest calendar 相关 **64 passed** (calendar.test 41 + rrule 17 + filter 6).

---

## 1. 本 session 完成清单 (4 atomic commits)

| ID | Hash | Scope |
|---|---|---|
| #1 | `2726810` | **多 calendar 支持** — toolbar 多选 dropdown + 表单 calendar 下拉 (纯前端, 后端已就绪) |
| #3a | `3eadf8d` | **后端 RRULE 能力** — create rrule 透传 + update rrule sentinel (保留/覆盖/删除) + CLI --rrule |
| #3b | `ebe9776` | **前端 RRULE builder** — lib/rrule.ts + RRuleEditor 控件 + EventFormModal 创建/整系列编辑 |
| #2 | `13f032b` | **全天事件** — VALUE=DATE 端到端 floating date (前端 toggle + 后端 build_vevent/update 检测) |

**对应原 backlog**: #1 多 calendar (完整) / #3 RRULE (核心: 创建+整系列, 进阶留后续) / #2 全天 (跨时区留后续).

---

## 2. 已 ship 详情

### 2.1 #1 多 calendar (`2726810`)

后端 `create/update/list_calendar_names` + `eventsList.calendarName` 早已就绪, 本提交纯前端接通:

- `lib/calendar-filter.ts`: `filterOccurrencesByCalendars` 纯函数 (抽离 hooks import 链, node 单测友好)
- `useCalendarEventsInWindow(opts, selectedCalendars?)`: react-query `select` 做 client-side filter — **queryKey 不含 selectedCalendars**, 切筛选不重 fetch, 共享窗口缓存只重跑 select
- `CalendarLayout`: `selectedCalendars` state lift + `useCalendarNames()` → 传 Toolbar + 4 view + 副 status bar count
- `CalendarToolbar`: calendar 多选 dropdown (glass-pop, 仅 `calendars.length > 1` 显示, click-outside + Esc)
- `EventFormModal`: create 加 calendar 下拉 (**edit 只读** — 跨 calendar move 不在 scope)
- i18n: `calendar.toolbar.calendarFilter.*` + `calendar.form.labelCalendar/calendarDefault/calendarEditLocked`

### 2.2 #3 核心 RRULE (`3eadf8d` + `ebe9776`)

**后端** (`caldav_writer` + `service` + CLI):
- `build_vevent` 早有 rrule 参数; 本次 `create_event` 暴露 rrule + `update_event` 加 **rrule sentinel**: `_UNSET` 保留原 RRULE (F3 透传) / 显式 str 覆盖 (改整系列) / 显式 `''` → None 删除 (周期→单次)
- `service.update_event` 用**条件传** (`rrule is not None` 才 forward, None=未传走 writer `_UNSET` 保留, 避免误删)
- CLI `--rrule` (create 留空=单次; update 不传=保留 / 'FREQ=...' 覆盖 / '' 删除)

**前端** (`lib/rrule.ts` + `RRuleEditor` + `EventFormModal`):
- `buildRRule/parseRRule` 纯逻辑 (FREQ/INTERVAL/WEEKLY BYDAY/COUNT/UNTIL), round-trip 稳定 (UNTIL 走 UTC date-only 避免 off-by-one); 复杂 RRULE (BYMONTHDAY 等) `parseRRule` 回退 `freq=NONE`
- `RRuleEditor`: 受控 builder 控件 (freq select + interval + 星期 chip 多选 + 结束方式 never/count/until)
- `EventFormModal`: create 传 rrule (空=单次); edit 用 `useCalendarEvent` 拉 `detail.rrule` 预填 + **`rruleDirty` flag** — 仅用户动了重复段才传 rrule, 没动不传 → 后端保留原值, **防 builder 有损解析破坏复杂 RRULE**
- IPC: `runEventCreate` truthy 传 (单次不传) / `runEventUpdate` `!== undefined` 传 (空串=删除)

### 2.3 #2 全天事件 (`13f032b`)

**floating-date 方案** (消除 off-by-one + 时区漂移):
- `build_vevent is_all_day` → DTSTART/DTEND 用 `VALUE=DATE`; **后端全程 RFC 原生 exclusive 语义** (不 +1)
- 前端用 **UTC midnight Z** (`${date}T00:00:00Z`) 传 floating date, `.strftime`/`.slice` 提取无时区漂移; **inclusive → exclusive 转换 (endDate +1) 集中前端一处**
- `caldav_reader.py:442` 确认全天 dtend 存 exclusive (CalDAV 原生 date 00:00 UTC), 故 edit 预填 `endDate = occurrence_end UTC date − 1` (exclusive → inclusive 显示), 往返一致
- `update_event` 检测 `orig_dtstart` 是 `date` (非 `datetime`) → 透传保持全天 (`is_all_day=None` 保持 / 显式 bool 改; **防 update 把全天破坏成定时**, 类似 F3 RRULE 降级)
- `EventFormModal` 全天 toggle + date input 条件渲染 + validate (date 比较, 单日 endDate==startDate 合法)
- WeekView/DayView all-day strip 渲染 **Phase 2 已就位**, 本次只补创建/编辑入口

---

## 3. 测试基线

| 套件 | 数 |
|---|---|
| calendar pytest (`tests/calendar_sync/ tests/calendar_notion/ tests/cli/test_calendar*.py`) | 336 → **349** (+13: 7 RRULE + 6 all-day) |
| vitest `tests/main/calendar.test.ts` | 35 → **41** (+6: 3 rrule arg + 3 all-day arg IPC) |
| vitest `tests/shared/rrule.test.ts` | **17** 新 (build/parse/round-trip) |
| vitest `tests/shared/calendar-filter.test.ts` | **6** 新 (多 calendar filter) |

```bash
# 验收
source venv/bin/activate
pytest tests/calendar_sync/ tests/calendar_notion/ tests/cli/test_calendar.py tests/cli/test_calendar_expand.py -q
# 349 passed

cd frontend
pnpm typecheck   # node + web clean
pnpm vitest run tests/main/calendar.test.ts tests/shared/rrule.test.ts tests/shared/calendar-filter.test.ts
# 64 passed
cd /Users/chenyuanquan/Documents/MailAgent && python scripts/dev/i18n_audit.py --prefix calendar.
# 0/0/0 clean
```

---

## 4. 剩余 backlog (留后续 session, 各有依赖)

### 4.1 #3 进阶 — 改这一次/改未来 (需 DavMail 实测) — task #6

- **改这一次**: master 加 EXDATE(该 occurrence 日期) + 建新 single VEVENT with RECURRENCE-ID override
- **改未来**: split series (老 master RRULE 加 UNTIL + 新建 master 从该日期起)
- 前端 EventFormModal edit 周期事件弹 **"改这一次 / 改未来 / 改整系列"** 对话
- **依赖**: DavMail CalDAV 对 detached occurrence / multi-VEVENT resource 的运行时行为未知, 盲写风险高 (不像 build_vevent/RRULE 是 RFC 标准可单测). 需 DavMail 实测验证 round-trip 再动手.
- 后端基础已备: `update_event` rrule sentinel + recurrence_id 透传已在.

### 4.2 #2 跨时区 (schema 重)

- `calendar_event.dtstart_utc` 全链路归一 UTC. explicit tzid 显示需加 `tzid` 列 (schema bump), dtstart 存 wall-clock + tzid, expander/前端显示按 tzid 转.
- **价值密度低**: 多数场景本地时区已足够 (前端 `toLocaleString` 已按本地展示). handoff 列为"克制". 建议除非有明确跨时区需求否则不做.

### 4.3 #5 e2e Playwright (需 env)

- RSVP / 编辑 / 删除 / 撤销 / **创建周期 + 全天事件** 真触摸链 (pnpm dev + Playwright).
- 需 Playwright env (本 session 无). 适合 Phase 4 接近完工 (跨时区/#3进阶 定后) 再做.

### 4.4 #4 跨设备 V2 (需 architect) — task #5

- HttpApi proxy 暴露 calendar service 给 Web/Mobile, 非 Electron-only.
- 需架构设计先行 (Bearer auth / CORS / API versioning). 上 architect 议方案再动手. ~10h+ 大工程.

---

## 5. Caveat / 风险

### 5.1 ⚠️ pre-existing vitest 失败 (非本 session 引入)

`pnpm vitest run` 全套 **98 failed | 899 passed | 54 skipped** (9 文件). 失败全在
**chat / kos / email / command-palette / batch** 模块 (e.g. `kos_save.test.ts`
`harness.test.ts` `email.test.ts`), 是 **ping-island fork 的 in-flight 工作**.

**已验证 pre-existing**: checkout session 起点 `2227b63` (本 session 工作之前)
跑 `tests/main/chat/kos_save.test.ts` → 同样 **9 failed | 12 passed**, 与当前一致.
本 session calendar 工作 (calendar.test/rrule/filter **64 全过** + typecheck 全过)
跟这些失败**无关**. 后续 session 跑全套 vitest 时不要把这些算到 calendar 头上.

### 5.2 ⚠️ service.update_event attendees 默认值疑似 bug (pre-existing, 待确认)

`service.update_event(attendees=None default)` 直接透传 `writer.update_event(attendees=None)`.
writer `new_attendees = orig if attendees is _UNSET else (attendees or [])` —
`None is _UNSET` False → `None or []` = `[]` → **清空 attendees**. 跟 F3
"省略保留" 注释 (writer 层用 `_UNSET` sentinel) 矛盾: service 没用 sentinel,
传 None 而非 _UNSET. 前端 EventFormModal 总传 attendees (chips) 所以没暴露;
**CLI `calendar update` 不带 `--attendee` 会清空 Exchange 端 attendees**.
不在 #2/#3 scope, 未改 (rrule/is_all_day 我用条件传规避了同样陷阱). 建议单独
修: service.update_event attendees 也用 sentinel (跟 writer 对齐).

### 5.3 全天 VALUE=DATE 的 DavMail/EWS round-trip 建议实测

build_vevent VALUE=DATE 是 RFC 标准 + vobject round-trip 单测已覆盖. 但 DavMail
6.7 把 VALUE=DATE 桥接到 EWS all-day 的端到端行为 (创建 → Exchange → 反向 sync
回 calendar_event) 未实测. 启用后建一个全天事件验证 round-trip 落库正确.

### 5.4 已知不修 (跨 session)

- DavMail 6.7 ctag 不可用 → worker 1h time-fallback
- macOS Sequoia provenance lock → `sudo xattr -dr` 清
- **本 session 踩坑**: Bash compound `cd` 改 shell 持久 cwd (cwd 漂到 `frontend/ref`
  + 并行 Bash calls **cwd 共享**), git/pnpm 命令务必明确 `cd` 到正确目录.

---

## 6. 关键文件清单

### 新增
- `frontend/src/shared/components/calendar/lib/calendar-filter.ts` (#1)
- `frontend/src/shared/components/calendar/lib/rrule.ts` (#3)
- `frontend/src/shared/components/calendar/RRuleEditor.tsx` (#3)
- `frontend/tests/shared/calendar-filter.test.ts` (#1, 6 test)
- `frontend/tests/shared/rrule.test.ts` (#3, 17 test)
- `docs/calendar-phase4-progress.md` (本文件)

### 修改 (后端)
- `src/calendar_sync/caldav_writer.py` — build_vevent rrule + is_all_day; create/update_event
- `src/calendar_sync/service.py` — create/update_event rrule + is_all_day
- `src/cli/commands/calendar.py` — `--rrule` / `--all-day`
- `tests/calendar_sync/test_caldav_writer_roundtrip.py` (+6) / `test_service.py` (+7)

### 修改 (前端)
- `frontend/src/shared/components/calendar/hooks/useCalendarEvents.ts` — selectedCalendars select
- `frontend/src/shared/components/calendar/CalendarToolbar.tsx` — calendar dropdown
- `frontend/src/shared/components/layout/CalendarLayout.tsx` — state lift
- `frontend/src/shared/components/calendar/views/{Day,Week,Month,Agenda}View.tsx` — 透传
- `frontend/src/shared/components/calendar/EventFormModal.tsx` — calendar 下拉 + RRuleEditor + 全天 toggle
- `frontend/src/shared/api/types.ts` + `frontend/src/electron/main/handlers/calendar-write.ts` — rrule + isAllDay IPC
- `frontend/src/shared/i18n/locales/{zh-CN,en-US}/common.json` — calendarFilter / repeat / allDay key
- `frontend/tests/main/calendar.test.ts` (+6 IPC test)

---

## 7. 给下个 Session 的 prompt 模板

```
Phase 4 已 ship 3 功能 (4 commits 在 feat/agent-harness): #1 多 calendar / #3
核心 RRULE (创建+整系列) / #2 全天事件. 读 docs/calendar-phase4-progress.md 拿状态.

测试基线: calendar pytest 349 + vitest calendar 64. (注: vitest 全套有 98 个
pre-existing 失败在 chat/kos/email 模块, 是 ping-island fork in-flight, 跟 calendar
无关, §5.1 已验证.)

剩余 backlog (按建议优先级):
- #3 进阶 改这次/改未来 (需 DavMail 实测 detached occurrence)
- #5 e2e Playwright (需 env, Phase 4 接近完工再做)
- #2 跨时区 (schema 重, 价值密度低, 可不做)
- #4 跨设备 V2 (需 architect 议方案)
- (旁路) service.update_event attendees 疑似 bug §5.2 待确认修

caveat: DavMail ctag 1h fallback / provenance lock / Bash compound cd 改持久 cwd
+ 并行 cwd 共享 (git/pnpm 注意 cd).
```
