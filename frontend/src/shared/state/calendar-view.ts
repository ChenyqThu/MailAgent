// task 08-27 P3 / dogfood 轮 2 —— 日历视图模块级 store：currentDate + 组级开关
// + 组内成员排除集。
//
// currentDate 此前是 CalendarLayout 组件内 useState，提升到这里后日历域二级栏
// （CalendarSourcePanel）能按同一个锚定日期算成员聚合窗口。currentDate 是会话态，
// **不持久化**（重启回到今天）。
//
// 两级选择：
//   - 组级 `sources[s]`（邮箱 / 事项 / Agent）—— 语义不变（既有消费者与持久化兼容）；
//   - 成员级 `excluded[s]`（calendar 名 / matterId / agentId）—— 存的是**排除集**，
//     默认空 = 全选。选排除而不选选中，是为了让窗口里新冒出来的成员（新建的事项、
//     新加排程的 agent）天然是选中的，不必先回写一遍状态。
//
// 两者都是 client-side 过滤判据，不进 react-query queryKey —— 切勾选不重发请求
// （对齐「按日历筛选」既有惯例）。持久化 localStorage（形状校验 + 跨窗口 storage
// 同步，抄 pinned-folders 范式）；v1 老形状（只有三个 bool）读进来 = 排除集为空。
//
// 🔴 本文件不 import registry / router / hooks（HMR 失效链防御，仓内既有纪律）。

import { create } from 'zustand'

import type { AgendaSource } from '@shared/api/types'

const SOURCES_KEY = 'mailagent.calendar.sources.v1'

export type CalendarSourceToggles = Record<AgendaSource, boolean>
/** 组内被取消勾选的成员 id 集合（空 = 该组全选）。 */
export type CalendarMemberExclusions = Record<AgendaSource, ReadonlySet<string>>

export const DEFAULT_SOURCE_TOGGLES: CalendarSourceToggles = {
  mail: true,
  matter: true,
  agent: true
}

export function emptyExclusions(): CalendarMemberExclusions {
  return { mail: new Set(), matter: new Set(), agent: new Set() }
}

interface PersistedState {
  sources: CalendarSourceToggles
  excluded: CalendarMemberExclusions
}

function parseIdList(raw: unknown): Set<string> {
  if (!Array.isArray(raw)) return new Set()
  return new Set(raw.filter((v): v is string => typeof v === 'string'))
}

function parseState(raw: string | null): PersistedState {
  const fallback: PersistedState = {
    sources: { ...DEFAULT_SOURCE_TOGGLES },
    excluded: emptyExclusions()
  }
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return fallback
    const rec = parsed as Record<string, unknown>
    const pick = (k: AgendaSource): boolean =>
      typeof rec[k] === 'boolean' ? (rec[k] as boolean) : DEFAULT_SOURCE_TOGGLES[k]
    // v1 老形状没有 excluded 这一层 —— 缺了就是空集（= 全选），不是错误。
    const ex = (rec.excluded ?? {}) as Record<string, unknown>
    const exRec = ex && typeof ex === 'object' ? ex : {}
    return {
      sources: { mail: pick('mail'), matter: pick('matter'), agent: pick('agent') },
      excluded: {
        mail: parseIdList(exRec.mail),
        matter: parseIdList(exRec.matter),
        agent: parseIdList(exRec.agent)
      }
    }
  } catch {
    return fallback
  }
}

function readState(): PersistedState {
  if (typeof window === 'undefined') {
    return { sources: { ...DEFAULT_SOURCE_TOGGLES }, excluded: emptyExclusions() }
  }
  try {
    return parseState(window.localStorage.getItem(SOURCES_KEY))
  } catch {
    return { sources: { ...DEFAULT_SOURCE_TOGGLES }, excluded: emptyExclusions() }
  }
}

function writeState(next: PersistedState): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      SOURCES_KEY,
      JSON.stringify({
        ...next.sources,
        excluded: {
          mail: [...next.excluded.mail],
          matter: [...next.excluded.matter],
          agent: [...next.excluded.agent]
        }
      })
    )
  } catch {
    /* quota / private mode —— 状态留在内存里 */
  }
}

interface CalendarViewState extends PersistedState {
  /** 主视图当前锚定日期（月视图 = 该月，日/周视图 = 该日所在段）。 */
  currentDate: Date
  setCurrentDate(d: Date): void
  /** 组头勾选：on → 开组 + 清空排除（= 全选）；off → 关组 + 清空排除。 */
  setGroupAll(s: AgendaSource, on: boolean): void
  /** 成员勾选。`memberIds` = 该组当前全部成员，用来判「是不是把最后一条也关了」。 */
  toggleMember(s: AgendaSource, id: string, memberIds: readonly string[]): void
  /** 「按日历筛选」下拉写回：选中集 → 排除集。空选中集 = 全选（下拉既有语义）。 */
  setSelectedMembers(s: AgendaSource, allIds: readonly string[], selected: readonly string[]): void
}

export const useCalendarView = create<CalendarViewState>((set, get) => {
  const commit = (next: PersistedState): void => {
    writeState(next)
    set({ sources: next.sources, excluded: next.excluded })
  }
  return {
    ...readState(),
    currentDate: new Date(),
    setCurrentDate: (d) => set({ currentDate: d }),
    setGroupAll: (s, on) => {
      const st = get()
      commit({
        sources: { ...st.sources, [s]: on },
        excluded: { ...st.excluded, [s]: new Set() }
      })
    },
    toggleMember: (s, id, memberIds) => {
      const st = get()
      if (!st.sources[s]) {
        // 组关着时点某一条 = 「只看这一条」。单纯从空排除集里再删一个是无操作，
        // 点了什么都不变 —— 那才是坏交互。
        commit({
          sources: { ...st.sources, [s]: true },
          excluded: { ...st.excluded, [s]: new Set(memberIds.filter((m) => m !== id)) }
        })
        return
      }
      const next = new Set(st.excluded[s])
      if (next.has(id)) next.delete(id)
      else next.add(id)
      // 只数**当前成员**里的排除项：持久化下来的陈旧 id（事项已完成 / agent 已删）
      // 不该算进「是不是全关了」。
      const liveExcluded = memberIds.filter((m) => next.has(m)).length
      if (memberIds.length > 0 && liveExcluded >= memberIds.length) {
        // 最后一条也取消 = 整组不看 ⇒ 收敛成「组关 + 排除集清空」，组再开回来是全选。
        commit({
          sources: { ...st.sources, [s]: false },
          excluded: { ...st.excluded, [s]: new Set() }
        })
        return
      }
      commit({ sources: st.sources, excluded: { ...st.excluded, [s]: next } })
    },
    setSelectedMembers: (s, allIds, selected) => {
      const st = get()
      const keep = new Set(selected)
      commit({
        sources: st.sources,
        excluded: {
          ...st.excluded,
          [s]: keep.size === 0 ? new Set() : new Set(allIds.filter((id) => !keep.has(id)))
        }
      })
    }
  }
})

// 跨窗口同步（弹出窗与主窗共用同一份勾选）——同 pinned-folders / group-collapse 范式。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== SOURCES_KEY) return
    const next = parseState(e.newValue)
    useCalendarView.setState({ sources: next.sources, excluded: next.excluded })
  })
}
