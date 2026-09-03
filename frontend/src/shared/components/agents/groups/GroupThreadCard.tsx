// T3 群聊话题 — 主时间线里挂在根消息正下方的话题卡：回复数 + 最新一条回复（说话人头像 / 名字 /
// 两行截断摘要）+ 「回复话题」。整张卡是**一个** button：点卡与点「回复话题」是同一个动作（打开
// 话题面），不做两个落点 —— 嵌套 button 也不是合法 DOM。
// 未读 → 左侧状态点（与群列表行的未读点同一颗 coral 小圆点）；「最新一条」的名字走 previewPrefix
// （主助理 / 你 / 成员名），与群列表行的前缀同一单源。

import { memo } from 'react'
import { useTranslation } from 'react-i18next'

import type { GroupThreadSummary } from '@shared/chat_model'
import { cn } from '@shared/lib/cn'

import { AgentAvatar } from '../AgentAvatar'
import { plainPreview, previewPrefix, relativeTimeLabel } from './groupPresentation'
import type { GroupMemberMeta } from './members'

/** 摘要截断长度：两行 line-clamp 之外再按字符截一刀，长回复不把整段正文塞进 DOM。 */
const PREVIEW_CHARS = 160

export const GroupThreadCard = memo(function GroupThreadCard({
  thread,
  memberMeta,
  align,
  now,
  onOpen
}: {
  thread: GroupThreadSummary
  memberMeta: Map<string, GroupMemberMeta>
  /** 跟着根消息：user 根右对齐（`end`），成员根缩进到气泡列（`start`）。 */
  align: 'start' | 'end'
  now: number
  onOpen: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const titleOf = (id: string): string => memberMeta.get(id)?.title?.trim() || id
  const last = thread.lastMessage
  const speakerId = last?.speakerAgentId ?? null
  return (
    <button
      type="button"
      onClick={onOpen}
      data-thread-card={thread.sessionId}
      data-thread-unread={thread.unread ? '' : undefined}
      className={cn(
        'group/thread flex max-w-[86%] items-start gap-2 rounded-[var(--r-card)] border border-ink-border-soft bg-ink-2 px-3 py-2 text-left',
        'transition-colors duration-fast hover:bg-ink-3',
        align === 'end' ? 'self-end' : 'ml-10'
      )}
    >
      <span
        aria-hidden
        className={cn(
          'mt-1.5 size-1.5 shrink-0 rounded-full',
          thread.unread ? 'bg-coral/100' : 'bg-transparent'
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-2 text-meta">
          <span className="font-medium text-ink-fg-1">
            {t('groupChat.thread.count', { count: thread.replyCount })}
          </span>
          {last != null && (
            <span className="tabular-nums text-ink-fg-3">
              {t('groupChat.thread.latest')} · {relativeTimeLabel(last.createdAt, now, t)}
            </span>
          )}
        </span>
        {last != null && (
          <span className="flex items-start gap-1.5">
            {speakerId != null && (
              <span className="shrink-0 pt-px">
                <AgentAvatar
                  agentId={speakerId}
                  config={memberMeta.get(speakerId)?.avatar}
                  size={18}
                  title={titleOf(speakerId)}
                />
              </span>
            )}
            <span className="line-clamp-2 min-w-0 text-aux text-ink-fg-1">
              {t('groupChat.previewLine', {
                prefix: previewPrefix(
                  { role: last.role, speaker_agent_id: speakerId, via: null },
                  titleOf,
                  t
                ),
                text: plainPreview(last.content, PREVIEW_CHARS)
              })}
            </span>
          </span>
        )}
        <span className="text-aux text-[rgb(var(--c-accent))] group-hover/thread:underline">
          {t('groupChat.thread.reply')}
        </span>
      </span>
    </button>
  )
})
