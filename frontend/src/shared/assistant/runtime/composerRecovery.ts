// 0903 dogfood —— 「这一句话没送出去，交还给用户」的单向通道。
//
// 为什么要一条通道：认出拒绝的地方是 transport 的 fetch 包装（住在 useMailAgentAiSdkRuntime 里，
// 在 runtime provider **外面**），而 composer 只有 provider 里面拿得到（`useAui`）。两头都不能挪，
// 于是中间放一个按 sessionId 分格的极小 store：transport 发布，provider 里的桥消费一次。
//
// 🔴 只发布「转投队列也失败」的那一次。转投成功不发布 —— 那句话已经出现在排队条里，再塞回输入
// 框就成了两份，用户会以为要按两次。

type Listener = () => void

interface Recovery {
  /** 单调递增：同一段文本连续失败两次也算两次，桥据此判「这是新的一次」。 */
  nonce: number
  text: string
}

const bySession = new Map<number, Recovery>()
const listeners = new Map<number, Set<Listener>>()
let nextNonce = 1

function emit(sessionId: number): void {
  for (const listener of listeners.get(sessionId) ?? []) listener()
}

/** transport 侧：这一轮的文本交还给用户。 */
export function publishComposerRecovery(sessionId: number, text: string): void {
  bySession.set(sessionId, { nonce: nextNonce++, text })
  emit(sessionId)
}

/** 桥侧：订阅某个会话的交还事件（useSyncExternalStore 的 subscribe）。 */
export function subscribeComposerRecovery(sessionId: number, listener: Listener): () => void {
  const set = listeners.get(sessionId) ?? new Set<Listener>()
  set.add(listener)
  listeners.set(sessionId, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(sessionId)
  }
}

/** 桥侧：当前待交还的那一次（同一 nonce 恒返回同一个对象引用，useSyncExternalStore 要求）。 */
export function getComposerRecovery(sessionId: number): Recovery | null {
  return bySession.get(sessionId) ?? null
}

/** 桥侧：消费掉（写进 composer 之后调用），避免重挂载时又灌一次。 */
export function clearComposerRecovery(sessionId: number, nonce: number): void {
  if (bySession.get(sessionId)?.nonce !== nonce) return
  bySession.delete(sessionId)
  emit(sessionId)
}

/** 测试用：清空全部格子与订阅。 */
export function _resetComposerRecoveryForTest(): void {
  bySession.clear()
  listeners.clear()
  nextNonce = 1
}
