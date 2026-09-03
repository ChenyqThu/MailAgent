// 标签工作区的接线层（task 08-27 P2 Lane W）。
//
// store 本体（tab-workspace.ts，波 1 定稿，51 条专测钉着语义）不认识 i18n / 别的 store；
// 「开标签顺带要做的事」全收敛在这里：
//   - 结局 toast（dogfood 轮4 起**只剩 rejected 一支**出声；LRU 驱逐静默，见 announceTabResult）；
//   - locked 的两个来源（compose 打开指向该标签 · AI 抽屉里就它发过消息）+ draft 快照 dirty；
//   - per-tab 抽屉开合的记录与恢复（useAIChatPanel.visible 是全局单例，切标签时按目标标签
//     的 drawerOpen 恢复）。
//
// 🔴 弹出窗（popout）不渲染标签条，且与主窗共用同一个 localStorage 键 —— popout 里任何标签
// 写入都会覆盖主窗的持久化标签集（tab-workspace 有意不挂 storage 监听，写了主窗也察觉不到），
// 故本模块所有入口在 popout 下一律 no-op（active-email 在 popout 下退回纯本地投影）。
// task 08-27 P5 起「轻窗」（detached-mode：在新窗口打开一封邮件 / 一份报告）同样不渲染标签条，
// 判据一并收进 tabsInert()。

// 🔴 引 i18next 单例而不是 `@shared/i18n`：后者顶层拉 react-i18next（initReactI18next），
// 会把「mock 了 react-i18next 的无关测试」全部炸掉（active-email → bridge 进了它们的
// import 图）。两者是同一个单例 —— app 入口加载 @shared/i18n 完成 init 后这里 t() 即真值；
// 未 init 的裸单元测试环境退回 key 原文（toast 不该让任何测试环境崩）。
import i18next from 'i18next'
import { create } from 'zustand'

import { useAIChatPanel } from './ai-chat-panel'
import { useComposeStore } from './compose'
import { useDetachedMode } from './detached-mode'
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
  type TabId,
  type TabKind
} from './tab-workspace'
import { toastInfo } from './toast'

/** 「本窗口没有标签条」—— popout 与 P5 轻窗共用的判据。本模块所有入口据此 no-op；
 *  EmailDetail 的 404 标签核销读同一份（那条同样只在有标签条的窗口才成立）。 */
export function tabsInert(): boolean {
  return usePopoutMode.getState().isPopout || useDetachedMode.getState().isDetached
}

/** 模块内短名（各入口沿用），语义完全等同 tabsInert。 */
function inert(): boolean {
  return tabsInert()
}

function tr(key: string, opts?: Record<string, unknown>): string {
  return i18next.isInitialized ? i18next.t(key, opts) : key
}

export function getObjectTab(kind: TabKind, targetId: number): TabDescriptor | null {
  const id = tabId(kind, targetId)
  return useTabWorkspace.getState().tabs.find((t) => t.id === id) ?? null
}

/** 结局 toast —— 开标签这件事的**唯一**「结果 → 提示」判据。dogfood 轮4 拍板：
 *  **只剩 `rejected` 一支出声**（满且全锁定，真的没开成，用户需要知道该先关一个）。
 *  LRU 驱逐（`opened` 带 evicted）改为静默 —— 每次满员开新都弹「顺带关掉了谁」被
 *  owner 判为噪音；被挤掉的进最近关闭栈，⌘⇧T 可找回。`activated` / `replaced`
 *  一如既往静默（用户自己按出来的直接结果）。
 *
 *  🔴 键盘命令层（tab-commands）也调这一份，不在那边再写一遍 —— 反过来（判据放
 *  tab-commands、这里 import）不行：那个模块引 `@shared/i18n`（顶层拉 react-i18next），
 *  进了 active-email 的 import 图会炸掉一批 mock 了 react-i18next 的无关测试。
 *
 *  变体：`toastInfo` —— 容量到顶不是失败（`toastError` 全仓是「操作真的错了」才用），
 *  与同批的 `list.folder.pinLimit` 同款。 */
export function announceTabResult(result: OpenTabResult | ReplaceTabResult | null): void {
  if (result === null || result.outcome !== 'rejected') return
  toastInfo(tr('tabs.toast.full'))
}

/** 点行 / 深链 / 跨域跳转 —— 开或激活一个对象标签（去重在 store）。
 *  返回是否被接受（check 波3 续改）：标签满且全 locked 被拒时返回 false，投影桥
 *  （active-email.setActive / matters selectMatter）据此回滚本地选中 —— 不回滚就是
 *  「详情显示新对象、标签条还高亮旧标签」的劈叉。popout 走纯本地投影不写标签 store，
 *  视为接受（回滚反而会把 popout 的本地选中打掉）。 */
export function openObjectTab(kind: TabKind, targetId: number, title?: string): boolean {
  if (inert()) return true
  const result = useTabWorkspace.getState().openTab(kind, targetId, title)
  announceTabResult(result)
  return result.outcome !== 'rejected'
}

