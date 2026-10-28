// DavMail 重新认证弹窗的开合（task 10-28-davmail-self-reauth）。全局单实例，三处入口共用：
// 设置 → 账户 → DavMail、看板 DavMail 卡片、认证类通知（面板内点击 + macOS 系统通知点击）。
// 形状照 state/feedback.ts。

import { create } from 'zustand'

interface DavMailReauthState {
  open: boolean
  /** 每次打开 +1，弹窗内容以它作 key —— 开一次就是全新的会话与输入框（理由同 feedback.ts）。 */
  openSeq: number
  openDialog(): void
  closeDialog(): void
}

export const useDavMailReauthStore = create<DavMailReauthState>((set) => ({
  open: false,
  openSeq: 0,
  openDialog: () => set((s) => ({ open: true, openSeq: s.openSeq + 1 })),
  closeDialog: () => set({ open: false })
}))
