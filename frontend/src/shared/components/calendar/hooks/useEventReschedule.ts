// Lane C (#5) — 拖拽落手之后的提交链，一条路走到底:
//
//   落手 → 本地乐观 override (10s) → calendar-undo push (5s commit-delay)
//        → 5s 到点才真发 PATCH /calendar/events/{uid}
//        → 撤销 = 清 override, 请求从未发出
//        → PATCH 失败 = 清 override (块弹回) + error toast
//
// 挂在 CalendarLayout 而不是各视图: 5s 窗口内用户完全可能切视图, 视图一卸载
// 那份 mutation 就没了 (删除流程的 F5 先例同理)。
//
// 周期实例恒走「改这一次」(detached override, recurrenceId = 该次原始 dtstart):
// 拖一个块改掉整条系列不是拖拽该有的语义, 「改整系列 / 改未来」留在编辑弹窗。

import { useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { useMailApi } from '@shared/hooks/useMailApi'
import { qk } from '@shared/lib/queryKeys'
import { useUndoToastStore } from '@shared/state/calendar-undo'
import { useCalendarTimeOverrides } from '@shared/state/calendar-time-override'
import { toastError, toastSuccess } from '@shared/state/toast'
import type { CalendarEventOccurrence, EventUpdateOpts } from '@shared/api/types'

import type { EventRescheduleInput } from '../EventBlock'
import { shortTime } from '../lib/format'
import { occurrenceKey } from '../lib/key-nav'

import { CALENDAR_EVENTS_KEY } from './useCalendarEvents'

const UNDO_WINDOW_MS = 5000

export function useEventReschedule(): (
  occ: CalendarEventOccurrence,
  next: EventRescheduleInput
) => void {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const qc = useQueryClient()
  const pushUndo = useUndoToastStore((s) => s.push)
  const setOverride = useCalendarTimeOverrides((s) => s.set)
  const clearOverride = useCalendarTimeOverrides((s) => s.clear)

  const mut = useMutation({
    mutationFn: ({ opts }: { key: string; opts: EventUpdateOpts }) =>
      mailApi.calendar.eventUpdate(opts),
    onSuccess: () => {
      // override 有意**不在这里清**: CalDAV PUT 成功不等于本地 SQLite 已回填
      // (PATCH 只写 CalDAV, 本地行要等 CalendarSyncWorker 下一轮 60s 才 reconcile),
      // 立刻清会让块弹回旧位、几十秒后再跳到新位。等 reconcile 落库后 occurrence
      // 的 start_iso 变了、override key 自然不再匹配, 无需谁来清; TTL (90s) 只是
      // 「服务端始终没变」时的兜底。下面的 invalidate 也只是让缓存尽早追上。
      void qc.invalidateQueries({ queryKey: CALENDAR_EVENTS_KEY })
      void qc.invalidateQueries({ queryKey: qk.calendar.event() })
    },
    onError: (err: unknown, vars) => {
      clearOverride(vars.key)
      const e = err as Error
      toastError(
        t('calendar.undo.rescheduleFailed', '改期失败'),
        e.message || t('calendar.toolbar.syncTipUnknownErr', '未知错误')
      )
    }
  })
  const mutate = mut.mutate

  return useCallback(
    (occ: CalendarEventOccurrence, next: EventRescheduleInput): void => {
      // key 取**原始** occurrence: 连拖两次时覆盖同一条 override, 且周期实例的
      // recurrenceId 仍是它真正的原始 dtstart (override 后的时间不是系列成员)。
      const key = occurrenceKey(occ)
      setOverride(key, { startIso: next.startIso, endIso: next.endIso })

      const opts: EventUpdateOpts = {
        icalUid: occ.ical_uid,
        startIso: next.startIso,
        endIso: next.endIso
      }
      if (occ.recurrence_id || occ.is_recurrence_instance) {
        opts.recurrenceId = occ.recurrence_id || occ.occurrence_start_iso
      }

      const titleShort = (occ.summary || t('calendar.shared.untitled', '未命名事件')).slice(0, 30)
      pushUndo({
        kind: 'reschedule',
        title:
          next.mode === 'resize'
            ? t('calendar.undo.resized', '已调整「{title}」时长', { title: titleShort })
            : t('calendar.undo.rescheduled', '已改期「{title}」', { title: titleShort }),
        subtitle: t('calendar.undo.rescheduledSubtitle', '{range} · 5 秒后同步到 CalDAV', {
          range: `${shortTime(next.startIso)} – ${shortTime(next.endIso)}`
        }),
        durationMs: UNDO_WINDOW_MS,
        onCommit: () => mutate({ key, opts }),
        onUndo: () => {
          clearOverride(key)
          toastSuccess(t('calendar.undo.rescheduleReverted', '已恢复原时间 (未提交)'))
        }
      })
    },
    [t, pushUndo, setOverride, clearOverride, mutate]
  )
}
