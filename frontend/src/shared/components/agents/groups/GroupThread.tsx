// L4 群聊 UX 批 — 消息流：渲染 groupTimeline 的输出（日期分隔 / 折叠组 / meta 行 / 停止行 /
// 覆盖边界）+ 末尾在场行 + 滚底（只在用户已在底部附近时随流滚，否则不打断阅读、给「回到最新」钮）
// + 空态 / 加载态 / 错误态。
// 列表性能：折叠组与气泡都是 memo，流式 delta 只改 tail / 最后一组的 text。

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Users } from 'lucide-react'

import { cn } from '@shared/lib/cn'

import type { GroupMentionMember } from '../../../../ai-gateway/groupChat'
import { GroupMessageGroup } from './GroupMessageGroup'
import { GroupMetaRow, type RetryUiState } from './GroupMetaRow'
import { GroupPresenceRow } from './GroupPresenceRow'
import { colorOfMember, dateSeparatorLabel } from './groupPresentation'
import type { GroupTimelineItem, GroupTimelineTail } from './groupTimeline'
import type { GroupMemberMeta } from './members'

/** 距底 ≤ 80px 视为「在底部」（design §4.2 滚底判据）。 */
const NEAR_BOTTOM_PX = 80
/** 骨架延迟显示，短暂加载不闪（design §4.2）。 */
const SKELETON_DELAY_MS = 300

export type GroupThreadEmpty = 'v1' | 'orchestrated' | 'noRealtime'

export function GroupThread({
  items,
  tail,
  memberIds,
  memberMeta,
  members,
  now,
  loading,
  error,
  onRetryLoad,
  empty,
  retryStates,
  onRetry,
  onOpenDetails
}: {
  items: readonly GroupTimelineItem[]
  tail: GroupTimelineTail
  memberIds: readonly string[]
  memberMeta: Map<string, GroupMemberMeta>
  members: readonly GroupMentionMember[]
  now: number
  loading: boolean
  error: string | null
  onRetryLoad: () => void
  empty: GroupThreadEmpty
  retryStates: ReadonlyMap<string, RetryUiState>
  onRetry: (item: Extract<GroupTimelineItem, { kind: 'meta' }>) => void
  onOpenDetails?: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const titleOf = (id: string): string => memberMeta.get(id)?.title?.trim() || id

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const nearBottomRef = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const near = el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_BOTTOM_PX
    nearBottomRef.current = near
    setShowJump(!near)
  }
  const jumpToLatest = (): void => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    nearBottomRef.current = true
    setShowJump(false)
  }
  // 内容变化：在底部附近才随流滚底；阅读旧消息时不抢滚（回底钮由 onScroll 维护）。
  useEffect(() => {
    const el = scrollRef.current
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight
  }, [items, tail])

  const [skeleton, setSkeleton] = useState(false)
  useEffect(() => {
    if (!loading) return undefined
    const id = setTimeout(() => setSkeleton(true), SKELETON_DELAY_MS)
    return () => {
      clearTimeout(id)
      setSkeleton(false)
    }
  }, [loading])

  const typingName =
    tail.inFlight != null && tail.inFlight.text.length === 0 ? titleOf(tail.inFlight.agentId) : null
  const queuedIds =
    tail.preparing != null && !tail.queued.includes(tail.preparing)
      ? [tail.preparing, ...tail.queued]
      : tail.queued
  const queuedNames = queuedIds.filter((id) => id !== tail.inFlight?.agentId).map(titleOf)
  const isEmpty = items.length === 0 && typingName == null && queuedNames.length === 0

  let content: React.ReactNode
  if (error != null && items.length === 0) {
    content = (
      <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-meta text-ink-fg-3">
        <span>{t('groupChat.thread.loadFailed')}</span>
        <button
          type="button"
          onClick={onRetryLoad}
          className="text-aux text-ink-fg-1 underline-offset-2 hover:underline"
        >
          {t('groupChat.thread.retryLoad')}
        </button>
      </div>
    )
  } else if (loading && items.length === 0) {
    content = skeleton ? (
      <div className="flex animate-pulse flex-col gap-3 px-2 py-4" aria-hidden>
        <div className="h-9 w-3/5 rounded-[var(--r-ctl)] bg-ink-3" />
        <div className="h-9 w-2/5 self-end rounded-[var(--r-ctl)] bg-ink-3" />
        <div className="h-9 w-1/2 rounded-[var(--r-ctl)] bg-ink-3" />
      </div>
    ) : null
  } else if (isEmpty) {
    content = (
      <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-meta text-ink-fg-3">
        <Users size={20} strokeWidth={1.5} />
        <span>
          {t(
            empty === 'v1'
              ? 'groupChat.emptyThread'
              : empty === 'noRealtime'
                ? 'groupChat.emptyThreadNoRealtime'
                : 'groupChat.emptyThreadOrchestrated'
          )}
        </span>
        {empty === 'noRealtime' && onOpenDetails && (
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
  } else {
    content = (
      <div className="flex flex-col gap-3.5">
        {items.map((item) => {
          switch (item.kind) {
            case 'date':
              return (
                <div
                  key={item.key}
                  className="flex items-center gap-3 py-1 text-meta text-ink-fg-3"
                >
                  <span className="h-px flex-1 bg-ink-border" />
                  <span>{dateSeparatorLabel(item.dayStart, now, t)}</span>
                  <span className="h-px flex-1 bg-ink-border" />
                </div>
              )
            case 'turnsBoundary':
              return (
                <div key={item.key} className="py-0.5 text-center text-micro text-ink-fg-3">
                  {t('groupChat.turnsNotLoaded')}
                </div>
              )
            case 'group': {
              const agentId = item.speaker.type === 'member' ? item.speaker.agentId : null
              return (
                <GroupMessageGroup
                  key={item.key}
                  item={item}
                  name={agentId != null ? (agentId === 'assistant' ? 'AI' : titleOf(agentId)) : ''}
                  color={agentId != null ? colorOfMember(memberIds, agentId) : ''}
                  avatar={agentId != null ? memberMeta.get(agentId)?.avatar : null}
                  members={members}
                  memberIds={memberIds}
                  now={now}
                />
              )
            }
            case 'meta':
              return (
                <GroupMetaRow
                  key={item.key}
                  item={item}
                  name={titleOf(item.agentId)}
                  avatar={memberMeta.get(item.agentId)?.avatar}
                  retry={retryStates.get(item.key)}
                  onRetry={() => onRetry(item)}
                />
              )
            default:
              return <GroupMetaRow key={item.key} item={item} onOpenDetails={onOpenDetails} />
          }
        })}
        <GroupPresenceRow typingName={typingName} queuedNames={queuedNames} />
      </div>
    )
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="scrollbar-thin h-full overflow-y-auto px-4 py-4"
        data-group-thread
      >
        {content}
      </div>
      <button
        type="button"
        onClick={jumpToLatest}
        aria-label={t('groupChat.scrollToLatest')}
        className={cn(
          'glass-pop absolute bottom-3 right-4 grid size-9 place-items-center rounded-full text-ink-fg-1 transition-opacity duration-fast hover:text-ink-fg',
          showJump ? 'opacity-100' : 'pointer-events-none opacity-0'
        )}
      >
        <ChevronDown size={16} strokeWidth={2} />
      </button>
    </div>
  )
}
