# 排程规则契约（schedule-builder 跨端唯一真相源）

> status: living · last-verified: 2026-07-24（落地 commit `1923a9df`）
>
> 本文是 **Python 求值器**（`src/agents/schedule_rule.py`）与 **前端 schedule-builder 预览**
> （`frontend/src/shared/components/agents/schedule/`）之间的接口，也是两个 worker
> （custom agent 定时触发 / 报告 Agent）共用的 occurrence 语义唯一真相源。
> **改语义先改本文，再两侧同步** —— 禁止任何一侧单方面「优化」。
>
> 想看 custom agent 触发引擎 / headless run 的整体拓扑 → [`../llm-agent/ai-sdk-gateway-architecture.md`](../llm-agent/ai-sdk-gateway-architecture.md) §13.19-13.21。
> 想看报告 Agent 的调度 / 窗口 / 层级聚合语义 → [`../remote-chat-report/report-agent-prd.md`](../remote-chat-report/report-agent-prd.md) §4.5。
> 想看日历事件的 RRULE（**另一套东西，别混**）→ `frontend/src/shared/components/calendar/lib/rrule.ts`。

立契约的动机：产品要求「接下来 5 次运行」预览与后端**实际触发时刻**一致。两份独立手写的
recurrence 计算几乎必然在 DST / 月末 / interval 相位上分叉，故语义**锚定到 RFC 5545 RRULE**，
两侧各自委托成熟引擎（Python `dateutil.rrule` / 前端 `rrule@2.8.1`，**都是既有依赖，零新增**），
而不是各写一套算法。DTSTART=anchor 顺带以 RRULE 原生方式解决了「interval>1 相位随重启漂移」。

---

## 0. 实现落点（改哪里 = 看这张表）

| 角色 | 路径 | 说明 |
|---|---|---|
| **求值内核（唯一实现）** | `src/agents/schedule_rule.py` | `occurrences()` / `prev_occurrence()` / `parse_rule()` / `parse_anchor()` / `rules_from_legacy_schedule()` / 星期编号双向转换 |
| custom agent 判别式 | `src/agents/trigger.py` | `ScheduleTrigger` dataclass + `parse_trigger` 的 `kind=='schedule'` 分支（深校验） |
| custom 定时 worker | `src/agents/trigger_worker.py` | `_due_fire()` 按 kind 分流；`_trigger_hash()` 取代 `_cron_hash()`（cron 分支字节一致） |
| 报告 worker | `src/reports/worker.py` | `_rule_entries()`（新老形状 → 求值输入）+ `_due_occurrence()`（取代 `_due_hour()`） |
| 报告 cadence 派生 | `src/reports/store.py` | `cadence_of()` 从 `rule.freq` 派生；`agent_with_cadence_override()` = manual-run `--cadence` 唯一入口 |
| 前端共享组件 | `frontend/src/shared/components/agents/schedule/` | `ScheduleBuilder.tsx`（渲染）+ `types.ts` / `migrate.ts` / `occurrences.ts` / `sentence.ts`（纯逻辑）+ `index.ts`（公开面） |
| 两处接入 | `agents/CustomAgentDrawer.tsx`（自定义 Agent）· `agents/drawers/ConfigDrawer.tsx`（报告 Agent，`lockFreq`） | **同一个组件**，不是两份 |
| 触发摘要（人审面） | `frontend/src/shared/assistant/tools/a2ui.ts::summarizeAgentTrigger` · `frontend/src/ai-gateway/tools/agents.ts::triggerSummary` | 漏 schedule 分支 = owner 批一个看不见的触发 |
| 黄金 fixture + 闸 | `tests/fixtures/schedule_occurrences.json` · `tests/agents/gen_schedule_fixture.py` · `tests/agents/test_schedule_fixture.py` · `frontend/tests/components/scheduleParity.test.ts` | 见 §5 |

