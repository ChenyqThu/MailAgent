// 人物页直达通道（通讯录 WP4）。逐字镜像 components/matters/navigation.ts 的
// store-intent 形状：调用方先在 store 里点名目标 contact，再 navigate('/contacts')，
// ContactsWorkspace 消费即清（effect 里 setSelectedId + clear）。
// detail 按 id 独立拉（GET /contacts/{id}），不依赖当前列表视图包含该行 ——
// hidden/robot 的人物页也能打开。

import { create } from 'zustand'

interface ContactNavigationState {
  targetContactId: number | null
  open(id: number): void
  clear(): void
}

export const useContactNavigation = create<ContactNavigationState>((set) => ({
  targetContactId: null,
  open: (targetContactId) => set({ targetContactId }),
  clear: () => set({ targetContactId: null })
}))
