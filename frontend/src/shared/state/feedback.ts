// 快捷反馈的 renderer 状态（task 08-27-l4-tab-workspace P4a）。
//
// 两件事：
//   · 弹窗开合（全局单实例，入口在设置域二级栏底部）；
//   · 一条本机偏好 —— 「发送反馈时默认附上诊断包」。它是**设置 › 通用 › 诊断**里那一行开关，
//     决定弹窗里那一项的初值。🔴 两处是同一个包、同一个偏好，别做成两套。
//
// 偏好落 localStorage（外观 / 标签工作区同款），不进后端。

import { create } from 'zustand'

const KEY = 'mailagent.feedback.attachDiagnostics'

function readAttachDiagnostics(): boolean {
  if (typeof localStorage === 'undefined') return false
  // 出厂默认**不勾**：诊断包要花约 1 分钟组装，不该为每一条「建议」都付这个代价。
  return localStorage.getItem(KEY) === '1'
}

interface FeedbackState {
  open: boolean
  /** 「发送反馈时附上诊断包」的默认值。 */
  attachDiagnosticsDefault: boolean
  openDialog(): void
  closeDialog(): void
  setAttachDiagnosticsDefault(v: boolean): void
}

export const useFeedbackStore = create<FeedbackState>((set) => ({
  open: false,
  attachDiagnosticsDefault: readAttachDiagnostics(),
  openDialog: () => set({ open: true }),
  closeDialog: () => set({ open: false }),
  setAttachDiagnosticsDefault: (v) => {
    if (typeof localStorage !== 'undefined') {
      if (v) localStorage.setItem(KEY, '1')
      else localStorage.removeItem(KEY)
    }
    set({ attachDiagnosticsDefault: v })
  }
}))
