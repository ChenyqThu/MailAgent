// L4 群聊 UX 批 — 消息流：渲染 groupTimeline 的输出（日期分隔 / 折叠组 / meta 行 / 停止行 /
// 覆盖边界）+ 末尾在场行 + 滚底（只在用户已在底部附近时随流滚，否则不打断阅读、给「回到最新」钮）
// + 空态 / 加载态 / 错误态。
// 列表性能：折叠组与气泡都是 memo，流式 delta 只改 tail / 最后一组的 text。

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Users } from 'lucide-react'

import type { GroupAttachment } from '@shared/chat_model'
import { cn } from '@shared/lib/cn'
import { STALL_1_MS, STALL_2_MS } from '@shared/assistant/runtime/useTurnStage'

import type { GroupMentionMember } from '../../../../ai-gateway/groupChat'
import { GroupMessageGroup } from './GroupMessageGroup'
import { GroupMetaRow, type RetryUiState } from './GroupMetaRow'
import { GroupPresenceRow, type GroupPresenceWriter } from './GroupPresenceRow'
import {
  colorOfMember,
  dateSeparatorLabel,
  groupTurnStage,
  latestOverlayTurn,
  type GroupTurnStageView
} from './groupPresentation'
import type { GroupTimelineItem, GroupTimelineTail } from './groupTimeline'
import type { GroupMemberMeta } from './members'

/** 距底 ≤ 80px 视为「在底部」（design §4.2 滚底判据）。 */
const NEAR_BOTTOM_PX = 80
/** labs off（无事件源）时的留痕面：空 Map + null 走 groupTurnStage 的 idle 支。 */
const NO_TURN_OVERLAY: GroupTurnStageView['overlay'] = new Map()
/** 在场态的读表间隔。stalled 的门槛是 15s / 30s，父层的 `now` 是 60s 节拍（那口表答的是
 *  「刚刚 / n 分钟前」），分辨不出静默升级。 */
const PRESENCE_TICK_MS = 1_000
/** 骨架延迟显示，短暂加载不闪（design §4.2）。 */
const SKELETON_DELAY_MS = 300

/** 在场态的时钟：**有人在场时**（或刚失败、error 行还没走完新鲜期时）每秒读一次表，其余时候
 *  停表 —— 空闲的时间线不该每秒重渲一次。读数取两口表里更新的那个（父层 60s 节拍 vs 本地秒表），
 *  开停表的判据也用它，于是 error 行必定靠时钟自己走完新鲜期后消失、不会冻在最后一帧变成永动的
 *  红字（overlay 的 failed 留痕没有清理者，停表就等于把红字钉死在群底）。 */
function usePresenceNow(onStage: boolean, failedAt: number | null, fallbackNow: number): number {
  const [tick, setTick] = useState(0)
  const nowRead = Math.max(tick, fallbackNow)
  const active = onStage || (failedAt != null && nowRead - failedAt < STALL_1_MS)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setTick(Date.now()), PRESENCE_TICK_MS)
    return (): void => {
      clearInterval(id)
    }
  }, [active])
  return nowRead
}

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
  onOpenDetails,
  attachmentsById,
  live
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
  /** T2 — 落库 user 行的附件（消息 id → chip 列表），GroupMessageGroup 按 id 取给 GroupBubble。 */
  attachmentsById: ReadonlyMap<number, readonly GroupAttachment[]>
  /** T2 — 在场态要的另外两项事实：turn 留痕（error 支）与最近一次事件时刻（stalled 支）。
   *  null = 没有事件源（labs off / 未加载），不是「没发生过」—— 此时只走 idle。 */
  live: Pick<GroupTurnStageView, 'overlay' | 'lastEventAt'> | null
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

  const overlay = live?.overlay ?? NO_TURN_OVERLAY
  const lastTurn = latestOverlayTurn(overlay)
  const onStage = tail.inFlight != null || tail.preparing != null || tail.queued.length > 0
  const presenceNow = usePresenceNow(
    onStage,
    lastTurn?.phase === 'failed' ? lastTurn.ts : null,
    now
  )
  const { stage, stallLevel } = groupTurnStage(
    {
      inFlight: tail.inFlight,
      preparing: tail.preparing,
      queued: tail.queued,
      overlay,
      lastEventAt: live?.lastEventAt ?? null
    },
    presenceNow,
    { level1Ms: STALL_1_MS, level2Ms: STALL_2_MS }
  )
  // 在写者先取正在流式的那位，没有就取探针说「正在准备」的那位；error 支三元组已空 —— 在场者
  // 是刚失败的那位（同一条留痕）。在场态答的是「谁在场」，认不出人就不画写者行（此时纯排队
  // 由下面那半叙述）。
  const writerId =
    tail.inFlight?.agentId ?? tail.preparing ?? (stage === 'error' ? lastTurn?.agentId : null)
  const writer: GroupPresenceWriter | null =
    writerId == null || stage === 'idle'
      ? null
      : {
          agentId: writerId,
          name: titleOf(writerId),
          avatar: memberMeta.get(writerId)?.avatar,
          stage,
          stallLevel
        }
  const queuedIds =
    tail.preparing != null && !tail.queued.includes(tail.preparing)
      ? [tail.preparing, ...tail.queued]
      : tail.queued
  const queuedNames = queuedIds.filter((id) => id !== writerId).map(titleOf)
  const isEmpty = items.length === 0 && writer == null && queuedNames.length === 0

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
                  attachmentsById={attachmentsById}
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
        <GroupPresenceRow writer={writer} queuedNames={queuedNames} />
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
