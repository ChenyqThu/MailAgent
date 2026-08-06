// WP-14 — 阶段机的 **thread 作用域** 读法（composer 上方的运行状态条用）。
//
// `useTurnStage()` 只能在 message 作用域里调用（Empty slot / part renderer），因为它读的是
// `s.message.parts`。运行条住在 composer 旁边、在任何一条消息之外，所以它需要同一份判据、
// 另一个入口：`s.thread.messages` 末条 assistant 的 parts + status，喂给**同一个纯函数**
// `deriveTurnStage`。零 gateway 改动、零新状态通道 —— 这是 WP-14 的设计要求。
//
// 🔴 `parts` 在 thread 作用域是真实存在的、且与 message 作用域**同形**（每个 part 自带派生出来的
// `status`）：assistant-ui 的 `@assistant-ui/react/dist/client/ExternalThread.js` 里，每条消息的
// client state 是 `{ ...message, parts: partClients.state, ... }`。上游的 `ThreadMessage` **类型**
// 只声明 `content`（原始 part 数组，不带 `status`），所以这里必须显式收窄 —— 但读的是运行时真有
// 的那份投影，不是 `content`。（用 `content` 会静默丢掉 tool part 的 `status`，
// `deriveToolPhase` 少一个判据 → 「跑完的工具」被读成「还在跑」。）
//
// 与 message 作用域那条线的两处**有意差异**：
//   1. **不接 stall 看门狗**（stallLevel 恒 0）。`deriveTurnStage` 里 stall 压过一切 running 子态，
//      于是一个跑了 20s 的工具会把「正在联网搜索」盖成「仍在等待响应」—— 而运行条自己带回合秒表，
//      「还要等多久」这个问题它逐秒在答，代价却是丢掉更有信息量的工具名。消息流里的
//      `TurnStatusLine`（本包一个字节没动）继续负责 stall 升级。
//   2. 末条消息还不是 assistant 时（用户刚发出、assistant 消息尚未落地）用 thread 级 `isRunning`
//      兜底成 running/空 parts → `connecting`，而不是让运行条在回合最开始那一瞬闪一下。

import { useMemo } from 'react'
import { useAuiState } from '@assistant-ui/react'

import { deriveTurnStage, type TurnStagePart, type TurnStageResult } from './useTurnStage'

/** 上游 AuiState 里一条消息的**运行时**投影（见文件头：`parts` 有，类型里没有）。 */
interface ThreadMessageProjection {
  readonly role?: string
  readonly parts?: readonly TurnStagePart[]
  readonly status?: { readonly type?: string; readonly reason?: string }
}

const NO_PARTS: readonly TurnStagePart[] = []
/** 模块级常量 → useMemo 的依赖引用稳定（每次 render 新建对象会让 memo 恒失效）。 */
const RUNNING_STATUS = { type: 'running' } as const

/** thread 级的当前回合阶段。必须在 AssistantRuntimeProvider 之内调用（thread 作用域即可，
 *  不需要 message 作用域）。 */
export function useThreadTurnStage(): TurnStageResult {
  const messages = useAuiState((s) => s.thread.messages) as readonly ThreadMessageProjection[]
  const isRunning = useAuiState((s) => s.thread.isRunning)

  const tail = messages.length > 0 ? messages[messages.length - 1] : undefined
  const assistant = tail?.role === 'assistant' ? tail : undefined
  const parts = assistant?.parts ?? NO_PARTS
  const status = assistant?.status ?? (isRunning ? RUNNING_STATUS : undefined)

  return useMemo(() => deriveTurnStage({ parts, status, stallLevel: 0 }), [parts, status])
}
