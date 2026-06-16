// 写新邮件 (compose new) 可见性 state — 全局动作，不依赖任何已打开的邮件。
//
// 与 state/compose.ts 的 `useComposeStore` 刻意分离：后者是 detail 列的
// reply / reply-all / forward overlay，强绑源邮件 `internalId`，由 EmailDetail
// 渲染。写新邮件没有源邮件，是「全局动作」——用居中模态 (ComposeNewModal 挂在
// RootLayout 全局)，从任意页面 (收件箱 / agents / 日历…) 都能打开。共用同一个
// ComposePanelInner，只是 mode='new' + variant='modal'。只允许单实例打开。

import { create } from 'zustand'

interface ComposeNewStore {
  open: boolean
  /** 打开写新邮件模态。 */
  openCompose(): void
  /** 关闭 (发送成功 / 放弃 / ESC)。 */
  close(): void
}

export const useComposeNewStore = create<ComposeNewStore>((set) => ({
  open: false,
  openCompose() {
    set({ open: true })
  },
  close() {
    set({ open: false })
  }
}))

/** 模块级 helper for 非 React 调用方 (keymap / sidebar 按钮)。 */
export function openNewCompose(): void {
  useComposeNewStore.getState().openCompose()
}

export function closeNewCompose(): void {
  useComposeNewStore.getState().close()
}