**DB 零改动**：`report_agent.trigger_json` / `schedule_json` 本就是 TEXT JSON 列，新形状在列内扩展 ——
**不加列、不 bump `DB_VERSION`**。

---

## 1. 持久化形状

存进 `report_agent.trigger_json`（custom agent）与 `report_agent.schedule_json`（报告 agent）：

```jsonc
{
  "v": 1,
  "kind": "schedule",          // 与既有 kind:'cron' 并存；老 cron 行照旧走 croniter
  "rule": {
    "freq": "daily" | "weekly" | "monthly",
    "interval": 1,             // int >= 1
    "weekdays": [2, 4],        // freq=weekly 用；0=周日 …… 6=周六（见 §2）
    "monthMode": "date" | "nth",
    "monthDay": 31,            // monthMode=date 用；1..31
    "ordinal": 1 | 2 | 3 | 4 | "last",   // monthMode=nth 用
    "weekday": 2,              // monthMode=nth 用；0=周日
    "hour": 9,                 // 0..23
    "minute": 0,               // 0..59
    "clamp": false             // 月末策略：false=跳过该月（RRULE 语义）/ true=夹到当月最后一天
  },
  "anchor": "2026-07-24",      // **本地日历日期**（在下方 timezone 里解释），相位原点
  "timezone": "America/Los_Angeles"   // IANA，**不允许为空**
}
```

- `rule` **10 键全量必填**，多一个键少一个键都拒（`parse_rule`）。`freq` 不用的字段也要在场且合法 ——
  避免两侧对「缺字段」的兜底不一致。`bool` 混进整型字段同样拒（两侧序列化分叉的信号）。
- `timezone` 空 → 拒（**没有** cron 那条「空→UTC」兜底：空时区正是两套排程历史分叉的病根，见 §4）。
- `interval == 1` 时 anchor 对结果无影响（迁移行可填任意合法过去日期，见 §4）。

### 🔴 anchor 是本地日期，不是 UTC 日期

相位必须在用户所在时区的日历上算，否则 `interval=2` 的规则在 UTC 与本地跨日的时段里相位差一天。
存 `YYYY-MM-DD`，在同一 payload 的 `timezone` 里解释。前端新建时取「规则时区里的今天」
（`migrate.ts::todayInTimezone`）；惰性迁移的老行取常量 `LEGACY_ANCHOR='2020-01-01'` ——
anchor 同时是 RRULE 的 DTSTART，**绝不能落在未来**（否则近期 occurrence 全被吃掉），
也不能取 `today`（同一行在不同机器上会读出不同结果）。

### 1.1 报告 agent 的 `schedule_json` 是**叠加**形状，不是替换

报告侧写盘时新老键同在（`migrate.ts::writeReportSchedule`）：

```jsonc
{ "cadence": "weekly", "hours": [9], "weekday": 0,      // legacy 镜像
  "v": 1, "kind": "schedule", "rule": {...}, "anchor": "...", "timezone": "..." }
```

- 🔴 **`cadence` 必须恒同步 `rule.freq`**：它在报告侧不只是节奏，还决定**报告种类** ——
  `reports/worker.py` 用它选聚合窗（`_period_bounds`）、去重主键（`_report_id`）与周/月的层级聚合路径，
  `store.list_agents()` 还用它排序（daily 必先于 weekly/monthly 跑）。丢了它 = 周报静默退化成日报。
  故 `cadence_of()` 在 `kind:'schedule'` 时**从 `rule.freq` 派生**，而不是读顶层键。
- `hours` / `weekday` / `day_of_month` 镜像**纯为降级安全**（用户回滚旧版 app 时老 worker 仍读得懂）。
  多 weekday 时镜像只写排序后第一个（有损，仅影响降级路径）。
