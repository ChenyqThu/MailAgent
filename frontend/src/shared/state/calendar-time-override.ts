// Lane C (#5) — 拖拽改期的本地乐观 override。
//
// 为什么需要它: calendar-undo 是 **commit-delay** 模型 (5s 窗口内点撤销 = 请求
// 从未发出), 所以松手那一刻服务端还什么都不知道; 视图若只认 react-query 缓存,
// 块会立刻弹回原位, 5s 后再跳到新位。这层薄 override 按 occurrence key 盖住
// 缓存里的起止时间, 让「松手即定位」成立。
//
// TTL 必须盖住整条链, 否则中途露出旧值:
//   落手 → 5s 撤销窗口 → PATCH (CalDAV PUT, **不写本地 calendar_event**;
//   src/api/routers/calendar.py::update_event 三分支全部只调 CalDAVWriter,
//   随后 _publish_calendar_synced 明写「本地 SQLite 行要等下轮 CalDAV reconcile
//   才落」) → CalendarSyncWorker 下一轮 (poll_interval=60s) 才把新时间拉回本地。
// 所以从落手算起最长 5 + 60 + reconcile ≈ 70s 本地库才是新值; TTL 取 90s 留余量。
//
// TTL 到点前服务端事实通常已经回来了: reconcile 一落, occurrence_start_iso 变成
// 新值 → override key (`${id}-${原始 start}`) 不再匹配任何块 → 自动让位, 不需要
// 谁来清。TTL 只是「服务端始终没变」时的兜底。PATCH 失败由调用方立即 clear。
//
// 🔴 有意**不**用 `calendar.synced` 事件来清: PATCH 成功那一刻 router 自己就发一发
// (calendar.py:795), 那发是我们自己写操作的回声、不代表 reconcile 落库, 拿它当清
// 信号 = 立刻退回旧值。
//
// _timers 与 calendar-undo.ts 同模式: 模块级 Map<key, timeout>, zustand state
// 保持纯 serializable。

import { create } from 'zustand'

/** 乐观 override 存活时长 (ms)。见文件头: 盖住 5s 撤销窗口 + 60s worker 回填 + 余量。 */
export const OVERRIDE_TTL_MS = 90_000

export interface CalendarTimeOverride {
  startIso: string
  endIso: string
}

interface OverrideStore {
  /** key = `${occ.id}-${occ.occurrence_start_iso}` (occurrenceKey, 恒取**原始**
   *  occurrence —— 同一块被连拖两次时覆盖同一条, 不产生链)。 */
  overrides: Record<string, CalendarTimeOverride>
  set(key: string, value: CalendarTimeOverride, ttlMs?: number): void
  clear(key: string): void
  /** test only — 清所有 entry + timer。 */
  _reset(): void
}

const _timers = new Map<string, ReturnType<typeof setTimeout>>()

function clearTimerFor(key: string): void {
  const tid = _timers.get(key)
  if (tid !== undefined) {
    clearTimeout(tid)
    _timers.delete(key)
  }
}

function dropKey(state: OverrideStore, key: string): Partial<OverrideStore> | null {
  if (!(key in state.overrides)) return null
  const next = { ...state.overrides }
  delete next[key]
  return { overrides: next }
}

export const useCalendarTimeOverrides = create<OverrideStore>((set, get) => ({
  overrides: {},
  set(key, value, ttlMs = OVERRIDE_TTL_MS) {
    clearTimerFor(key)
    set((s) => ({ overrides: { ...s.overrides, [key]: value } }))
    const tid = setTimeout(() => {
      _timers.delete(key)
      const patch = dropKey(get(), key)
      if (patch) set(patch)
    }, ttlMs)
    _timers.set(key, tid)
  },
  clear(key) {
    clearTimerFor(key)
    const patch = dropKey(get(), key)
    if (patch) set(patch)
  },
  _reset() {
    for (const tid of _timers.values()) clearTimeout(tid)
    _timers.clear()
    set({ overrides: {} })
  }
}))
