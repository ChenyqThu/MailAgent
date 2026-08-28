// 标签工作区的接线层（task 08-27 P2 Lane W）。
//
// store 本体（tab-workspace.ts，波 1 定稿，51 条专测钉着语义）不认识 i18n / 别的 store；
// 「开标签顺带要做的事」全收敛在这里：
//   - 结局 toast（只有 opened 带 evicted / rejected 两支需要提示，activated / replaced 静默）；
//   - locked 的两个来源（compose 打开指向该标签 · AI 抽屉里就它发过消息）+ draft 快照在场；
//   - per-tab 抽屉开合的记录与恢复（useAIChatPanel.visible 是全局单例，切标签时按目标标签
//     的 drawerOpen 恢复）。
//
// 🔴 弹出窗（popout）不渲染标签条，且与主窗共用同一个 localStorage 键 —— popout 里任何标签
// 写入都会覆盖主窗的持久化标签集（tab-workspace 有意不挂 storage 监听，写了主窗也察觉不到），
// 故本模块所有入口在 popout 下一律 no-op（active-email 在 popout 下退回纯本地投影）。

// 🔴 引 i18next 单例而不是 `@shared/i18n`：后者顶层拉 react-i18next（initReactI18next），
// 会把「mock 了 react-i18next 的无关测试」全部炸掉（active-email → bridge 进了它们的
// import 图）。两者是同一个单例 —— app 入口加载 @shared/i18n 完成 init 后这里 t() 即真值；
// 未 init 的裸单元测试环境退回 key 原文（toast 不该让任何测试环境崩）。
import i18next from 'i18next'

import { useAIChatPanel } from './ai-chat-panel'
import { useComposeStore } from './compose'
import { usePopoutMode } from './popout-mode'
import {
  SEARCH_TARGET_ID,
  selectActiveTab,
  tabId,
  useTabWorkspace,
  type DraftSnapshot,
  type OpenTabResult,
  type ReplaceTabResult,
  type TabDescriptor,
  type TabKind
} from './tab-workspace'
import { toastInfo } from './toast'

function inert(): boolean {
  return usePopoutMode.getState().isPopout
}

function tr(key: string, opts?: Record<string, unknown>): string {
  return i18next.isInitialized ? i18next.t(key, opts) : key
}

export function getObjectTab(kind: TabKind, targetId: number): TabDescriptor | null {
  const id = tabId(kind, targetId)
  return useTabWorkspace.getState().tabs.find((t) => t.id === id) ?? null
}

/** 结局 toast —— 开标签这件事的**唯一**「结果 → 提示」判据。判据只看 `opened` 带
 *  evicted / `rejected` 两支（store 契约注释同款）：`activated`（本来就开着）与
 *  `replaced`（原位变身）都是用户自己按出来的直接结果，出提示是噪音。
 *  文案键用 Lane U 建好的 `tabs.*` 词表，不另起第二套。
 *
 *  🔴 键盘命令层（tab-commands）也调这一份，不在那边再写一遍 —— 反过来（判据放
 *  tab-commands、这里 import）不行：那个模块引 `@shared/i18n`（顶层拉 react-i18next），
 *  进了 active-email 的 import 图会炸掉一批 mock 了 react-i18next 的无关测试。
 *
 *  变体：两支都用 `toastInfo` —— 容量到顶不是失败（`toastError` 全仓是「操作真的错了」
 *  才用），与同批的 `list.folder.pinLimit` 同款。 */
export function announceTabResult(result: OpenTabResult | ReplaceTabResult | null): void {
  if (result === null) return
  if (result.outcome === 'rejected') {
    toastInfo(tr('tabs.toast.full'))
    return
  }
  if (result.outcome === 'opened' && result.evicted.length > 0) {
    const title = result.evicted[0].title || tr('tabs.untitled')
    if (result.evicted.length === 1) {
      toastInfo(tr('tabs.toast.evictedOne', { title }))
    } else {
      toastInfo(tr('tabs.toast.evictedMany', { title, count: result.evicted.length }))
    }
  }
}