/** ⌘T / 标签条「+」/ `/search` 深链 —— 打开「新标签页」搜索单例（已开着则只激活）。
 *  标题快照只给 closedStack 用（标签条渲染按 kind 直取 i18n，不读快照），
 *  这里顺手写一份当前语言的，⌘⇧T 菜单/找回时才有名字可显。 */
export function openSearchTab(): void {
  if (inert()) return
  announceTabResult(
    useTabWorkspace.getState().openTab('search', SEARCH_TARGET_ID, tr('tabs.searchTitle'))
  )
}

/** J/K · 归档/删除后续选 · 冷启动选第一条 —— 原位换目标，不涨标签数。
 *  🔴 只允许**同类**标签原位变身：激活位挂着另一类对象（比如人在邮件域、激活的还是事项
 *  标签）时变身会把那个标签整个吃掉，退回 openTab。锁定 / 已开在他处 / 主标签激活的
 *  分支 store 自己处理。返回是否被接受（rejected 语义同 openObjectTab）。 */
export function replaceObjectTab(kind: TabKind, targetId: number, title?: string): boolean {
  if (inert()) return true
  const state = useTabWorkspace.getState()
  const active = selectActiveTab(state)
  const result =
    active !== null && active.kind !== kind
      ? state.openTab(kind, targetId, title)
      : state.replaceActiveTab(kind, targetId, title)
  announceTabResult(result)
  return result.outcome !== 'rejected'
}

/** 对象被真删除（事项删除等）时收掉它的标签。后继激活语义归 store（最近用过的接管）。 */
export function closeObjectTab(kind: TabKind, targetId: number): void {
  if (inert()) return
  useTabWorkspace.getState().closeTab(tabId(kind, targetId))
}

// ── 关闭守卫（dogfood 波3 草稿 tab）─────────────────────────────────────────
//
// ⌘W / 标签条 × 不再直打 store.closeTab：目标是 email 标签且 draft 快照 dirty 时，
// 先激活该标签（拍板：先激活再弹框），把「待关闭」挂在这里；EmailDetail 看到请求后
// 经当页 compose 面板的守卫句柄弹 UnsavedChangesDialog（保存链在面板里，这里只管
// 请求状态）。非 dirty / 非 email 标签维持 closeTab 原语义。
// 时序坑：closeTab 先摘标签再弹框的老路，取消时已无标签可回；先激活则面板在场，
// dirty 态与保存链都是现成的。

export interface PendingTabClose {
  readonly tabId: TabId
  readonly kind: TabKind
  readonly targetId: number
}

export const useTabCloseGuard = create<{ pending: PendingTabClose | null }>(() => ({
  pending: null
}))

export function clearTabCloseRequest(): void {
  useTabCloseGuard.setState({ pending: null })
}

/** 读 store 里的原始快照字段（不做 readComposeTabDraft 全量收窄）。锁计算（locked ③）
 *  与关闭守卫共用这一个判据 —— 两处口径分叉会出「不锁却拦 / 锁着却直接关」的错位。
 *  快照坏到恢复不出来时由 EmailDetail 的承接端直接放行关闭。 */
function draftSnapshotDirty(draft: DraftSnapshot | undefined): boolean {
  return draft !== undefined && (draft as { dirty?: unknown }).dirty === true
}

/** ⌘W / 标签条 × 的收敛入口。返回「这次按键被消费了」（含弹框期间的 no-op）。 */
export function requestCloseTab(id: TabId): boolean {
  if (inert()) return false
  const ws = useTabWorkspace.getState()
  const tab = ws.tabs.find((t) => t.id === id)
  if (tab === undefined) return false
  // 弹框（或等面板挂载）期间再次请求：忽略，防叠弹。
  if (useTabCloseGuard.getState().pending !== null) return true
  if (tab.kind !== 'email' || !draftSnapshotDirty(tab.draft)) {
    ws.closeTab(id)
    return true
  }
  ws.activateTab(id)
  useTabCloseGuard.setState({ pending: { tabId: id, kind: tab.kind, targetId: tab.targetId } })
  return true
}

// 待关闭请求的作废清理，别让 ⌘W 永久哑掉：① 目标标签消失（404 核销 / 别的路径关掉）；
// ② 激活槽离开目标（弹窗出来前用户又切走了，或弹窗下用 ⌘1-9 / ⌃⇥ 切走 —— 承接弹窗
// 的面板会随详情卸载，stash 的 proceed 一起没了）。requestCloseTab 先激活再挂请求、
// retargetObjectTab 先迁请求再提交 store，两条时序都保证本清理不误伤在途请求。
useTabWorkspace.subscribe((state) => {
  const pend = useTabCloseGuard.getState().pending
  if (pend === null) return
  if (!state.tabs.some((t) => t.id === pend.tabId) || state.active !== pend.tabId) {
    clearTabCloseRequest()
  }
})

/** draft replace 换锚（保存成功后服务端删旧行建新行）—— 标签、聊天锁集合、待关闭
 *  请求一起迁。🔴 pending 先迁：store 提交会触发上面的 vanish 清理，后迁会被误清。 */
