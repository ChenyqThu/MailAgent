// 0813 轮4批AG —— 「这场对话当前所在的是什么」的**单值**判定。
//
// owner dogfood 报的 bug：从邮件详情进到事项页、再点「对话」，chip 行里同时冒出 matter chip（对的）
// 和**上一封邮件**的 chip（多余的）。
//
// 🔴 根因不是「谁忘了清谁」，而是两个来源各自都在种 chip：
//   · 事项种子 `matterTarget` —— 用户在事项页点「对话」，是一次**显式声明**「这场对话是关于这件事的」；
//   · 邮件种子 `activeInternalId` —— **环境态**：`shared/state/active-email.ts` 的文件头写明它
//     persist 到 localStorage、切邮箱**不会**自动复位，它的语义是「我最后点过的那一行」而不是
//     「我现在正在看的东西」。进事项页时它当然还在（EmailDetail 恢复、J/K 导航都靠它）。
//
// 所以修的是**判据**不是那份全局状态：清 `activeInternalId` 会打断 EmailDetail 恢复 / J-K / EmailList
// 的 active-reset（`useActiveEmail` 有十余个消费者）。
//
// 判定顺序**不是**「matter 碰巧排在前面」，而是一条能写出来的原则：
//   **环境态永远不能盖过显式声明。**
// 于是：
//   1. `sessionMatter` —— 历史里选中的事项会话，会话行自己的 anchor，最硬的真相；
//   2. `sessionMatterUnresolved` —— 是事项会话但公共编号没拿到。**单独一档**，绝不折进 `none`：
//      `none` 的语义是「普通对话」，而 AgentConversation 对这一档的既有红线正是「绝不降级成普通
//      会话」（见 AgentConversationGuards #2）。折进去之后，将来谁给 `none` 加一句「回落到邮件」
//      就会静默违反那条红线；
//   3. `matterSeed` —— dock 以「事项对话 / 立即跟进」唤出时带的那件事（显式声明）；
//   4. `activeEmailId` —— 前三者都不在时，它才是「当前所在的东西」。
//
// 「既在邮件又在事项」怎么办：**入口自己声明**，本函数不猜。
//   · 邮件工具栏「创建事项」→ `startChatWithPrompt` 已经先 `clearMatterChat()`（该函数注释原文
//     「这是一次通用请求」）⇒ 落到第 4 档，邮件 chip 照常，行为不变。这条既有的**反方向**收口正是
//     本判据的先例 —— 本批只是把另一半补上。
//   · 事项页「立即跟进」→ `startMatterChatWithPrompt` 有意**不**清事项 ⇒ 落到第 3 档。
//   · 真要在事项对话里引一封邮件 → 走 `@` 提及（显式动作，与本判据正交，一个字节没动）。

import type { MatterChatTarget } from '@shared/state/ai-chat-panel'

/** 一场对话默认带的上下文来源。**互斥单值** —— 这正是本类型存在的意义。 */
export type ConversationContextSource =
  | { kind: 'matter'; target: MatterChatTarget }
  /** 是事项对话，但公共编号还没拿到（整个事项绑定退成惰性、sendDisabled 恒真）。 */
  | { kind: 'matter-unresolved' }
  | { kind: 'email'; emailId: number }
  | { kind: 'none' }

export function resolveConversationContextSource(input: {
  /** 会话行自己的事项身份（`anchor_type='matter'` 的历史会话）。 */
  sessionMatter: MatterChatTarget | null
  /** 是事项会话但 `matter_public_id` 没解析出来。 */
  sessionMatterUnresolved: boolean
  /** dock 唤出时带的事项种子（`initialMatterTarget`）。 */
  matterSeed: MatterChatTarget | null
  /** 环境态的活动邮件（`initialMentionEmailId` ← `useActiveEmail.activeInternalId`）。 */
  activeEmailId: number | null
}): ConversationContextSource {
  if (input.sessionMatter !== null) return { kind: 'matter', target: input.sessionMatter }
  if (input.sessionMatterUnresolved) return { kind: 'matter-unresolved' }
  if (input.matterSeed !== null) return { kind: 'matter', target: input.matterSeed }
  if (input.activeEmailId !== null) return { kind: 'email', emailId: input.activeEmailId }
  return { kind: 'none' }
}

/** 本场对话**会不会**产出邮件 chip 的唯一判据。
 *
 *  🔴 两个消费点必须用同一个值：① 种 chip 的 effect；② 待发指令的「本宿主给不出那封邮件的引用
 *  ⇒ 当场消费成只预填」那道闸。只改①会让②在事项对话里拿着原始 prop 判成「宿主就是那封邮件」，
 *  于是永远等一枚再也不会出现的 chip —— 那正是 codex #3「决不把待发指令悬在那里」禁止的形态。 */
export function seededEmailIdOf(source: ConversationContextSource): number | null {
  return source.kind === 'email' ? source.emailId : null
}
