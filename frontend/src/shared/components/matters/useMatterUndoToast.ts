/**
 * G-33 —— UI 直接操作的「结果 toast + 撤销」。
 *
 * 设计 §2.23 那张表把归档 / 移到回收站 / 取消关联 / 关联资料都写成「toast 带撤销」。此前撤销
 * 只活在 chat 写工具的回执卡上（`useMatterUndoRunner`），用户在界面上点的那些一律没有。
 *
 * 🔴 **只接真正可逆的操作**。判据不是"看起来能反过来"，而是两道硬闸叠在一起：
 *   ① 服务端这次写入返回了 `undo` descriptor（`service.py::_undo_descriptor`）；
 *   ② 本客户端的 tool→REST 表认得它（`resolveMatterUndoRequest`）。
 * 两道都在 `readMatterUndoDescriptor` 里，任一不成立就**不渲染撤销按钮** —— 界面上不出现
 * 「点了才知道做不到」的按钮，比补一个假撤销诚实。接受提案、删除标签这类后端没有反向语义
 * 的操作因此天然拿不到按钮，toast 只报结果。
 *
 * 与 `useMatterUndoRunner`（chat 回执卡）的关系：**共用同一条执行通道**（renderer 直发 REST、
 * 不过模型、带 expected_version + reverses_event_id），只是承载 UI 不同 —— 那边是卡片上的常驻
 * 按钮 + 三态，这边是 toast 上的一次性按钮。不共用一个 hook 的原因是状态机不同：toast 点完
 * 就消失，没有 busy/done 可展示，也就不需要那套跨会话竞态腰带。
 */

import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { readMatterUndoDescriptor } from '@shared/api/matters'
import { errorMessage } from '@shared/lib/ipcErrors'
import { toastError, useToastStore } from '@shared/state/toast'

import { useMatterChatApi } from './hooks'
import { refreshMatter } from './matterMutation'
import { MATTER_UNDO_REASON } from './useMatterUndoRunner'

/** 带撤销按钮的 toast 停留时长。默认 3s 对「读完一句话再决定要不要撤销」明显不够。 */
export const MATTER_UNDO_TOAST_TTL_MS = 8_000

export interface MatterUndoToastPusher {
  /**
   * 推一条写操作结果 toast；`result` 里带得出可执行的 undo descriptor 时才附「撤销」。
   *
   * @param title    已翻译好的结果文案（设计 §2.23 的那一句）
   * @param result   写操作的返回（`MatterMutationResult`，服务端恒带 `undo` 键）
   * @param matterId 撤销成功后要失效的事项（撤销落在服务端，缓存必须跟着走）
   */
  (title: string, result: unknown, matterId: string | null): void
}

export function useMatterUndoToast(): MatterUndoToastPusher {
  const { t } = useTranslation()
  const chatApi = useMatterChatApi()
  const queryClient = useQueryClient()

  return useCallback(
    (title, result, matterId) => {
      const descriptor = readMatterUndoDescriptor(result)
      if (descriptor === null) {
        useToastStore.getState().push({ variant: 'success', title })
        return
      }
      // 连点两下不会发两次反向写入：`Toast.tsx` 的按钮自带 `actionFiredRef` 单次闸，
      // 点完还会 `onDismiss()`，故这里不用再自己关。
      useToastStore.getState().push({
        variant: 'success',
        title,
        ttlMs: MATTER_UNDO_TOAST_TTL_MS,
        action: {
          label: t('matters.undo.action'),
          onClick: () => {
            void chatApi
              .applyUndo(descriptor, { reason: MATTER_UNDO_REASON })
              .then(() => refreshMatter(queryClient, matterId))
              .catch((error: unknown) => {
                // 版本冲突 = 撤销之后事项又被改过 —— 这恰恰是"盲目回滚"最不该发生的时刻，
                // 如实说，不重试（同 useMatterUndoRunner 的处置）。
                if ((error as { code?: string } | null)?.code === 'E_VERSION_CONFLICT') {
                  toastError(t('matters.chat.undo.conflict'))
                  return
                }
                toastError(t('matters.chat.undo.failed'), errorMessage(error))
              })
          }
        }
      })
    },
    [chatApi, queryClient, t]
  )
}