- **`kind:'schedule'` 在场时 `rule` 是唯一权威，运行时绝不回头读镜像。**
- 🔴 由此派生的写者纪律：**任何覆写 cadence 的地方必须连 `rule.freq` 一起覆写**。
  manual-run 的 `--cadence` 曾只改顶层键 → 在新形状行上静默失效（`report run --cadence weekly`
  生成 daily 报告、零报错）。现收敛为唯一入口 `store.agent_with_cadence_override()`
  （内存副本不落库），CLI `report run` / serve-api manual-run / skill `report_run` 三处共用。

---

## 2. 星期编号（唯一最容易错的地方）

| 口径 | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|---|
| **本契约 / JS `getDay()` / cron** | 日 | 一 | 二 | 三 | 四 | 五 | 六 |
| Python `datetime.weekday()`（老 `schedule_json.weekday` 用的就是它） | 一 | 二 | 三 | 四 | 五 | 六 | 日 |

```python
def rule_to_py(w): return (w + 6) % 7   # 契约 0(日) -> py 6(日)
def py_to_rule(w): return (w + 1) % 7   # py 0(一) -> 契约 1(一)
```

前端同名镜像：`migrate.ts::pyWeekdayToRule` / `ruleWeekdayToPy`。**透传 = 静默错一天**，
两侧各有单测锁死双向；fixture case 13 直接锁「老 weekly weekday=0 映射后必须全落周一」。

dateutil 的 `SU, MO, TU, WE, TH, FR, SA` 按**契约顺序**索引（`WEEKDAY_CONSTS = (SU, MO, ...)`），
rrule.js 的 `RRule.SU..RRule.SA` 同理 —— 两侧编码一致是有意为之。

---

## 3. Occurrence 语义

```python
occurrences(rule, timezone, anchor, after, count) -> list[aware datetime]   # 严格晚于 after 的前 count 次
prev_occurrence(rule, timezone, anchor, before)  -> aware datetime | None   # 最近一次 <= before
```

**统一做法：在 `timezone` 的墙钟上用 naive datetime 跑 RRULE，最后再贴时区。**
DTSTART / 迭代全程 naive（floating），出口才 `.replace(tzinfo=...)`。这样「每天 9:00」跨 DST
恒为本地 9:00 —— 与上游组件、与两个 worker 的历史语义都一致。

- `DTSTART` = naive `anchor` 日期 + `hour:minute`。
- 比较 `after` / `before` 时先转成 `timezone` 的墙钟 naive 值再比。
- 前端没有 naive datetime，用 **as-UTC 编码**表示墙钟（墙钟分量塞进 `Date.UTC(...)`）——
  rrule.js 不设 tzid 时正是这么工作的（进出都读 `getUTC*`），出口再 `wallClockToUtc` 贴真实时区。
  时区原语全走 `Intl.DateTimeFormat`，**不引第三方日期库**。

### 3.1 freq → RRULE 映射

| freq | RRULE |
|---|---|
| daily | `FREQ=DAILY;INTERVAL=<interval>` |
| weekly | `FREQ=WEEKLY;INTERVAL=<interval>;BYDAY=<weekdays 映射>;WKST=SU` |
| monthly + date | `FREQ=MONTHLY;INTERVAL=<interval>;BYMONTHDAY=<monthDay>` |
| monthly + nth | `FREQ=MONTHLY;INTERVAL=<interval>;BYDAY=<ordinal><weekday>`（`last` → `-1`） |

- `BYMONTHDAY=31` 天然**跳过**没有 31 号的月份 —— 这正是 `clamp=false`。
- `INTERVAL` 的相位天然以 DTSTART 为原点 —— 这正是 anchor 要解决的问题。
- 🔴 **`WKST=SU` 必须显式写**：RFC 5545 默认 `WKST=MO`，会让 `INTERVAL>1` 的周规则相位**整整差一周**。

### 3.2 clamp=true 是唯一非 RRULE 分支

`monthMode=date && clamp=true && monthDay > 当月天数` → 该月取**最后一天**同 `hour:minute`
（预览里标 `clamped`）。实现 = 按 `FREQ=MONTHLY;INTERVAL=n` 枚举**候选月**（不带 BYMONTHDAY），
逐月自取 `min(monthDay, 当月天数)`。

