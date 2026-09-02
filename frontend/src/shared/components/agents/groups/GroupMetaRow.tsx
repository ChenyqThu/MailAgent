// L4 群聊 UX 批 — 淡色 meta 行：沉默 / 重复折叠 / 跳过 / 失败(+重试) / 无人唤醒 / 已停止。
// 不占气泡、不进折叠组；文案全部由 turn 行 `outcome + error` 或事件 `phase + reason` 映射而来
// （groupTimeline.metaVariantOf），这里不再推断。

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Info, RotateCcw } from 'lucide-react'

import type { AgentAvatarConfig } from '@shared/api/types'
import { cn } from '@shared/lib/cn'

import { AgentAvatar } from '../AgentAvatar'
import type { GroupMetaVariant, GroupTimelineItem } from './groupTimeline'

export type GroupMetaItem = Extract<
  GroupTimelineItem,
  { kind: 'meta' | 'noCandidates' | 'stopped' | 'gameOver' }
>

/** 失败行重试钮的 UI 态（视图持有，按 item.key 记）。 */
export type RetryUiState =
  | { kind: 'idle' }
  | { kind: 'retrying' }
  | { kind: 'stopped' }
  | { kind: 'labsOff' }
  | { kind: 'error'; message: string }

const META_KEYS: Record<GroupMetaVariant, string> = {
  silent: 'groupChat.metaSilent',
  held_dup: 'groupChat.metaHeldDup',
  skipped_monologue: 'groupChat.metaSkippedMonologue',
  skipped_no_new_messages: 'groupChat.metaSkippedNoNew',
  skipped_removed: 'groupChat.metaSkippedRemoved',
  skipped: 'groupChat.metaSkipped',
  failed: 'groupChat.metaFailed'
}

export function GroupMetaRow({
  item,
  name,
  avatar,
  retry,
  onRetry,
  onOpenDetails
}: {
  item: GroupMetaItem
  name?: string
  avatar?: AgentAvatarConfig | null
  retry?: RetryUiState
  onRetry?: () => void
  onOpenDetails?: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  if (item.kind === 'gameOver') {
    // 终局不是「被停止」：不给展开详情、不给重试，只是一条居中的事实。
    return (
      <div className="flex items-center justify-center py-1" data-game-over={item.runId ?? ''}>
        <span className="text-meta text-ink-fg-2">{t('groupChat.gameOver')}</span>
      </div>
    )
  }

  if (item.kind === 'stopped') {
    const human = t(`groupChat.stopped.${item.reason}`, { defaultValue: item.reason })
    return (
      <div className="flex flex-col items-center py-1">
        <div className="flex items-center gap-1 text-meta text-ink-fg-2">
          <span>{t('groupChat.stoppedPrefix', { reason: human })}</span>
          {item.reason !== 'owner_stop' && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={t('groupChat.stoppedDetail', { reason: item.reason })}
              onClick={() => setExpanded((v) => !v)}
              className="grid size-5 place-items-center rounded text-ink-fg-3 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg-1"
            >
              <ChevronRight
                size={12}
                strokeWidth={2}
                className={cn('transition-transform duration-fast', expanded && 'rotate-90')}
              />
            </button>
          )}
        </div>
        {expanded && (
          <div className="font-mono text-micro text-ink-fg-3">
            {t('groupChat.stoppedDetail', { reason: item.reason })}
          </div>
        )}
      </div>
    )
  }

  if (item.kind === 'noCandidates') {
    return (
      <div className="flex items-center gap-2 py-0.5 text-meta text-ink-fg-3">
        <Info size={13} strokeWidth={2} className="shrink-0" />
        <span>
          {t(
            item.reason === 'self_only'
              ? 'groupChat.noCandidatesSelfOnly'
              : 'groupChat.noCandidates'
          )}
        </span>
        {onOpenDetails && (
          <button
            type="button"
            onClick={onOpenDetails}
            className="text-aux text-ink-fg-1 underline-offset-2 hover:underline"
          >
            {t('groupChat.openDetails')}
          </button>
        )}
      </div>
    )
  }

  const failed = item.variant === 'failed'
  const label = name ?? item.agentId
  const state: RetryUiState = retry ?? { kind: 'idle' }
  const stoppedChain = failed && (item.retryDisabled || state.kind === 'stopped')
  return (
    <div
      className={cn(
        'flex items-center gap-2 py-0.5 text-meta',
        failed ? 'text-fail' : 'text-ink-fg-3'
      )}
    >
      <span className="shrink-0 opacity-60">
        <AgentAvatar agentId={item.agentId} config={avatar} size={16} title={label} />
      </span>
      <span className="min-w-0 truncate">
        {t(META_KEYS[item.variant], { name: label, error: item.error ?? 'unknown' })}
      </span>
      {failed && onRetry && (
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {state.kind === 'error' && (
            <span className="text-micro text-ink-fg-3">
              {t('groupChat.retryFailed', { error: state.message })}
            </span>
          )}
          {stoppedChain ? (
            <button
              type="button"
              disabled
              className="flex items-center gap-1 text-aux text-ink-fg-3 opacity-60"
            >
              <RotateCcw size={13} strokeWidth={2} />
              {t('groupChat.retryStopped')}
            </button>
          ) : state.kind === 'labsOff' ? (
            <button
              type="button"
              disabled
              className="flex items-center gap-1 text-aux text-ink-fg-3 opacity-60"
            >
              <RotateCcw size={13} strokeWidth={2} />
              {t('groupChat.retryOrchestratedOnly')}
            </button>
          ) : (
            <button
              type="button"
              disabled={state.kind === 'retrying'}
              onClick={onRetry}
              className="flex items-center gap-1 text-aux text-ink-fg-1 transition-colors duration-fast hover:text-ink-fg disabled:opacity-60"
            >
              <RotateCcw size={13} strokeWidth={2} />
              {t(state.kind === 'retrying' ? 'groupChat.retrying' : 'groupChat.retry')}
            </button>
          )}
        </span>
      )}
    </div>
  )
}
