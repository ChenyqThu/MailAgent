// 收尾批 (Lane G) — RSVP 确认卡收敛: EventDetailDrawer (阶段1·1.5, F16/D1
// 拍板恒确认) 与 MeetingInviteCard (阶段2·2.2, 邮件详情邀请卡片) 此前各自
// 内嵌同款 JSX (开合 state + useExitAnimation + Esc capture + glass-pop +
// --r-pop), 两处文件都留了「待收敛」注释。此处抽成共享组件, 两个调用点
// 只保留各自的 open/pendingResponse state + rsvpMut, 视觉与交互逐字不变。
//
// titleId 参数化: drawer 版 e2e (calendar-roundtrip.spec.ts) 依赖
// aria-labelledby="cal-rsvp-confirm-title" 选中该卡, 调用方必须显式传入
// 各自原有 id 保持契约不变。

import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import type { RsvpResponse } from '@shared/api/types'

interface Props {
  open: boolean
  pendingResponse: RsvpResponse | null
  /** 事件摘要 (drawer: occurrence.summary; invite card: event.summary)。 */
  eventSummary: string | null | undefined
  /** 已 normalize (去 "mailto:" + lowercase) 的组织者邮箱, 空 = 显示 "—"。 */
  organizer: string | null | undefined
  onCancel: () => void
  onConfirm: () => void
  /** rsvpMut.isPending — 发送中禁用「发送回复」按钮。 */
  confirmPending: boolean
  /** 标题 dom id, 供 aria-labelledby 绑定; 两个调用点各自 id 不同 (e2e 契约)。 */
  titleId: string
}

export function RsvpConfirmDialog({
  open,
  pendingResponse,
  eventSummary,
  organizer,
  onCancel,
  onConfirm,
  confirmPending,
  titleId
}: Props): React.ReactElement | null {
  const { t } = useTranslation()
  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, {
    card: '[data-anim-card]'
  })

  // 确认卡开着时在 capture 期拦 Esc: 只关卡, 不让宿主面 (Drawer window
  // listener / EmailDetail 全局快捷键消费者) 收到本次 Esc。
  useEffect(() => {
    if (!open) return
    const handle = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', handle, true)
    return () => window.removeEventListener('keydown', handle, true)
  }, [open, onCancel])

  if (!shouldRender || !pendingResponse) return null

  const rsvpActionLabels: Record<RsvpResponse, string> = {
    accept: t('calendar.drawer.rsvp.accept', '接受'),
    tentative: t('calendar.drawer.rsvp.tentative', '暂定'),
    decline: t('calendar.drawer.rsvp.decline', '拒绝')
  }

  return (
    <div
      ref={scopeRef}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div data-anim-card className="glass-pop p-5 rounded-[var(--r-pop)] max-w-[360px] mx-4">
        <div id={titleId} className="text-lead text-ink-fg font-medium mb-1">
          {t('calendar.drawer.rsvp.confirmTitle', '发送 RSVP 回复')}
        </div>
        <div className="text-aux text-ink-fg-2 mb-3">
          {t(
            'calendar.drawer.rsvp.confirmBody',
            '将向组织者发送「{action}」回复邮件 (iTIP REPLY), 该操作不可撤回。',
            { action: rsvpActionLabels[pendingResponse] }
          )}
        </div>
        <div className="text-aux text-ink-fg-2 mb-4 space-y-0.5">
          <div className="truncate">
            {t('calendar.drawer.rsvp.confirmEvent', '事件')}:{' '}
            {eventSummary || t('calendar.shared.untitled', '未命名事件')}
          </div>
          <div className="truncate font-mono text-[12px]">
            {t('calendar.drawer.meta.organizer', '组织者')}: {organizer || '—'}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onCancel}>
            {t('calendar.shared.cancel', '取消')}
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={confirmPending}
            onClick={onConfirm}
          >
            {t('calendar.drawer.rsvp.confirmSend', '发送回复')}
          </button>
        </div>
      </div>
    </div>
  )
}
