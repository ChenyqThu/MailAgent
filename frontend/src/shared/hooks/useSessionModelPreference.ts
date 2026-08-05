// W8 per-session 模型偏好（task 08-04 WP2）—— 两个 chat 面共用的模型 state 归宿。
//
// 改前：AiChatPanel 与 AgentConversation 各自 `useState(readModelPref())` + 各抄一份
// localStorage 常量，模型偏好是**全局一份**——在 A 会话切到 opus，打开 B 会话也变 opus，
// 关掉 app 再开还是 opus。`ai_chat_sessions.backend_model` 列 + chat_db.ts
// getOrCreateSession 的 refresh-on-touch 早就写好了，但调用链触达不到（renderer 只在建会话
// 时传一次 backendModel），是死代码。
//
// 改后（零 ALTER、零 CHAT_DB_VERSION bump）：
//   写 —— 选模型 = 立刻改本地 state（本轮就生效）+ 写全局 localStorage（**降级为「新会话的
//        默认值」**）+ 若当前已有会话行，best-effort PATCH 落到该行的 backend_model。
//   读 —— 切到某个已存在会话时，用该行的 backend_model 回填 composer；行还没加载
//        （sessionModel === undefined）就等，不拿全局默认去覆盖真值。
// 于是「切会话各自记得上次所选模型」+「重启 app 仍在」都成立，且远程 web 与桌面共用同一
// serve-api，不再各持一份 localStorage。

import { useCallback, useEffect, useRef, useState } from 'react'

/** 全局模型偏好（跨会话共享的**默认值**，不再是「当前模型」的权威）。两个面共用同一 key。 */
export const CUSTOM_MODEL_PREF = 'mailagent.chat.customModel'
export const DEFAULT_CUSTOM_MODEL = 'claude-sonnet-4-6'

export function readGlobalModelPref(): string {
  try {
    return localStorage.getItem(CUSTOM_MODEL_PREF) || DEFAULT_CUSTOM_MODEL
  } catch {
    return DEFAULT_CUSTOM_MODEL
  }
}

export function writeGlobalModelPref(model: string): void {
  try {
    localStorage.setItem(CUSTOM_MODEL_PREF, model)
  } catch {
    /* best-effort — pref persistence 失败不该影响本轮发送 */
  }
}

export interface SessionModelPreference {
  /** 当前生效的模型 providerRef（发给 gateway 的值）。 */
  model: string
  /** 用户在 composer 里选了一个模型：本地生效 + 全局默认 + 落当前会话行。 */
  selectModel: (model: string) => void
}

export function useSessionModelPreference({
  sessionId,
  sessionModel,
  persist
}: {
  /** 当前活跃会话 id；null = 还没落地的新对话。 */
  sessionId: number | null
  /** 该会话行的 backend_model。🔴 三态有区别：
   *  `undefined` = 行还没加载（**别**回填，等）；`null`/'' = 行在但没存过模型（保持现值）；
   *  字符串 = 权威值，回填进 composer。 */
  sessionModel: string | null | undefined
  /** 落库（best-effort，不抛）。面里通常是 `mailApi.chat.updateSessionModel`。 */
  persist: (sessionId: number, model: string) => void
}): SessionModelPreference {
  const [model, setModel] = useState(readGlobalModelPref)
  // 「这个 sessionId 的回填已经判过了」——防止我们自己刚 selectModel 完，稍后 sessions 列表
  // 刷新带回旧 backend_model 时又把用户的选择顶回去。
  const resolvedForRef = useRef<number | null | undefined>(undefined)
  // 🔴 本次挂载内**已落库**的选择（sessionId → model）。落库是 fire-and-forget 且不失效
  // sessions 缓存（`chat.sessions` 是 useEmailChat 的本地 state，切会话不重拉），所以
  // 「在 A 选 opus → 切到 B → 切回 A」时 sessionModel 仍是**旧**值：只有 resolvedForRef
  // 这一道闸时，切回来会被 stale 列表把用户刚选的模型顶回去（DB 里其实已经是新值）。
  // 这份 map 让回填优先认自己刚写下的值；下次真刷新回来两者一致，无副作用。
  const localPicksRef = useRef<Map<number, string>>(new Map())

  useEffect(() => {
    if (resolvedForRef.current === sessionId) return
    const localPick = sessionId !== null ? localPicksRef.current.get(sessionId) : undefined
    // 已有会话、本挂载内没在它上面选过、行也还没到 → 什么都不做（等 sessionModel 变已知再判）。
    if (localPick === undefined && sessionId !== null && sessionModel === undefined) return
    resolvedForRef.current = sessionId
    // 本地已选值优先于（可能陈旧的）列表值；新对话（sessionId=null）两者都没有 → 保持现值。
    const next = localPick ?? (sessionId !== null ? sessionModel : null)
    // 会话切换是外部信号，不是可派生值：composer 的 model 在切换后仍可被用户改，故必须是
    // state 而非 derived；一次切换只回填一次（resolvedForRef 守门）。若日后 react-hooks/
    // set-state-in-effect 重新盯上这里，是**加回 disable 注释**而不是改成 derived。
    if (next) setModel(next)
  }, [sessionId, sessionModel])

  const selectModel = useCallback(
    (next: string): void => {
      writeGlobalModelPref(next)
      setModel(next)
      if (sessionId !== null) {
        localPicksRef.current.set(sessionId, next)
        persist(sessionId, next)
      }
    },
    [sessionId, persist]
  )

  return { model, selectModel }
}