🔴 **不要**改用 `BYMONTHDAY=28,29,30,31 + BYSETPOS=-1` 之类的技巧 —— 两侧引擎的 BYSETPOS
边界行为会不必要地增加分叉面。`clamp` 只对 `monthMode=date` 有意义；`nth` 时忽略（1st–4th 与 last 必然存在）。

### 3.3 DST 落点（两条，两侧都必须实现）

墙钟 naive → 贴 tz 时可能落进 DST 空洞或重叠：

- **不存在的墙钟**（春季前跳，如 `America/Los_Angeles` 2026-03-08 02:30）→ 向后推到该日
  **首个存在的瞬间**（= transition 点，Python 侧二分求得）。
- **重复的墙钟**（秋季回拨）→ 取**较早**那次（`fold=0`）。

默认 `hour=9` 的规则永远碰不到，但 `hour=2` 的用户会。半小时制 DST（Lord Howe）/ 南半球 /
Santiago 均已在跨语言差分里覆盖。

---

## 4. 老形状惰性映射（读时完成，**不回写 DB**）

读到不带 `kind:'schedule'` 的老值时就地映射（Python `rules_from_legacy_schedule` /
前端 `migrate.ts::legacyScheduleToRule`），**不做一次性 DB 迁移**（避免迁移脚本与灰度纠缠）：

| 老 `schedule_json`（报告 agent） | rule |
|---|---|
| `{"cadence":"daily","hours":[H]}` | `{freq:'daily',interval:1,hour:H,minute:0}` |
| `{"cadence":"weekly","hours":[H],"weekday":W}` | `{freq:'weekly',interval:1,weekdays:[(W+1)%7],hour:H}` 🔴 W 是 Python 口径 |
| `{"cadence":"monthly","hours":[H],"day_of_month":D}` | `{freq:'monthly',interval:1,monthMode:'date',monthDay:D,clamp:false,hour:H}` |

- 🔴 **空 timezone 写实**：报告 agent 空时区的历史语义 = **宿主机本地**。迁移时必须解析成当前
  实际生效的 IANA 值写入，**不留空** —— 留空会让统一后的逻辑退化成 UTC（custom 侧 cron 的默认），
  现有 9:00 报告直接漂到别的时刻。前端 `readReportSchedule(schedule, cfg.timezone || hostTimezone())`；
  Python 惰性路径直接沿用调用方已按「列 timezone 或宿主机本地」转好的 `now.tzinfo`。
- **老 `kind:'cron'` 的 custom agent 行原样走 croniter**，不映射、不改行为。UI 侧同理：
  老 cron 行停在 legacy 裸文本框态，**绝不自动转换**（`*/5 * * * *` 这类表达式落在构建器值模型之外，
  静默映射会改掉用户的触发时刻），用户显式点「改用排程构建器」才切过去。
- **hours 清洗**镜像老 `_fire_hours`：滤非法、去重、空则兜底 `[9]`；越界 weekday / day_of_month
  在老 worker 里本就「永不 fire」→ 映射为**空规则列表**，保持行为等价。
- `anchor` 缺失 → `LEGACY_ANCHOR`（老行 interval 恒 1，anchor 不影响结果）。
- 惰性映射路径的 anchor 回看窗 = `_LEGACY_ANCHOR_LOOKBACK_DAYS = 45` 天（> 任何月长，
  保证当天该触发的 occurrence 在枚举范围内，同时 bound 每 tick 的枚举成本）。

**生产实测存量只有两行**（`daily_email_digest` daily/9 点/空 tz、`weekly_email_digest`
weekly/周一 9 点/空 tz，后者 disabled），升级后触发时刻**逐分钟不变**（已验证）。

### 4.1 已知有损点（有意取舍）

