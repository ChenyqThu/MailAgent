// V2.1 阶段 3 step 5 — production StreamSink（main-only，用 electron WebContents）。
//
// dispatcher 下沉 shared/chat 后，sink 仍是注入式抽象（StreamSink 纯类型在
// shared/chat/dispatcher）。本文件是桌面端的具体实现：把 dispatcher/harness yield
// 的每个 ChatStreamEnvelope 经 webContents.send('chat:stream') 推给 renderer。
// 3c 远程对应进程内 emitter（React 同进程订阅，不经 IPC）。

import type { WebContents } from 'electron'

import type { StreamSink } from '@shared/chat/dispatcher'
import type { ChatStreamEnvelope } from '@shared/chat/types'

/** Concrete sink used in production — wraps `webContents.send` with a
 *  TOCTOU-safe try/catch (Sprint 4 review codex M-3): a window destroyed
 *  between `isDestroyed()` and `send()` would throw out of the dispatch
 *  loop and abort the entire run; swallowing the throw keeps the DB
 *  writes finishing even though the renderer is gone. */
export function makeWebContentsSink(webContents: WebContents): StreamSink {
  return {
    send(envelope: ChatStreamEnvelope): void {
      if (webContents.isDestroyed()) return
      try {
        webContents.send('chat:stream', envelope)
      } catch {
        // Renderer-side IPC destroyed mid-tick — DB persistence keeps going.
      }
    }
  }
}
