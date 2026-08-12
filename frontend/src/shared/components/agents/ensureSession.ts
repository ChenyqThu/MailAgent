// onEnsureSession 的**线程身份**闸（0812 codex #1）。
//
// 懒建会话（第一次发送）是异步的，而在它落地之前，用户完全可能已经点到**另一件事**或换了会话。
// 此前的去重只有一个「有没有在途」的 ref，于是事项 A 的在途创建会被事项 B 的调用复用，产生两种
// 全都很坏的结局：
//   ① transport 拿 A 的 session 去持久化带 B 上下文的消息；
//   ② 最刺眼的一种：A 的 `.then(adopt)` 最后落地时把界面**从 B 强行切回 A**。
// 故去重键必须是**线程身份**，且落地前要再核一次。
// （当年还有第三种：事项检索范围切换的「审计先行」会把 B 的审计写进 A 的会话 —— 那个第二调用方
// 已随 0812 检索范围开关的移除一并退役，本闸对剩下这条路照样成立。）
//
// 住在独立叶子而不是 AgentConversation.tsx 里：那是组件文件，只许导出组件
// （react-refresh/only-export-components），且这段纯逻辑单测起来也不该拖上整棵 assistant-ui 树。

import type { ChatSession } from '@shared/api/types'

export interface ChatThreadIdentity {
  /** 换会话 / 新对话（useGeneralChat.navEpoch）。 */
  navEpoch: number
  /** 事项锚点的内部 id；null = 通用对话。 */
  anchorId: number | null
}

/** 会话建好时线程已经切走 —— 调用方按失败处理（范围切换保留原档、发送报错），下轮重来。 */
export const E_CHAT_THREAD_CHANGED = 'E_CHAT_THREAD_CHANGED'

function sameThreadIdentity(a: ChatThreadIdentity, b: ChatThreadIdentity): boolean {
  return a.navEpoch === b.navEpoch && a.anchorId === b.anchorId
}

export interface EnsureSessionDeps {
  /** 已有 session id（非 null 直接短路 —— 幂等的第一道）。 */
  getExistingSessionId: () => number | null
  /** 现读线程身份（**每次**都现读：异步期间它会变）。 */
  getIdentity: () => ChatThreadIdentity
  createSession: (identity: ChatThreadIdentity) => Promise<ChatSession>
  /** 落地进 hook 状态。切走后**绝不**调用（会把界面从 B 拽回 A）。 */
  adopt: (session: ChatSession) => void
}

export function createEnsureSession(deps: EnsureSessionDeps): () => Promise<number> {
  let inflight: { promise: Promise<number>; identity: ChatThreadIdentity } | null = null
  return async (): Promise<number> => {
    const existing = deps.getExistingSessionId()
    if (existing !== null) return existing
    const identity = deps.getIdentity()
    // 只有**同一条线程**的在途创建可以复用。
    if (inflight !== null && sameThreadIdentity(inflight.identity, identity))
      return inflight.promise
    const promise = deps.createSession(identity).then((session) => {
      const now = deps.getIdentity()
      if (!sameThreadIdentity(now, identity)) {
        // 这条会话行留在服务端（空行、不进历史列表 —— listAllSessions 只收有消息的），但绝不
        // adopt、也绝不把它的 id 交出去当"当前会话"。
        throw Object.assign(new Error('chat thread changed while creating its session'), {
          code: E_CHAT_THREAD_CHANGED
        })
      }
      deps.adopt(session)
      return session.id
    })
    const entry = { promise, identity }
    inflight = entry
    const settle = (): void => {
      if (inflight === entry) inflight = null
    }
    // 两支都接住 —— 直接 `.finally()` 会派生出一个无人处理的 rejected promise。
    promise.then(settle, settle)
    return promise
  }
}
