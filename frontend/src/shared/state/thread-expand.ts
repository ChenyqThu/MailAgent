// Sprint 18 — 邮件线程「手风琴」展开状态.
//
// 语义相对旧版 (thread-collapse: 记录被主动折叠的 thread_id 集合, 默认全展开)
// 反转: 同一时刻**至多 1 条线程展开**, 只存单个 expandedKey. 点击线程母邮件 /
// chevron 展开某条时, 其它已展开的自动折叠.
//
// key 命名空间: 收件箱用裸 thread_id, 发件箱用 `outbox:` 前缀 (沿用旧约定,
// 两个视图对同一 thread_id 的展开状态互不污染). null = 全部折叠.
//
// 用 module-level zustand store (而非组件 useState) 是为了跨 re-render /
// route 切换 / SSE invalidate 保活 —— 旧版 useState<Set> 会被这些重渲重置
// ("老是忽然自己展开了"). 不落 localStorage: 手风琴只有 1 条展开, 跨会话恢复
// 单条意义不大, 且会与重新选中的活动邮件错位; 内存态已足够修复重渲丢失.

import { create } from 'zustand'

interface Store {
  expandedKey: string | null
  /** 强制展开 (手风琴: 替换任何已展开项). 用于点击母邮件行体. */
  expand(key: string): void
  /** 切换: 已展开则折叠, 否则展开. 用于 chevron 按钮. */
  toggle(key: string): void
}

export const useThreadExpand = create<Store>((set, get) => ({
  expandedKey: null,
  expand(key) {
    if (get().expandedKey === key) return
    set({ expandedKey: key })
  },
  toggle(key) {
    set({ expandedKey: get().expandedKey === key ? null : key })
  }
}))
