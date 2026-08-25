// Phase 2.5 §11.2 — Calendar undo toast store.
//
// 给 calendar 写操作的 "5 秒撤销" UX 用. 流程:
//   1. drawer [删除] 点击 → 关 drawer + push({ title, subtitle, durationMs:5000,
//      onCommit: () => deleteMut.mutate(uid), onUndo: () => ...})
//   2. setTimeout(5s) 触发 → 跑 onCommit (真发 CalDAV DELETE) + 移除 entry
//   3. 用户 5s 内点 [撤销] → clearTimeout + 跑 onUndo + 移除 entry
//
// 跟 src/shared/state/toast.ts 是**独立** store: 那个是顶部右侧普通 toast
// (3s auto-dismiss progress bar), 此处是底部居中的 undo toast (5s 撤销窗口),
// 两者 stack 互不干扰, 也避免与 toast queue cap (MAX_VISIBLE=4) 冲突.
//
// _timers 跟 toast.ts 同模式: 模块级 Map<id, timeout>, 保持 zustand state
// 是纯 serializable, commit/undo 都会主动 clearTimeout 防漏.

import { create } from 'zustand'

export interface UndoEntry {
  id: number
  /** toast 图标语义 (删除 = 垃圾桶 / 改期 = 时钟). 默认 'delete'.
   *  存字符串不存 ReactNode — state 要保持纯 serializable. */
  kind?: 'delete' | 'reschedule'
  title: string
  subtitle?: string
  /** 撤销窗口长度 (ms). 5 秒 = mockup 标准. */
  durationMs: number
  /** UI 计算 progress bar 起点用 (rAF 不依赖, 仅 debug / 未来 pause/resume 用). */
  startedAt: number
  /** durationMs 内未撤销时跑 (真发 DELETE / 真删等). */
  onCommit: () => void
  /** 用户点 [撤销] 跑. 可选. */
  onUndo?: () => void
}

interface UndoStore {
  items: UndoEntry[]
  push(input: Omit<UndoEntry, 'id' | 'startedAt'>): number
  /** 立即跑 onCommit + 移除 (手动加速; setTimeout 触发也走这条逻辑等价). */
  commit(id: number): void
  /** 用户撤销: clearTimeout + onUndo + 移除. */
  undo(id: number): void
  /** test only — clear 所有 entry + timer. */
  _reset(): void
}

let _nextId = 1
const _timers = new Map<number, ReturnType<typeof setTimeout>>()

function clearTimerFor(id: number): void {
  const tid = _timers.get(id)
  if (tid !== undefined) {
    clearTimeout(tid)
    _timers.delete(id)
  }
}

export const useUndoToastStore = create<UndoStore>((set, get) => ({
  items: [],
  push(input) {
    const id = _nextId++
    const entry: UndoEntry = {
      ...input,
      id,
      startedAt: Date.now()
    }
    set((s) => ({ items: [...s.items, entry] }))
    const tid = setTimeout(() => {
      _timers.delete(id)
      const cur = get().items.find((t) => t.id === id)
      if (cur) {
        try {
          cur.onCommit()
        } catch (err) {
          // 不重 throw — UX 上 commit 失败应该走业务侧 onError 而非这层

          console.error('[calendar-undo] commit error', err)
        }
        set((s) => ({ items: s.items.filter((t) => t.id !== id) }))
      }
    }, input.durationMs)
    _timers.set(id, tid)
    return id
  },
  commit(id) {
    const cur = get().items.find((t) => t.id === id)
    if (!cur) return
    clearTimerFor(id)
    try {
      cur.onCommit()
    } catch (err) {
      console.error('[calendar-undo] commit error', err)
    }
    set((s) => ({ items: s.items.filter((t) => t.id !== id) }))
  },
  undo(id) {
    const cur = get().items.find((t) => t.id === id)
    if (!cur) return
    clearTimerFor(id)
    try {
      cur.onUndo?.()
    } catch (err) {
      console.error('[calendar-undo] undo error', err)
    }
    set((s) => ({ items: s.items.filter((t) => t.id !== id) }))
  },
  _reset() {
    for (const tid of _timers.values()) clearTimeout(tid)
    _timers.clear()
    set({ items: [] })
  }
}))
