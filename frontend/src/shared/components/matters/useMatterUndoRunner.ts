// Matters MVP P3 (lane ③) — the write-receipt undo runner (D9).
//
// 🔴 The undo is a renderer-direct REST call: no LLM in the loop, no new chat message. The model
// proposed the write and the user approved it once; asking the model to "undo it" would re-enter
// the same fallible loop, and the reverse operation is already fully described by the descriptor
// the write returned. So the receipt button executes it verbatim (fresh idempotency key,
// source='desktop_ui', reason=撤销, carrying expected_version + reverses_event_id from the
// descriptor so the reversal is optimistic-concurrency safe AND lands on the timeline).
//
// A stale `expected_version` (someone changed the matter after the write) surfaces as
// E_VERSION_CONFLICT and is reported as such rather than retried — "there were later changes" is
// exactly when a blind undo is the wrong thing to do.

import { useCallback, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import type { MatterUndoDescriptor } from '@shared/api/matters'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError } from '@shared/state/toast'

import { useMatterChatApi } from './hooks'
import type { MatterUndoState } from './matterChatContext'

/** D9 — the audit `reason` recorded on the reversing mutation. Frozen wording, never rendered. */
export const MATTER_UNDO_REASON = '撤销'

export interface MatterUndoRunner {
  undoStates: Readonly<Record<string, MatterUndoState>>
  runUndo(toolCallId: string, descriptor: MatterUndoDescriptor): void
  /** Drop every card's undo state (a fresh conversation must not inherit the previous one's). */
  resetUndoStates(): void
}

export function useMatterUndoRunner(publicId: string): MatterUndoRunner {
  const { t } = useTranslation()
  const chatApi = useMatterChatApi()
  const queryClient = useQueryClient()
  const [undoStates, setUndoStates] = useState<Record<string, MatterUndoState>>({})
  // 🔴 卡片状态的**权威**在 ref，state 只是它的渲染镜像。判据不能写成 setState 更新函数里的
  // 副作用（`let started` 那种写法）：React 只在该 fiber 没有待处理更新时才**同步**求值更新
  // 函数（eager state），否则更新函数要到下一次 render 才跑 —— 于是「有没有起跑」在发请求那
  // 一行恒为 false，卡片停在 busy、反向请求一次都发不出去。0812 实测到的正是这一幕：同一个
  // runner 在 renderHook 的极简宿主里走 eager 路径一切正常，挂进带 React Query 的完整事项绑
  // 定后就静默不发（更新函数按 React 契约本就允许被延迟/重复调用，不该承载副作用）。
  const statesRef = useRef<Record<string, MatterUndoState>>({})
  // 🔴 0812 codex修复批 — 跨会话/跨事项竞态腰带。resetUndoStates() 清空 statesRef 之后，仍在
  // 飞行中的旧 Promise 会在 settle 时把旧卡片状态写进**新 surface 共用的** statesRef：新会话若
  // 复用同一个 toolCallId，旧成功会把新卡片标成 done、旧失败会把正在执行的新撤销改回 idle
  // （busy 闸随之打开 → 允许重复提交）。三重判据，settle 只有**全部**匹配才准回写 UI：
  //   ① generation —— reset 递增；② 当前事项 —— hook 宿主可能不 reset 直接换 publicId；
  //   ③ 本次调用的 token —— 同一 toolCallId 的新旧两次调用互不冒认。
  // 缓存失效**不受**腰带管：服务端已真的执行了撤销，发起时捕获的那个事项的缓存无论界面切到
  // 哪里都已过期，照常失效。
  const generationRef = useRef(0)
  const publicIdRef = useRef(publicId)
  publicIdRef.current = publicId
  const inflightRef = useRef(new Map<string, symbol>())
  const writeState = useCallback((toolCallId: string, next: MatterUndoState): void => {
    statesRef.current = { ...statesRef.current, [toolCallId]: next }
    setUndoStates(statesRef.current)
  }, [])

  const runUndo = useCallback(
    (toolCallId: string, descriptor: MatterUndoDescriptor): void => {
      // A double click while the first call is in flight must not fire a second reversal (each
      // carries its own idempotency key, so the server would happily apply it twice).
      if ((statesRef.current[toolCallId] ?? 'idle') !== 'idle') return
      const generation = generationRef.current
      const capturedPublicId = publicId
      const token = Symbol(toolCallId)
      inflightRef.current.set(toolCallId, token)
      writeState(toolCallId, 'busy')
      const mayTouchUi = (): boolean =>
        generationRef.current === generation &&
        publicIdRef.current === capturedPublicId &&
        inflightRef.current.get(toolCallId) === token
      void chatApi
        .applyUndo(descriptor, { reason: MATTER_UNDO_REASON })
        .then(async () => {
          if (mayTouchUi()) {
            inflightRef.current.delete(toolCallId)
            writeState(toolCallId, 'done')
          }
          // 服务端已应用撤销 —— 无论 UI 归谁，发起时捕获的事项的缓存都必须失效。
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: qk.matters.list() }),
            queryClient.invalidateQueries({ queryKey: qk.matters.detail(capturedPublicId) })
          ])
        })
        .catch((error: unknown) => {
          // 过期 settle 连 toast 都不许发：那张卡片已经不在屏幕上，报错只会误导当前 surface。
          if (!mayTouchUi()) return
          inflightRef.current.delete(toolCallId)
          writeState(toolCallId, 'idle')
          if ((error as { code?: string } | null)?.code === 'E_VERSION_CONFLICT') {
            toastError(t('matters.chat.undo.conflict'))
            return
          }
          toastError(t('matters.chat.undo.failed'), errorMessage(error))
        })
    },
    [chatApi, publicId, queryClient, t, writeState]
  )

  const resetUndoStates = useCallback(() => {
    generationRef.current += 1
    inflightRef.current.clear()
    statesRef.current = {}
    setUndoStates(statesRef.current)
  }, [])

  return { undoStates, runUndo, resetUndoStates }
}