/** 点行 / 深链 / 跨域跳转 —— 开或激活一个对象标签（去重在 store）。 */
export function openObjectTab(kind: TabKind, targetId: number, title?: string): void {
  if (inert()) return
  announceTabResult(useTabWorkspace.getState().openTab(kind, targetId, title))
}

/** ⌘T / 标签条「+」/ `/search` 深链 —— 打开「新标签页」搜索单例（已开着则只激活）。
 *  标题快照只给 toast / closedStack 用（标签条渲染按 kind 直取 i18n，不读快照），
 *  这里顺手写一份当前语言的，免得淘汰 toast 报「无标题」。 */
export function openSearchTab(): void {
  if (inert()) return
  announceTabResult(
    useTabWorkspace.getState().openTab('search', SEARCH_TARGET_ID, tr('tabs.searchTitle'))
  )
}

/** J/K · 归档/删除后续选 · 冷启动选第一条 —— 原位换目标，不涨标签数。
 *  🔴 只允许**同类**标签原位变身：激活位挂着另一类对象（比如人在邮件域、激活的还是事项
 *  标签）时变身会把那个标签整个吃掉，退回 openTab。锁定 / 已开在他处 / 主标签激活的
 *  分支 store 自己处理。 */
export function replaceObjectTab(kind: TabKind, targetId: number, title?: string): void {
  if (inert()) return
  const state = useTabWorkspace.getState()
  const active = selectActiveTab(state)
  if (active !== null && active.kind !== kind) {
    announceTabResult(state.openTab(kind, targetId, title))
    return
  }
  announceTabResult(state.replaceActiveTab(kind, targetId, title))
}

/** 对象被真删除（事项删除等）时收掉它的标签。后继激活语义归 store（最近用过的接管）。 */
export function closeObjectTab(kind: TabKind, targetId: number): void {
  if (inert()) return
  useTabWorkspace.getState().closeTab(tabId(kind, targetId))
}

/** 标题回填（详情数据到位后）。同值不写 —— updateTab 每次调用都落一次 localStorage。 */
export function setObjectTabTitle(kind: TabKind, targetId: number, title: string): void {
  if (inert() || title === '') return
  const tab = getObjectTab(kind, targetId)
  if (tab === null || tab.title === title) return
  useTabWorkspace.getState().updateTab(tab.id, { title })
}

/** 滚动位置快照。🔴 只在切走 / 卸载时调一次（store 注释要求消费方节流），不挂 scroll 事件。 */
export function saveObjectTabScroll(kind: TabKind, targetId: number, scrollTop: number): void {
  if (inert()) return
  const tab = getObjectTab(kind, targetId)
  if (tab === null) return
  const rounded = Math.max(0, Math.round(scrollTop))
  if (tab.scrollTop === rounded) return
  useTabWorkspace.getState().updateTab(tab.id, { scrollTop: rounded })
}

export function getObjectTabScroll(kind: TabKind, targetId: number): number {
  return getObjectTab(kind, targetId)?.scrollTop ?? 0
}

// ── locked：两个来源 + draft 快照在场 ───────────────────────────────────────
//
// ① compose 打开且指向该邮件标签（compose store 订阅驱动，open/close 都重算）；
// ② 本标签的对象在 AI 抽屉里发过消息（AgentConversation 的 send 路径上报）；
// ③ 标签上挂着 draft 快照（写了一半切走 —— 快照还在就不许被 LRU 淘汰）。
//
// ② 是会话级内存集合：重启后 locked 位本身随标签持久化恢复，模块加载时把
// 「locked 且无 draft」的标签回灌进集合 —— 否则重启后第一次 compose open/close
// 重算会把上一会话聊出来的锁误清掉。

const chatActivity = new Set<string>()

for (const tab of useTabWorkspace.getState().tabs) {
  if (tab.locked && tab.draft === undefined) chatActivity.add(tab.id)
}

function composeLocksTarget(kind: TabKind, targetId: number): boolean {
  if (kind !== 'email') return false
  const cs = useComposeStore.getState()
  return cs.open && cs.internalId === targetId
}

