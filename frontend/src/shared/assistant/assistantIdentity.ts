// 0813 主 agent 身份 —— renderer 侧只读 store（owner_settings `assistant_identity` 的投影）。
//
// 为什么不是 react-query：消费点是 TurnPresence（每条进行中回合的消息树内）与
// AiChatPanel 标题 —— 它们挂在多种宿主里（桌面面板 / popout / 远程 web / 大量组件测试），
// 不能假设树上有 QueryClientProvider。抄 globalApprovalMode 的模块级 store +
// useSyncExternalStore 惯用法的**轻量版**：显示型数据（名字/头像），读失败静默用默认值
// （与 approval-mode 的「不许伪装」纪律相反 —— 那是安全档，这只是称呼），TTL 内不重取。
//
// 写侧只有 `components/agents/settings/MainAssistantSettings.tsx`（PUT 后
// primeAssistantIdentity 立即广播，不等 TTL）。

import { useEffect, useSyncExternalStore } from 'react'

import type { AssistantIdentity, ChatApi } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'

export const DEFAULT_ASSISTANT_IDENTITY: AssistantIdentity = { name: null, avatar: null }

/** 显示型数据的复取节流：设置页改完经 primeAssistantIdentity 即时广播，TTL 只兜跨端漂移 */
const IDENTITY_TTL_MS = 60_000

let cached: AssistantIdentity | null = null
let fetchedAt = 0
let inFlight = false
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return (): void => {
    listeners.delete(listener)
  }
}

function snapshot(): AssistantIdentity | null {
  return cached
}

function maybeFetch(chat: ChatApi | undefined): void {
  // 测试/降级宿主的 api mock 可能没有该方法 —— 显示型数据静默用默认值即可
  if (typeof chat?.getAssistantIdentity !== 'function') return
  if (inFlight || Date.now() - fetchedAt < IDENTITY_TTL_MS) return
  inFlight = true
  chat
    .getAssistantIdentity()
    .then((identity) => {
      cached = identity
      fetchedAt = Date.now()
      notify()
    })
    .catch(() => {
      // 读失败：保留上次值（或默认），下次挂载 TTL 过后重试
      fetchedAt = Date.now()
    })
    .finally(() => {
      inFlight = false
    })
}

/** 写侧回写：PUT 成功后用服务端 canonical 值即时广播（设置页 → 所有消费点同帧收敛） */
export function primeAssistantIdentity(identity: AssistantIdentity): void {
  cached = identity
  fetchedAt = Date.now()
  notify()
}

/** 测试隔离：重置模块级缓存 */
export function __resetAssistantIdentity(): void {
  cached = null
  fetchedAt = 0
  inFlight = false
}

/** 主 agent 身份（名字 + 头像）；未取到/取失败 = 默认（name null → 文案用 "AI"、
 *  标题用 i18n chat.title；avatar null → 官方形象）。 */
export function useAssistantIdentity(): AssistantIdentity {
  const api = useMailApi()
  useEffect(() => {
    maybeFetch(api.chat)
  }, [api])
  return useSyncExternalStore(subscribe, snapshot) ?? DEFAULT_ASSISTANT_IDENTITY
}