老形状允许一天多时点（`hours:[9,18]`），新值模型只有单个 `hour`。后端惰性路径仍按**每个 hour
一条规则**触发、不丢；但用户一旦在新 UI 保存即收敛成单时点 —— 收敛发生在用户看得见排程句子与
运行预览的编辑态，不是静默后台改写。生产存量两行均为单 hour，实际迁移面零损失。

---

## 5. 跨语言一致性怎么保证

- **黄金 fixture** `tests/fixtures/schedule_occurrences.json`（16 条，覆盖契约点名的 14 类：
  daily/weekly/monthly 各档 · interval 相位 + anchor 移位对照 · clamp skip/夹 · nth / last ·
  DST 春/秋/空洞 · 迁移星期编号 · 无 DST 时区）。**由 Python 侧生成**：

  ```bash
  venv/bin/python -m tests.agents.gen_schedule_fixture
  ```

- **三道闸**（`tests/agents/test_schedule_fixture.py`）：① 落盘 fixture 与求值器当前输出零漂移
  （改实现忘了重新生成 → 红）② 生成器定义与落盘文件同步（改定义忘了跑生成 → 红）③ 14 类 case 一个不缺。
- 🔴 **fixture 只锁「两侧一致」，不锁「正确」** —— DST 春/秋/空洞与周一映射的正确性由
  `tests/agents/test_schedule_rule.py` 的**独立手写断言**锁死（契约明确要求：不能只靠「生成什么就断言什么」）。
- **前端 parity** `frontend/tests/components/scheduleParity.test.ts` 从同一文件读，逐条比对。
- 两侧各有一条测试专抓「两侧都忽略 anchor 时逐条比对照样全绿」这个假通过。
- 落地时另跑过 406 case 跨语言差分（随机 rule × 8 时区，含 Lord Howe 半小时 DST / 南半球 /
  Santiago + 定向边角）全过。
- **形状闸** `tests/api/test_trigger_kind_parity.py`（issue #65 补）：trigger 的 `kind` 值域与
  rule 的 10 键在 Python 与 gateway zod allowlist（`frontend/src/ai-gateway/tools/schemas.ts`）
  之间对齐。**两侧都从源码抽真值**（Python 抽 `parse_trigger` 的 `if kind == "..."` 分支 +
  直接 import `schedule_rule._RULE_KEYS`；TS 抽判别式里的 `z.literal` 与 rule 对象键），
  本闸不持任何一侧的期望值副本；抽取失败一律红（重构 zod 写法必须回来更新抽取器）。
  加第四种 kind / 第 11 个 rule 键时它与 `tests/api/test_context_mode_consistency.py` 同时红。

---

## 6. 两个 worker 的接入点

**禁止各写一份** —— 两者 import 同一个 `src/agents/schedule_rule`。判定语义均保持历史形态：
最近一次 occurrence 落在 `(last_fire_marker, now]` 且距今 ≤ `FIRE_WINDOW_MIN=30` 分钟则 fire。

### 6.1 custom agent（`src/agents/trigger_worker.py`）

- `_due_fire()` 按 kind 分流：`ScheduleTrigger` → `prev_occurrence()`；`CronTrigger` → croniter **逐字不变**。
- marker / catch-up / 配置变更失效机制与 cron 完全同构：`_trigger_hash()` 对 `CronTrigger` 与历史
  `_cron_hash` **字节一致**（升级不重置存量 marker），对 `ScheduleTrigger` 用 `rule+anchor+timezone`
  的 canonical JSON（任一字段变更 → marker 失效 → 追赶起点重算）。
- `anchor` 之前无 occurrence → `prev_occurrence` 返回 `None` → 不 fire（首个 fire 点还没到）。
- 🔴 **下游 `trigger_kind` 仍报 `"cron"`**：schedule 与 cron 同属「定时族」，run_worker 标签 /
  gateway `contextMode='cron_headless'` / `fire_key` 解析全部零改动。派生表见 §7。