export function recomputeObjectTabLock(kind: TabKind, targetId: number): void {
  if (inert()) return
  const tab = getObjectTab(kind, targetId)
  if (tab === null) return
  const locked =
    composeLocksTarget(kind, targetId) || chatActivity.has(tab.id) || tab.draft !== undefined
  if (tab.locked !== locked) useTabWorkspace.getState().updateTab(tab.id, { locked })
}

/** AI 抽屉里带着这个对象发出一轮（AgentConversation 的 send 路径调用）。幂等。 */
export function notifyTabChatActivity(kind: TabKind, targetId: number | null): void {
  if (inert() || targetId === null) return
  chatActivity.add(tabId(kind, targetId))
  recomputeObjectTabLock(kind, targetId)
}

/** draft 快照写入（compose 面板卸载时的现场快照）。顺带重算 locked。 */
export function saveObjectTabDraft(kind: TabKind, targetId: number, draft: DraftSnapshot): void {
  if (inert()) return
  const tab = getObjectTab(kind, targetId)
  if (tab === null) return
  useTabWorkspace.getState().updateTab(tab.id, { draft })
  recomputeObjectTabLock(kind, targetId)
}

/** draft 快照清除（真实关闭：发送成功 / 显式丢弃）。顺带重算 locked。 */
export function clearObjectTabDraft(kind: TabKind, targetId: number): void {
  if (inert()) return
  const tab = getObjectTab(kind, targetId)
  if (tab === null || tab.draft === undefined) return
  useTabWorkspace.getState().updateTab(tab.id, { draft: undefined })
  recomputeObjectTabLock(kind, targetId)
}

// 读侧没有 getter：EmailDetail 要的是**响应式**的 draft（切标签时组件得重渲），
// 走 `useTabWorkspace` 选择器直接取描述符上的 draft，不经本模块。

// compose open/close → 涉事邮件标签重算 locked。
useComposeStore.subscribe((state, prev) => {
  if (inert()) return
  if (state.open === prev.open && state.internalId === prev.internalId) return
  if (prev.internalId !== null) recomputeObjectTabLock('email', prev.internalId)
  if (state.internalId !== null && state.internalId !== prev.internalId) {
    recomputeObjectTabLock('email', state.internalId)
  }
})

// ── per-tab 抽屉开合 ────────────────────────────────────────────────────────
//
// 切到已存在的标签 → 按它记录的 drawerOpen 恢复全局 dock 的 visible；
// 这次提交里**刚开出来**的标签（openTab / replaceActiveTab 的新描述符，drawerOpen 恒 false）
// → 反向种子：继承当前 visible（J/K 连翻邮件不该把开着的抽屉一路关掉）。
// 主标签（页面型承载）不入 per-tab 记录，激活主标签时抽屉维持现状。

useTabWorkspace.subscribe((state, prev) => {
  if (inert()) return
  if (state.active === prev.active) return
  const tab = selectActiveTab(state)
  if (tab === null) return
  const panel = useAIChatPanel.getState()
  const isNew = !prev.tabs.some((t) => t.id === tab.id)
  if (isNew) {
    if (tab.drawerOpen !== panel.visible) {
      useTabWorkspace.getState().updateTab(tab.id, { drawerOpen: panel.visible })
    }
    return
  }
  if (panel.visible !== tab.drawerOpen) panel.setVisible(tab.drawerOpen)
})

// 抽屉开合 → 记到当前激活的对象标签上。
useAIChatPanel.subscribe((state, prev) => {
  if (inert()) return
  if (state.visible === prev.visible) return
  const ws = useTabWorkspace.getState()
  const tab = selectActiveTab(ws)
  if (tab === null || tab.drawerOpen === state.visible) return
  ws.updateTab(tab.id, { drawerOpen: state.visible })
})

/** 测试用复位 —— 模块级集合跨用例存活。 */
export function _resetTabBridgeForTest(): void {
  chatActivity.clear()
}
