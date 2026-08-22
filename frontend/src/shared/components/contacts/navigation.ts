// 人物页直达通道（通讯录 WP4）。逐字镜像 components/matters/navigation.ts 的
// store-intent 形状：调用方先在 store 里点名目标 contact，再 navigate('/contacts')，
// ContactsWorkspace 消费即清（effect 里 setSelectedId + clear）。
// detail 按 id 独立拉（GET /contacts/{id}），不依赖当前列表视图包含该行 ——
// hidden/robot 的人物页也能打开。

//
// 通知中心 M2 批 B5 在同一个 store 上加了**第二条轴**：治理队列（`queueRequested`）。
// 两条轴的消费方是同一个组件（ContactsWorkspace）、语义同类（「跨页打开通讯录的某个
// 东西」），另起一个 store 只会让 workspace 订阅两份同形状的 state；两条轴各自独立
// 置位/清除，互不影响（一条 intent 落地不该把另一条吃掉）。

import { create } from 'zustand'

interface ContactNavigationState {
  targetContactId: number | null
  open(id: number): void
  clear(): void
  /** true = 有一条「打开治理队列抽屉」的待办意图（通知中心 `contact_queue` link）。 */
  queueRequested: boolean
  openQueue(): void
  clearQueue(): void
}

export const useContactNavigation = create<ContactNavigationState>((set) => ({
  targetContactId: null,
  open: (targetContactId) => set({ targetContactId }),
  clear: () => set({ targetContactId: null }),
  queueRequested: false,
  openQueue: () => set({ queueRequested: true }),
  clearQueue: () => set({ queueRequested: false })
}))