### 6.2 报告 Agent（`src/reports/worker.py`）

- `_rule_entries()` = 新老形状 → 求值输入的唯一入口；`_due_occurrence()` 取代老 `_due_hour()`，
  两分支（当前 fire window / 当天单次 catch-up）与老实现逐字等价，weekly/monthly 的周期校验
  由求值器天然覆盖。
- slot marker 按 **occurrence 自己的本地日 + 钟点**（老形状 minute 恒 0、窗口不跨日 → 与旧
  「now 的日期」字节相同）。
- **坏 payload → skip + warning，不猜**（镜像 trigger_worker 的坏配置纪律）。
- ⚠️ 报告侧有**两个时区消费点**：fire 判定读 `schedule_json.timezone`（新形状权威）；
  窗口 / `report_date` / 叙述读 `report_agent.timezone` 列（`_agent_local`，空 = 宿主机本地）。
  抽屉只暴露一个时区选择器，但 `trigger_mode='rolling_24h'` 时**列仍被写空**（历史语义保持）——
  于是 owner 若在构建器里选了**非宿主机**时区且 trigger_mode=rolling_24h，fire 按所选时区、
  日期标签按宿主机时区，边界上可差一天。`natural_day` 时列 = 构建器时区，两者同源。
  现有行迁移时列写实成宿主机值 → 行为等价。

---

## 7. UI 接入约束

- **同一个组件**服务两处；报告抽屉传 `lockFreq` 锁死频率段 —— cadence 决定报告种类，
  不允许被排程编辑改掉（§1.1）。
- 报告专属正交字段 `trigger_mode`(rolling_24h/natural_day) / `window_hours` /
  `body_full_priorities` **留在报告抽屉自渲染**，不进共享组件。
- 🔴 预览按**选定 IANA 时区**的墙钟算，不是浏览器本地时区 —— 否则「所见即所跑」不成立。
- 呈现保留上游组件的核心价值：live 句子（中英双语，zh 是中文语序不是直译）+ 「接下来 5 次真实运行」
  + 月末 skip / clamp 如实标注 + DST 偏移变化标注；尊重 `prefers-reduced-motion`。
- 人审面必须能呈现 schedule 触发（`summarizeAgentTrigger` / `triggerSummary`），
  否则 owner 批的是一个看不见的触发。
- **chat 对话式 CRUD（`custom_agent_create` / `custom_agent_update`）三种 kind 全收**
  （issue #65 补齐 —— 07-24 落地时漏了 `schedule`，chat 只能把排程 agent 降级成 cron）。
  gateway 的 `customAgentTriggerSchema` 只是**第一道 allowlist**：`.strict()` + rule 10 键全量，
  语义深校验（真实日历日、IANA 时区、croniter）一律留在 `trigger.py`，与 cron 同纪律；
  两侧形状对齐由 §5 的形状闸锁死。仍恒过人审卡。
- `trigger.kind → contextMode` 派生表有**三处镜像**，改一处必须同步三处，见
  [`architecture-internals.md`](./architecture-internals.md)「跨语言手抄常量的一致性闸」+
  `tests/api/test_context_mode_consistency.py`（canonical 表 = 该测试文件）。

---

## 8. 已知限制 / 不做

- 一天多时点收敛（§4.1）。
- 不合并 `schedule_json` / `trigger_json` 两列（两列各服务各自 agent type）。
- 不加 DB 列、不 bump `DB_VERSION`。
- 不动 `frontend/src/shared/components/calendar/lib/rrule.ts`（日历事件的 RRULE 串
  builder/parser，值模型不同，两套有意分离）。

---

> 契约原始版本（立项时的待办口吻 + 实现前的约束清单）留在
> `.trellis/tasks/07-24-custom-agents-tab-agents-schedule-builder-custom-cron-agent/research/schedule-contract.md`
> 供历史追溯；**当前真相以本文为准**。
