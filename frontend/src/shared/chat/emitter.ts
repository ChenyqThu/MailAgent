// V2.1 阶段 3 — 3c-2：进程内 chat 流式事件 emitter。
//
// cutover 后（B-pure-unified）chat dispatcher 在 UI 进程跑（本地 renderer / 远程
// browser），sink 不再是 electron `webContents.send`（跨进程 IPC），而是本 emitter
// （同进程）：dispatcher 的 `StreamSink.send(envelope)` → `emitter.emit` → React
// （useEmailChat 经 `ChatApi.onStream` 订阅）同步收到。零 IPC 往返、零序列化。
//
// 🔴 不变式 1：零 Electron import（pnpm build:web 验）。纯 `Set<handler>` + 同步 emit。

import type { ChatStreamEnvelope } from './types'

export type ChatStreamHandler = (envelope: ChatStreamEnvelope) => void

/** Synchronous in-process fan-out for chat stream envelopes. One emitter per
 *  ChatRuntime (constructed eagerly so `onStream` can be subscribed before the
 *  first `start`). */
export class ChatStreamEmitter {
  private readonly handlers = new Set<ChatStreamHandler>()

  /** Subscribe. Returns an unsubscribe fn (idempotent — double-call safe,
   *  mirrors the ElectronApi.onStream disposer contract). */
  subscribe(handler: ChatStreamHandler): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  /** Fan out one envelope to every subscriber. Iterates a snapshot so a handler
   *  that (un)subscribes mid-emit doesn't perturb this pass; a throwing handler
   *  is isolated (logged, not propagated) so one bad subscriber can't break the
   *  dispatcher's forward() loop or sibling handlers. */
  emit(envelope: ChatStreamEnvelope): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(envelope)
      } catch (err) {
        console.warn('[chat] stream handler threw (isolated)', err)
      }
    }
  }

  /** Diagnostic / test-only — current subscriber count. */
  size(): number {
    return this.handlers.size
  }
}
