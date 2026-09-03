// L4 群聊 UX 批 — 群头：标题 + 用途副标题 + 成员头像行（在写者脉冲环 / 排队者半透明）+ 链进度
// + 停止钮 + 详情开合钮。「N 名成员」文字去掉（头像行已表达；design Q7）。
// 在场态两态 + 排队，不做五态（服务端无 waiting / resting 语义，红线 1）。

import { useTranslation } from 'react-i18next'
import { PanelRight, Square, X } from 'lucide-react'

import { cn } from '@shared/lib/cn'

import { AgentAvatar } from '../AgentAvatar'
import type { GroupMemberMeta } from './members'

export function GroupHeader({
  title,
  topic,
  memberIds,
  memberMeta,
  inFlight,
  queued,
  chainProgress,
  showChain,
  runAlive,
  stopping,
  onStop,
  detailsOpen,
  onToggleDetails,
  onClose
}: {
  title: string
  topic: string | null
  memberIds: readonly string[]
  memberMeta: Map<string, GroupMemberMeta>
  inFlight: string | null
  queued: readonly string[]
  chainProgress: { counted: number; cap: number } | null
  showChain: boolean
  runAlive: boolean
  stopping: boolean
  onStop: () => void
  detailsOpen?: boolean
  onToggleDetails?: () => void
  /** T3 — 话题面用同一个群头（标题 = 话题摘要、头像行 = 参与者、停止钮照旧），多一个关闭钮。 */
  onClose?: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const nearCap =
    chainProgress != null &&
    chainProgress.cap > 0 &&
    chainProgress.counted / chainProgress.cap >= 0.8
  return (
    <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-ink-border px-4">
      <span className="min-w-0 shrink truncate text-body font-semibold text-ink-fg">{title}</span>
      {topic != null && topic.length > 0 && (
        <span className="min-w-0 shrink truncate text-meta text-ink-fg-3" title={topic}>
          {topic}
        </span>
      )}
      <span className="flex shrink-0 items-center -space-x-1.5">
        {memberIds.slice(0, 8).map((id) => {
          const speaking = inFlight === id
          const waiting = !speaking && queued.includes(id)
          return (
            <span
              key={id}
              data-presence={speaking ? 'speaking' : waiting ? 'queued' : undefined}
              className={cn(
                'rounded-[var(--r-ctl)]',
                speaking && 'animate-pulse ring-2 ring-[rgb(var(--c-ai))]',
                waiting && 'opacity-60'
              )}
            >
              <AgentAvatar
                agentId={id}
                config={memberMeta.get(id)?.avatar}
                size={22}
                title={memberMeta.get(id)?.title?.trim() || id}
              />
            </span>
          )
        })}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {showChain && chainProgress != null && (
          <span
            className={cn(
              'rounded-full bg-ink-3 px-2 py-px font-mono text-meta tabular-nums',
              nearCap ? 'text-warn' : 'text-ink-fg-2'
            )}
          >
            {t('groupChat.chainProgress', {
              counted: chainProgress.counted,
              cap: chainProgress.cap
            })}
          </span>
        )}
        {runAlive && (
          <button
            type="button"
            onClick={onStop}
            disabled={stopping}
            aria-label={t('groupChat.stop')}
            title={t('groupChat.runAlive')}
            className="grid size-7 place-items-center rounded-md text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg disabled:opacity-40"
          >
            <Square size={12} strokeWidth={2} fill="currentColor" />
          </button>
        )}
        {onToggleDetails && (
          <button
            type="button"
            onClick={onToggleDetails}
            aria-pressed={detailsOpen === true}
            aria-label={t(detailsOpen ? 'groupChat.details.close' : 'groupChat.details.open')}
            className={cn(
              'grid size-7 place-items-center rounded-md transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg',
              detailsOpen ? 'bg-ink-3 text-ink-fg' : 'text-ink-fg-1'
            )}
          >
            <PanelRight size={15} strokeWidth={2} />
          </button>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t('groupChat.thread.close')}
            className="grid size-7 place-items-center rounded-md text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
          >
            <X size={15} strokeWidth={2} />
          </button>
        )}
      </span>
    </div>
  )
}