export function retargetObjectTab(kind: TabKind, oldTargetId: number, newTargetId: number): void {
  if (inert()) return
  const oldId = tabId(kind, oldTargetId)
  const newId = tabId(kind, newTargetId)
  const pend = useTabCloseGuard.getState().pending
  if (pend !== null && pend.tabId === oldId) {
    useTabCloseGuard.setState({ pending: { tabId: newId, kind, targetId: newTargetId } })
  }
  // 聊天锁集合按 tab id 键控 —— 跟着迁，否则换锚后重算 locked 丢聊天锁。
  if (chatActivity.delete(oldId)) chatActivity.add(newId)
  useTabWorkspace.getState().retargetTab(kind, oldTargetId, newTargetId)
  recomputeObjectTabLock(kind, newTargetId)
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

// ── locked：两个来源 + draft 快照 dirty ─────────────────────────────────────
//
// ① compose 打开且指向该邮件标签（compose store 订阅驱动，open/close 都重算）；
// ② 本标签的对象在 AI 抽屉里发过消息（AgentConversation 的 send 路径上报）；
// ③ 标签快照 **dirty**（写了一半没保存 —— 未保存现场不许被 LRU 淘汰）。
//    🔴 check 波3 续改拍板：判据从「快照在场」收紧到 dirty-only —— 保存过的草稿快照
//    恒在场（携带 lastSavedAtMs / draftRowId 锚），按在场判会让这类标签永久 locked
//    且跨重启，攒满上限后 openTab 恒 rejected。clean 快照标签参与 LRU，被淘汰时
//    快照随标签消亡（草稿已在服务端，重开走 detail 拉取）。
//
// ② 是会话级内存集合：重启后 locked 位本身随标签持久化恢复，模块加载时把
// 「locked 且无 draft」的标签回灌进集合 —— 否则重启后第一次 compose open/close
// 重算会把上一会话聊出来的锁误清掉。快照在场时锁**不可归因**（可能来自聊天，也可能
// 是旧版「在场即锁」写下的），不进集合 —— 归因给聊天会让 clean 快照标签永久锁死，
// 正是本次要收掉的形态；代价是「聊过 + clean 快照」的锁不跨重启，接受。

const chatActivity = new Set<string>()

for (const tab of useTabWorkspace.getState().tabs) {
  if (tab.locked && tab.draft === undefined) chatActivity.add(tab.id)
}

// 启动归一：存量档案按旧判据写下的「locked 但快照 clean」主动放平 —— 不放平的话，
// 这些标签要等到某次涉及它的 recompute 才解锁，LRU 满拒在老库上会继续复现。
//
// 🔴 这一段**不能**挂 tabsInert()：它跑在模块求值期，而两个模式 flag 由 renderer/main.tsx
// 在**全部静态 import 求值之后**才 boot（本模块经 router → GlobalShortcuts → tab-commands
// 进了 App 的静态图），此刻读恒为 false。之所以可以不管：归一写回的是「按当前存档算出来的
// 同一份标签集」，主窗自己 boot 时也会跑同一遍，内容零差异（且触发条件是 clean 快照 + locked
// 这种存量形态，正常档案根本不进这个分支）。
for (const tab of useTabWorkspace.getState().tabs) {
  if (tab.locked && !chatActivity.has(tab.id) && !draftSnapshotDirty(tab.draft)) {
    useTabWorkspace.getState().updateTab(tab.id, { locked: false })
  }
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
    composeLocksTarget(kind, targetId) || chatActivity.has(tab.id) || draftSnapshotDirty(tab.draft)
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

/** 09-02 —— dock 会话 → 对象标签（email / matter）的绑定。AssistantChatModal 在
 *  `chat.activeSessionId` **变化**时调，标签是这场对话**所属**的那个（不一定是此刻激活的）：
 *  换会话 / 首发拿到真 id → 写；新建会话（null）→ 清。标签不在（已关 / 无对象标签）→ no-op。
 *  同值不写（updateTab 每次都落 localStorage）。 */
export function bindTabChatSession(tabId: TabId | null, sessionId: number | null): void {
  if (inert() || tabId === null) return
  const ws = useTabWorkspace.getState()
  const tab = ws.tabs.find((t) => t.id === tabId) ?? null
  if (tab === null || (tab.chatSessionId ?? null) === sessionId) return
  ws.updateTab(tab.id, { chatSessionId: sessionId ?? undefined })
}

// 抽屉开合 → 记到当前激活的对象标签上。
useAIChatPanel.subscribe((state, prev) => {
  if (inert()) return
  if (state.visible === prev.visible) return
  const ws = useTabWorkspace.getState()
  const tab = selectActiveTab(ws)
  if (tab === null || tab.drawerOpen === state.visible) return
  ws.updateTab(tab.id, { drawerOpen: state.visible })
})

/** 测试用复位 —— 模块级集合与待关闭请求跨用例存活。 */
export function _resetTabBridgeForTest(): void {
  chatActivity.clear()
  clearTabCloseRequest()
}
