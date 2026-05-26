# Calendar Module — Phase 4 进度纪要 (2026-05-26)

**From**: Session @ 2026-05-26 (Phase 4 启动, 用户要求"全做")
**Status**: 4 功能完整 ship (#3 含进阶改这次/改未来, 6 commits). **续 session (2026-05-26): attendees 数据安全 bug 全链路修复 (3 commits, §8) + e2e 用组件交互测试形态 ship (非 Playwright, §8.3).** 剩余: 跨时区 (价值低) / 跨设备 V2 (需 architect) / Playwright Electron e2e (需 DavMail/build 不可 CI, 已用组件测试覆盖触摸链).
**Branch**: feat/agent-harness
**Test 基线**: calendar pytest 336 → 359 → **369 passed** (+10 attendees); vitest calendar 相关 66 → **78 passed** (calendar.test 45 + rrule 17 + filter 6 + attendees 5 + EventFormModal 5).

---

## 1. 本 session 完成清单 (6 atomic commits + handoff)

| ID | Hash | Scope |
|---|---|---|
| #1 | `2726810` | **多 calendar 支持** — toolbar 多选 dropdown + 表单 calendar 下拉 (纯前端, 后端已就绪) |
| #3a | `3eadf8d` | **后端 RRULE 能力** — create rrule 透传 + update rrule sentinel (保留/覆盖/删除) + CLI --rrule |
| #3b | `ebe9776` | **前端 RRULE builder** — lib/rrule.ts + RRuleEditor 控件 + EventFormModal 创建/整系列编辑 |
| #2 | `13f032b` | **全天事件** — VALUE=DATE 端到端 floating date (前端 toggle + 后端 build_vevent/update 检测) |
| #3c | `4488509` | **改这一次** — detached occurrence (RECURRENCE-ID override, vobject 注入) + scope 对话 |
| #3d | `e1c00d8` | **改未来** — split series (老 master UNTIL 截断 + 新 series) + scope 对话"此事件及以后" |

**对应原 backlog**: #1 多 calendar (完整) / #3 RRULE (**完整**: 创建+整系列+改这次+改未来) / #2 全天 (跨时区留后续).

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

### 4.1 ✅ #3 进阶 — 改这一次/改未来 (已 ship #3c `4488509` + #3d `e1c00d8`)

本 session 已完成 (原以为需 DavMail 实测才动, 后判定 detached occurrence /
split series 是 RFC 标准 + Outlook 日常操作, DavMail 高概率支持, 故写 + vobject
mock 单测 + 标注实测):
- **改这一次** (#3c): detached occurrence — vobject 注入 master + RECURRENCE-ID
  override VEVENT (同 resource PUT, 不传字段继承 master, 已有 override 替换).
- **改未来** (#3d): split series — 老 master in-place UNTIL 截断 (保留 detached
  overrides) + 新建 series 从 split 起继承 FREQ/INTERVAL/BYDAY.
- 前端 EventFormModal scope 对话 3 按钮 (仅此事件 / 此事件及以后 / 整个系列).
- **⚠️ 仍建议 DavMail 实测端到端**: mock 单测覆盖 vobject 注入/截断逻辑, 但
  DavMail 桥接 EWS exception/split 的真实 round-trip 未实测. COUNT-based split
  是近似 (新 series 不继承 COUNT, 见 commit caveat).

### 4.2 #2 跨时区 (schema 重)

- `calendar_event.dtstart_utc` 全链路归一 UTC. explicit tzid 显示需加 `tzid` 列 (schema bump), dtstart 存 wall-clock + tzid, expander/前端显示按 tzid 转.
- **价值密度低**: 多数场景本地时区已足够 (前端 `toLocaleString` 已按本地展示). handoff 列为"克制". 建议除非有明确跨时区需求否则不做.

### 4.3 ✅ #5 e2e — 用组件交互测试替代 Playwright (续 session ship, 见 §8.3)

- **形态决策**: Playwright 在本项目零先例 (`test:e2e` script 指向不存在的 config) +
  这是 Electron app, 真 e2e 需 `_electron` launch + better-sqlite3 native + build +
  DavMail/真 Exchange → 不可 CI、依赖环境. 用户拍板用**组件交互测试** (testing-library
  + happy-dom, 项目既有成熟模式 tests/components/) 覆盖同样的触摸链, 可 CI.
- **已 ship**: `tests/components/EventFormModal.test.tsx` (5 test) — create 基本/全天 +
  edit 与会者 dirty 三态 (保留/清空/替换). 详见 §8.3.
- **未做**: Playwright Electron 启动 smoke (验证 app 真能起) + RSVP/删除/撤销 的真后端
  round-trip — 需 build + DavMail, 留后续 session.

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

### 5.2 ✅ service.update_event attendees 数据安全 bug (续 session 已全链路修复, 见 §8)

~~`service.update_event(attendees=None)` 透传 `writer.update_event(attendees=None)` →
`None or []` → 清空 attendees~~. **续 session (2026-05-26) 已修** (`a319e64` 后端 +
`4e70542` 前端 + `39613f4` 组件测试). 实修发现比原描述更广: 不只 CLI 不传清空, 前端
编辑事件还有 **partstat 退化** (预填只取 {email,name} 丢 partstat → 即使没碰也走替换
→ 已 ACCEPTED 被打回 NEEDS-ACTION → Exchange 重发邀请). 修复 = service 条件传
(None=保留/[]=清空/[...]=替换, **没用原 handoff 建议的 sentinel — 条件传更简洁且跟
rrule/is_all_day 一致, 已 push back**) + CLI `--clear-attendees` (互斥校验) + 前端
attendeesDirty flag (未 dirty 不传 → 保留 partstat / 删光 → clearAttendees) + IPC 透传.

### 5.3 全天 VALUE=DATE 的 DavMail/EWS round-trip 建议实测

build_vevent VALUE=DATE 是 RFC 标准 + vobject round-trip 单测已覆盖. 但 DavMail
6.7 把 VALUE=DATE 桥接到 EWS all-day 的端到端行为 (创建 → Exchange → 反向 sync
回 calendar_event) 未实测. 启用后建一个全天事件验证 round-trip 落库正确.

### 5.4 已知不修 (跨 session)

- DavMail 6.7 ctag 不可用 → worker 1h time-fallback
- macOS Sequoia provenance lock → `sudo xattr -dr` 清
- **本 session 踩坑**: Bash compound `cd` 改 shell 持久 cwd (cwd 漂到 `frontend/ref`
  + 并行 Bash calls **cwd 共享**), git/pnpm 命令务必明确 `cd` 到正确目录.
- **续 session (2026-05-26) vitest 组件测试踩坑** (写 EventFormModal.test 时, 耗了很多
  往返, 记下避免重蹈): ① harness 默认把 vitest 命令放后台, 重复触发 → **两个 vitest 跑
  同文件 cache/IPC 死锁 hang** (单一 run / CI 不会); ② mock react-query hook
  (`useCalendarEvent`) 必须返回**稳定引用**的 data — 否则 EventFormModal 的 `detail`
  effect (deps 含 detail) 每 render 触发 setState → **无限循环 hang** (用 `vi.hoisted`
  常量持有); ③ `waitFor` 从 `@testing-library/react` import, 非 `vitest`; ④ 单组件
  测试冷启动 ~8s (happy-dom env setup 3.97s + import 3.27s, 见 EmailRow 基线), 别误判
  hang. 教训: 跑单文件 `pnpm vitest run tests/components/X.test.tsx` 一次, 耐心等 ~10s,
  **不要重复触发**.

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
- `src/calendar_sync/caldav_writer.py` — build_vevent rrule + is_all_day; create/update_event; **update_occurrence (#3c) + split_series (#3d) + _rrule helper**
- `src/calendar_sync/service.py` — create/update_event rrule + is_all_day; **update_occurrence + split_series**
- `src/cli/commands/calendar.py` — `--rrule` / `--all-day` / **`--recurrence-id` + `--split-future`**
- `tests/calendar_sync/test_caldav_writer_roundtrip.py` (+12: rrule/all-day/occurrence/split) / `test_service.py` (+11)

### 修改 (前端)
- `frontend/src/shared/components/calendar/hooks/useCalendarEvents.ts` — selectedCalendars select
- `frontend/src/shared/components/calendar/CalendarToolbar.tsx` — calendar dropdown
- `frontend/src/shared/components/layout/CalendarLayout.tsx` — state lift
- `frontend/src/shared/components/calendar/views/{Day,Week,Month,Agenda}View.tsx` — 透传
- `frontend/src/shared/components/calendar/EventFormModal.tsx` — calendar 下拉 + RRuleEditor + 全天 toggle + **scope 对话 (改这次/改未来/整系列)**
- `frontend/src/shared/api/types.ts` + `frontend/src/electron/main/handlers/calendar-write.ts` — rrule + isAllDay + **recurrenceId + splitFuture** IPC
- `frontend/src/shared/i18n/locales/{zh-CN,en-US}/common.json` — calendarFilter / repeat / allDay / **recurrenceScope** key
- `frontend/tests/main/calendar.test.ts` (+9 IPC test)

### 续 session (2026-05-26) — attendees 修复 + e2e 组件测试
- `src/calendar_sync/service.py` — update_event attendees 条件传 (L1)
- `src/cli/commands/calendar.py` — `--clear-attendees` flag + 互斥校验 (L2)
- `frontend/src/shared/components/calendar/EventFormModal.tsx` — attendeesDirty (L3)
- `frontend/src/shared/components/calendar/lib/attendees.ts` (**新**, L3) — `resolveAttendeesUpdate`
- `frontend/src/shared/api/types.ts` + `.../handlers/calendar-write.ts` — clearAttendees IPC (L4)
- 后端测试: `test_service.py` (+3) / `test_caldav_writer_roundtrip.py` (+3) / `tests/cli/test_calendar.py` (+4)
- 前端测试: `tests/shared/attendees.test.ts` (**新**, 5) / `tests/main/calendar.test.ts` (+2) / `tests/components/EventFormModal.test.tsx` (**新**, 5)

---

## 7. 给下个 Session 的 prompt 模板

```
Phase 4 已 ship 4 功能 (6 commits) + 续 session attendees 数据安全修复 + e2e 组件
测试 (3 commits, §8). 全在 feat/agent-harness. 读 docs/calendar-phase4-progress.md.

测试基线: calendar pytest 369 (含 attendees +10) + vitest calendar 78 (calendar.test
45 + rrule 17 + filter 6 + attendees 5 + EventFormModal 5). (注: vitest 全套有 ~98 个
pre-existing 失败在 chat/kos/email 模块, ping-island fork in-flight, 跟 calendar 无关, §5.1.)

剩余 backlog (按建议优先级):
- #2 跨时区 (schema 加 tzid 列, 价值密度低, 除非有明确跨时区需求否则不做)
- #4 跨设备 V2 (需 architect 议方案 Bearer/CORS/versioning, ~10h+ 大工程)
- Playwright Electron 启动 smoke + RSVP/删除/撤销 真后端 round-trip (需 build +
  DavMail/真 Exchange, 不可 CI; 组件测试已覆盖 EventFormModal 触摸链, §8.3)
- (验证) #3 进阶 occurrence/split + 全天 VALUE=DATE 建议 DavMail 实测 EWS round-trip
  (mock 单测已覆盖逻辑, 真桥接未测, §5.1/§5.3)

caveat: DavMail ctag 1h fallback / provenance lock / Bash compound cd 改持久 cwd +
并行 cwd 共享 / **vitest 组件测试**: 别重复触发 (并发死锁 hang) + mock react-query hook
返稳定引用 (防 effect 循环 hang) + waitFor from @testing-library (§5.4).
```

---

## 8. 续 session (2026-05-26) — attendees 数据安全修复 + e2e 组件测试

3 atomic commits (feat/agent-harness, 接上面 6 个之后):

| Hash | Scope | 测试 |
|---|---|---|
| `a319e64` | **attendees bug 后端** — service.update_event 条件传 + CLI `--clear-attendees` (互斥) | pytest 359→369 |
| `4e70542` | **attendees bug 前端** — attendeesDirty (修 partstat 退化 + 删光) + lib/attendees + IPC clearAttendees | vitest 66→73 |
| `39613f4` | **e2e 组件测试** — EventFormModal.test.tsx (5 test) | vitest 73→78 |

### 8.1 attendees 数据安全 bug 全链路修复 (原 §5.2)

根因: `service.update_event` 无条件 `attendees=attendees` (默认 None) 透传 writer →
`None is _UNSET` False → `None or []` → 清空 Exchange 端与会者. 任何不带 attendees 的
update 都静默清空. **实修发现比 §5.2 描述更广**: 前端编辑事件还有 partstat 退化 (预填
只取 {email,name} 丢 partstat → 即使没碰也走替换 → writer hardcode NEEDS-ACTION 打回
已 ACCEPTED → Exchange 重发邀请).

4 层修复:
- **L1 service**: attendees 改条件传 `if attendees is not None` (None=保留/[]=清空/
  [...]=替换), 跟 rrule/is_all_day 一致. **没引入第二个 sentinel** (push back 原 handoff
  建议) — service 其它 Optional 字段 None 本就是"保留", 条件传更简洁且风格一致.
- **L2 CLI**: `--clear-attendees` flag 让"清空"可达 (修复后不传=保留, 否则无清空入口)
  + 与 `--attendee` 互斥校验.
- **L3 前端** (`EventFormModal.tsx` + 新 `lib/attendees.ts`): attendeesDirty flag (跟
  rruleDirty 同模式, 加/删 chip 才置位); 提交决策抽纯函数 `resolveAttendeesUpdate`: 未
  dirty 不传 (保留 + partstat 不退化) / dirty 非空替换 / dirty 删光 clearAttendees.
  occurrence override (改这次/改未来) 不碰与会者 (继承 master).
- **L4 IPC** (`types.ts` + `calendar-write.ts`): EventUpdateOpts 加 clearAttendees +
  runEventUpdate 透传 `--clear-attendees`.

writer 层 (`update_event` _UNSET sentinel 三态) 本就安全, bug 全在 service 显式透传 None
短路了它; writer/occurrence/split 未改. 测试 +17: 后端 writer 3 (含 partstat 不打回
NEEDS-ACTION 断言) + service 3 + CLI 4; 前端 attendees.test 5 (含"未 dirty 有 chips 仍
不回传"partstat 保护 + "绝不误清空") + calendar.test IPC 2 + EventFormModal.test 5.

### 8.2 验收命令

```bash
source venv/bin/activate
pytest tests/calendar_sync/ tests/calendar_notion/ tests/cli/test_calendar.py tests/cli/test_calendar_expand.py -q   # 369 passed
cd frontend && pnpm typecheck                                                                                          # node + web clean
# 注意: 单次跑, 别重复触发 (并发死锁); 组件测试冷启动 ~8s
pnpm vitest run tests/main/calendar.test.ts tests/shared/rrule.test.ts tests/shared/calendar-filter.test.ts tests/shared/attendees.test.ts tests/components/EventFormModal.test.tsx   # 78 passed
```

### 8.3 e2e 形态: 组件交互测试 (非 Playwright)

Playwright 在本项目零先例 (`test:e2e` 指向不存在的 config) + Electron 真 e2e 需
`_electron` launch + better-sqlite3 native + build + DavMail/真 Exchange → 不可 CI.
用户拍板用**组件交互测试** (testing-library + happy-dom, 项目既有成熟模式 tests/components/
10+ 个 .test.tsx) 覆盖触摸链. `EventFormModal.test.tsx` 5 test: create 填标题/全天
toggle + edit 与会者 dirty 三态. mock 非周期 detail (rrule='') 让提交不弹 scope dialog,
聚焦改整系列分支. **未覆盖**: Playwright Electron 启动 smoke + RSVP/删除/撤销 真后端
round-trip (需 build + DavMail). 写测试踩的 vitest 坑见 §5.4.
