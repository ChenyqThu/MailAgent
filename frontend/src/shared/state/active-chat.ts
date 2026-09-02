// 激活的 AI Chat 会话标签（09-02 对话域拆分：`chats` 升对象域，一个会话 = 一个标签）。
// 与 active-email / matterWorkspaceStore 同性质 —— 标签 store 的「当前 targetId」投影，
// 详情区按它单挂载（切标签 = 换 key 重挂）。
//
// 两个投影字段，分开是因为首发换锚：
//   - `activeChatTargetId`：激活的 chat 标签的 targetId（真 session id > 0 / 临时负 id / null）。
//     左列高亮与「这个标签指着哪个会话」读它，换锚时跟着换成真 id。
//   - `mountKey`：详情区的挂载身份（宿主的 `key=`）。切标签时跟着 targetId 走；**换锚不变** ——
//     换锚发生在第一条消息正在流式输出的当口，key 若跟着从临时负 id 换成真 id，正在输出的
//     会话会被卸载重挂。
//
// 临时 id：新会话在发出第一条之前没有 session id，先拿一个**递减负数**当 targetId 开标签，
// 首发 adoptSession 拿到真 id 后 `adoptChatSession` 换锚（标题 / 草稿 / 位置 / 锁定全保留）。
// 负数不与任何真 session id 相撞，且 `parseTab` 会把负 id 标签挡在重启恢复之外。
//
// 🔴 popout / 轻窗不渲染标签条（tab-workspace 头注）：那里 openChatTab 退回纯本地投影，
// 绝不写标签 store（会覆盖主窗的持久化标签集）；反向订阅同样短路。

// 引 i18next 单例而不是 `@shared/i18n`：后者顶层拉 react-i18next，会把 mock 了
// react-i18next 的无关测试连坐（同 tab-workspace-bridge 头注的理由）。
import i18next from 'i18next'
import { create } from 'zustand'

import { selectActiveTargetId, useTabWorkspace } from './tab-workspace'
import {
  clearObjectTabDraft,
  getObjectTab,
  openObjectTab,
  retargetObjectTab,
  saveObjectTabDraft,
  tabsInert
} from './tab-workspace-bridge'

/** 会话内递减（不需要跨重启单调：负 id 标签根本不恢复）。 */
let lastTempChatId = 0

export function nextTempChatId(): number {
  lastTempChatId -= 1
  return lastTempChatId
}

interface ActiveChatStore {
  /** 当前详情区挂着的会话 targetId：真 session id（>0）/ 临时负 id / null（没有 chat 标签）。 */
  activeChatTargetId: number | null
  /** 详情区的挂载身份（见文件头）。null 时详情区不挂宿主。 */
  mountKey: number | null
}

export const useActiveChat = create<ActiveChatStore>(() => {
  // 冷启动初值 = 恢复的标签集里激活的那个会话（tab-workspace 在模块 init 时已 hydrate）。
  const initial = selectActiveTargetId(useTabWorkspace.getState(), 'chat')
  return { activeChatTargetId: initial, mountKey: initial }
})

/** 点会话行 / 通知深链 / 全屏跳转 —— 开（或激活）一个会话标签。
 *  先落本地再转发：转发引起的标签 store 提交会触发下方订阅，此刻投影值已相等 → 订阅不覆写。
 *  标签满且全 locked 被拒（toast 已出）→ 回滚本地投影，否则详情区与标签条高亮劈叉。 */
export function openChatTab(sessionId: number, title?: string): void {
  const prev = useActiveChat.getState()
  useActiveChat.setState({ activeChatTargetId: sessionId, mountKey: sessionId })
  if (!openObjectTab('chat', sessionId, title)) useActiveChat.setState(prev)
}

/** 「开一个新会话标签」的单源 —— ⌘O 与原生菜单「AI → General Agent」共用（两处各抄一份
 *  就会出现「菜单落上次的会话、快捷键开新标签」这种分叉，08-27 那版正是为此把动作收敛的）。 */
export function openNewChatTab(): void {
  openChatTab(nextTempChatId(), i18next.isInitialized ? i18next.t('chat.tabs.newChat') : '')
}

/** 首发换锚：临时负 id → 真 session id。标签走 bridge 的 `retargetObjectTab`（身份延续：
 *  标题 / 草稿 / 位置 / 锁定 / lastActiveAt 全保留，popout 与轻窗在那里 no-op）。
 *  投影先换、再提交 store：订阅读到 projected === 本地值即不动 mountKey（首发不重挂）。
 *  宿主已被切走时投影不是它，只换标签 —— 换锚由 ensureSession 的 `.then(adopt)` 驱动，
 *  不依赖宿主还活着。 */
export function adoptChatSession(tempId: number, realId: number): void {
  if (tempId === realId) return
  if (useActiveChat.getState().activeChatTargetId === tempId) {
    useActiveChat.setState({ activeChatTargetId: realId })
  }
  retargetObjectTab('chat', tempId, realId)
}

/** 标签上的 composer 草稿（`draft.text`）。没有 / 形状不对 → ''。 */
export function readChatTabDraft(targetId: number): string {
  const text = getObjectTab('chat', targetId)?.draft?.text
  return typeof text === 'string' ? text : ''
}

/** 切走 / 卸载时写一次草稿快照（updateTab 每次落 localStorage，不逐键写）。
 *  空串 = 清除；同值不写。 */
export function saveChatTabDraft(targetId: number, text: string): void {
  if (text === '') {
    clearObjectTabDraft('chat', targetId)
    return
  }
  if (readChatTabDraft(targetId) === text) return
  saveObjectTabDraft('chat', targetId, { text })
}

// 标签 store → 投影（响应式反向同步）。只对「激活 chat 目标**变化**」动作 —— 无关的标签
// 提交（updateTab 之类）不会碰投影。projected 与本地已相等的那次（openChatTab / adoptChatSession
// 自己引起的提交）也跳过，mountKey 才不会在换锚时被翻掉。
useTabWorkspace.subscribe((state, prev) => {
  if (tabsInert()) return
  const projected = selectActiveTargetId(state, 'chat')
  if (projected === selectActiveTargetId(prev, 'chat')) return
  if (projected === useActiveChat.getState().activeChatTargetId) return
  useActiveChat.setState({ activeChatTargetId: projected, mountKey: projected })
})
