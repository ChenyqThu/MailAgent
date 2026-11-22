// Extracted from ai_gateway_lifecycle.ts — serialized post-turn chain, auto-compact coordinator, and queued input dispatch.

import { chatMessageToUIMessage } from '@shared/assistant/uiMessage'
import { resolveContextWindow } from '@shared/modelCatalog/contextWindow'
import type { ActiveRunRegistry } from '../../../ai-gateway/activeRuns'
import type { ApprovalRunStash } from '../../../ai-gateway/approvalStash'
import {
  CompactCoordinator,
  shouldAutoCompact,
  type CompactPersistence
} from '../../../ai-gateway/compact'
import type { AiGatewayConfig, PersistTurnInput } from '../../../ai-gateway/config'
import { parseProviderRef, type ProviderModelResolver } from '../../../ai-gateway/providerRef'
import {
  INTERRUPT_IDLE_WAIT_LIMIT_MS,
  runQueuedInputDispatch
} from '../../../ai-gateway/queuedInputDispatch'
import {
  claimQueuedInput,
  getSession,
  listDispatchableQueuedInput,
  listMessages,
  restoreClaimedForSession,
  revertClaimed
} from '../chat_db'
import { broadcastChatEvent } from './persistenceGlue'

export function wirePostTurnAndQueuedInput(deps: {
  gatewayConfig: AiGatewayConfig
  compactEnabled: boolean
  autoCompactFeatureEnabled: boolean
  queuedInputEnabled: boolean
  compactPersistence?: CompactPersistence
  providerModelResolver?: ProviderModelResolver
  activeRuns: ActiveRunRegistry
  approvalStash?: ApprovalRunStash
  resolveAutoCompactEnabled: () => Promise<boolean>
  getGatewayPort: () => number
}): ((sessionId: number) => void) | undefined {
  let onChatRunSettled: ((sessionId: number) => void) | undefined

  const postTurnChains = new Map<number, Promise<void>>()
  const chainPostTurn = (sessionId: number, task: () => Promise<void>): void => {
    // P5 dispatch must remain after P4 compact. Future P6+ post-turn actions must use this chain.
    const previous = postTurnChains.get(sessionId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    const chained = next.finally(() => {
      if (postTurnChains.get(sessionId) === chained) postTurnChains.delete(sessionId)
    })
    postTurnChains.set(sessionId, chained)
  }

  let compactCoordinator: CompactCoordinator | null = null
  if (deps.compactPersistence && deps.autoCompactFeatureEnabled) {
    const coordinator = new CompactCoordinator(deps.gatewayConfig, deps.compactPersistence)
    compactCoordinator = coordinator
    deps.gatewayConfig.compactCoordinator = coordinator
    deps.gatewayConfig.resolveAutoCompactEnabled = deps.resolveAutoCompactEnabled
    deps.gatewayConfig.maybeAutoCompact = (turn: PersistTurnInput): void => {
      setTimeout(() => {
        if (turn.sessionId == null) return
        chainPostTurn(turn.sessionId, async () => {
          if (turn.sessionId == null) return
          const settingEnabled = await deps.resolveAutoCompactEnabled()
          let contextWindow: number | null = null
          try {
            if (deps.providerModelResolver) {
              contextWindow =
                (await deps.providerModelResolver.resolve(turn.model)).contextWindow ?? null
            } else {
              const ref = parseProviderRef(turn.model)
              contextWindow = resolveContextWindow({
                providerId: ref.providerId,
                modelId: ref.modelId,
                protocol: turn.protocol ?? null,
                snapshotModel: null
              })
            }
          } catch (err) {
            console.warn('[ai-gateway] auto-compact context window resolution failed', err)
          }
          if (
            !shouldAutoCompact({
              p3Enabled: deps.compactEnabled,
              settingEnabled,
              contextTokens: turn.contextTokens,
              contextWindow,
              runActive: deps.activeRuns.hasActive(turn.sessionId),
              compactActive: coordinator.hasActive(turn.sessionId)
            })
          ) {
            return
          }
          try {
            const result = await coordinator.run(turn.sessionId, {
              reason: 'threshold',
              contextWindow
            })
            if (result.status === 'completed') {
              deps.gatewayConfig.onCompactCompleted?.(turn.sessionId)
            }
          } catch (err) {
            console.warn('[ai-gateway] automatic compact skipped or failed', err)
          }
        })
      }, 0)
    }
  }

  if (deps.queuedInputEnabled) {
    const dispatchDeps = {
      hasActiveRun: (sessionId: number) => deps.activeRuns.hasActive(sessionId),
      compactActive: (sessionId: number) => compactCoordinator?.hasActive(sessionId) === true,
      listDispatchable: listDispatchableQueuedInput,
      claim: claimQueuedInput,
      revert: (ids: number[]) => {
        revertClaimed(ids)
      },
      listSessionUIMessages: (sessionId: number) =>
        listMessages(sessionId).map(chatMessageToUIMessage),
      getSessionModel: (sessionId: number) => getSession(sessionId)?.backend_model ?? null,
      postChat: async (body: unknown) => {
        const response = await fetch(`http://127.0.0.1:${deps.getGatewayPort()}/api/ai/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
        return {
          ok: response.ok,
          drain: async () => {
            await response.arrayBuffer()
          }
        }
      },
      broadcast: (sessionId: number) =>
        broadcastChatEvent('chat:queued-input-changed', { sessionId }),
      now: () => Date.now(),
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    }
    const scheduleDispatch = (sessionId: number): void => {
      setTimeout(
        () => chainPostTurn(sessionId, () => runQueuedInputDispatch(dispatchDeps, sessionId)),
        0
      )
    }
    // 一轮 run 终止 → 排队追问的收尾。挂在 ActiveRunRegistry.release() 上（chat 三条排干路径 /
    // resume / headless / 群调度器的唯一交汇处），不再挂 onFinish —— 后者漏掉 abort 与 drain 自己
    // 抛的那些终止，那条路上排队的追问会无限期躺在队列里。
    //
    // 🔴 审批暂停的那一轮也会释放租约（run 结束了，在等人），但它的队列语义是「等决定」：排着的
    // 追问不该趁这个空档发出去，已 claim 的行属于那一轮、resume 时会被 markSent。所以有待决审批
    // 时整个 settle 不做事。
    // 🔴 循环闸：走到这里还留着的 claimed 行 = 那一轮没能把它送出去，还给用户但落 'restored'
    // （不进 listDispatchable）。于是每行最多自动派发一次 —— 上游持续报错也只会是
    // 「queued → 试一次 → restored，停」，不会反复重发。
    onChatRunSettled = (sessionId: number): void => {
      if (deps.approvalStash?.peekBySession(sessionId) != null) return
      setTimeout(
        () =>
          chainPostTurn(sessionId, async () => {
            try {
              if (restoreClaimedForSession(sessionId) > 0) {
                broadcastChatEvent('chat:queued-input-changed', { sessionId })
              }
            } catch (err) {
              console.error('[ai-gateway] queued-input restore on run settle failed', err)
            }
            await runQueuedInputDispatch(dispatchDeps, sessionId)
          }),
        0
      )
    }
    deps.gatewayConfig.dispatchQueuedInputIfIdle = scheduleDispatch
    // Same per-session chain as the drain: an onFinish drain already queued ahead of this task
    // claims the row first and this dispatch then finds nothing — claim() is the only dedup gate.
    deps.gatewayConfig.dispatchQueuedInputInterrupt = (sessionId, id, revertIds): void => {
      setTimeout(
        () =>
          chainPostTurn(sessionId, () =>
            runQueuedInputDispatch(dispatchDeps, sessionId, {
              ids: [id],
              waitForIdleMs: INTERRUPT_IDLE_WAIT_LIMIT_MS,
              revertIds
            })
          ),
        0
      )
    }
  }

  return onChatRunSettled
}
