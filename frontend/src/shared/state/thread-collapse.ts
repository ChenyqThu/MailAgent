// Sprint 17 — 邮件线程展开 / 折叠状态持久化.
//
// 之前 EmailList 用本地 useState<Set<string>> 维护; 重启 / 路由切换 / SSE
// invalidate 触发的列表重渲都会把它丢掉 ("老是忽然自己展开了"). 这里抽出
// zustand store + localStorage, 与 group-collapse 的 date group 折叠状态
// 同模式.
//
// 语义: store 里只记录 **被用户主动折叠** 的 thread_id (Set);
//       默认 = "展开" — 跟原来一致.
//
// localStorage key: mailagent.emailList.threadCollapsed
// 持久格式: ["<thread_id>", ...] (sorted, 限制条数 200 防膨胀)

import { create } from 'zustand'

const KEY = 'mailagent.emailList.threadCollapsed'
const MAX_PERSIST = 200

function readPersisted(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((v): v is string => typeof v === 'string'))
    }
    return new Set()
  } catch {
    return new Set()
  }
}

function writePersisted(state: Set<string>): void {
  if (typeof window === 'undefined') return
  try {
    // 限 200 防止 set 无界膨胀; 排序后保留最近添加的（LRU 替代为简化方案）
    const list = Array.from(state).sort()
    const tail = list.slice(-MAX_PERSIST)
    window.localStorage.setItem(KEY, JSON.stringify(tail))
  } catch {
    /* quota / private mode — state stays in memory. */
  }
}

interface Store {
  collapsed: ReadonlySet<string>
  isCollapsed(threadId: string): boolean
  toggle(threadId: string): void
  setCollapsed(threadId: string, next: boolean): void
}

export const useThreadCollapse = create<Store>((set, get) => ({
  collapsed: readPersisted(),
  isCollapsed(threadId) {
    return get().collapsed.has(threadId)
  },
  toggle(threadId) {
    const next = new Set(get().collapsed)
    if (next.has(threadId)) next.delete(threadId)
    else next.add(threadId)
    writePersisted(next)
    set({ collapsed: next })
  },
  setCollapsed(threadId, nextVal) {
    const next = new Set(get().collapsed)
    if (nextVal) next.add(threadId)
    else next.delete(threadId)
    writePersisted(next)
    set({ collapsed: next })
  }
}))
