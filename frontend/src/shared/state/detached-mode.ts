// task 08-27 P5「拖出成独立窗口」形态 B —— 轻窗的模式检测 + boot 解析。
//
// 对照 popout-mode（Sprint 14 PR E）：同样是「这个 renderer 该挂哪个壳」的启动期
// 判据，同样由 renderer/main.tsx 在 React.render **之前**从 window.location.search
// 读出来（首帧就是对的壳，不闪主界面）。差别只有一处：轻窗带**两类**目标（一封邮件 /
// 一份报告），所以存的是判别联合而不是单个 id。
//
// 🔴 形态 B 有意不做的事（判据见 .trellis/tasks/08-27-l4-tab-workspace/research/
// r13-p5-landscape.md §2.4-2.5）：
//   · 不挂 TanStack Router —— 轻窗只装一件内容，没有侧栏 / 列表 / 设置页可导航；
//   · 不渲染标签条、**不写任何标签 store** —— 标签集与主窗共用同一个 localStorage 键
//     且有意不挂 storage 监听，轻窗写一次就把主窗的标签集覆盖掉（tab-workspace-bridge
//     的 inert() 已把本模式一并短路）；
//   · 因此这里也不是「把标签整个拖出去」（那是形态 A，前提是先翻掉 tab-workspace 的
//     所有权模型）——轻窗是「在新窗口打开这一封 / 这一份」。

import { create } from 'zustand'

/** 轻窗装的是什么。kind 决定 DetachedShell 挂哪个内容组件。 */
export type DetachedTarget =
  | { kind: 'email'; emailId: number }
  | { kind: 'report'; reportId: string }

interface DetachedModeStore {
  /** True when this renderer instance was launched as a detached light window. */
  isDetached: boolean
  target: DetachedTarget | null
  setDetached(target: DetachedTarget): void
}

export const useDetachedMode = create<DetachedModeStore>((set) => ({
  isDetached: false,
  target: null,
  setDetached(target) {
    set({ isDetached: true, target })
  }
}))

/**
 * 解析 `?detach=email&id=N` / `?detach=report&id=<reportId>` 并写进 store。
 * 幂等 + 可在 React.render 之前调用。返回解析出的目标（不是轻窗则 null），
 * 让调用方能据此决定要不要跑别的启动副作用（同 bootPopoutModeFromQuery）。
 */
export function bootDetachedModeFromQuery(): DetachedTarget | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const kind = params.get('detach')
  const raw = params.get('id')
  if (raw === null || raw === '') return null
  let target: DetachedTarget
  if (kind === 'email') {
    // internal_id 在本仓 schema 里恒 >= 0；非数字 / 负数静默拒（同 popout 解析器：
    // 主进程两个参数一起写，坏值只可能来自手敲 URL）。
    const emailId = Number.parseInt(raw, 10)
    if (!Number.isFinite(emailId) || emailId < 0) return null
    target = { kind: 'email', emailId }
  } else if (kind === 'report') {
    // report id 是字符串主键，除了非空没有别的形状约束。
    target = { kind: 'report', reportId: raw }
  } else {
    return null
  }
  useDetachedMode.getState().setDetached(target)
  return target
}

/** 入口门控：轻窗是 Electron BrowserWindow 能力，远程 web 没有第二窗口的概念。
 *  判据抄 openMeetingLink / notionOauthIpc —— 直接摸 preload 注入的 ipcRenderer
 *  （openDetached 走的是 send，故探 send 而不是 invoke）。 */
export function canOpenDetachedWindow(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as unknown as { electron?: { ipcRenderer?: { send?: unknown } } }
  return typeof w.electron?.ipcRenderer?.send === 'function'
}
