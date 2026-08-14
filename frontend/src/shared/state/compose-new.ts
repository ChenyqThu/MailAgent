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
  /** 预填收件人（通讯录「写邮件」等入口；null = 空表单）。仅在打开那一刻消费，
   *  关闭即清 —— 下一次 ⌘N 不带上一次的人。 */
  prefillTo: string | null
  /** 打开写新邮件模态（可选预填收件人）。 */
  openCompose(prefillTo?: string): void
  /** 关闭 (发送成功 / 放弃 / ESC)。 */
  close(): void
}

export const useComposeNewStore = create<ComposeNewStore>((set) => ({
  open: false,
  prefillTo: null,
  openCompose(prefillTo?: string) {
    set({ open: true, prefillTo: prefillTo ?? null })
  },
  close() {
    set({ open: false, prefillTo: null })
  }
}))

/** 模块级 helper for 非 React 调用方 (keymap / sidebar 按钮 / 通讯录)。 */
export function openNewCompose(prefillTo?: string): void {
  useComposeNewStore.getState().openCompose(prefillTo)
}

export function closeNewCompose(): void {
  useComposeNewStore.getState().close()
}
