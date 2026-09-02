// L4 群聊 UX 批 — 群列表的一行（头像堆 + 群名 + 相对时间 + 第二行三态 + 未读点 + hover「…」）。
//
// 第二行三态，**优先级从上到下**（design §4.3）：
//   ① 发言中：有在写者 → 「X 正在输入…」；只知道「这个群在跑」→ 「成员正在发言…」。
//      判据只来自服务端事件（`useGroupLiveMap`）或本地正在发的那一轮，不做任何推断（红线 1）。
//   ② 「{前缀}：{预览}」—— 前缀三分支（主助理 / 你 / 成员名）由 previewPrefix 单源判定。
//   ③ 「N 名成员」—— 没有 last_message（新群 / 只有 system 行）时的兜底。
//      🔴 这一态的文案是 `memberCount`，不许改：GroupChat.test.tsx W1 靠它。
//
// 行内重命名与「…」菜单照 AgentThreadList 的 SessionRow / SessionRowMenu（同一套手感），
// 只留重命名 / 删除两项 —— 群没有置顶 / 星标 / 归档语义，静音归群详情面的 `notify` 键。

import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react'

import type { ChatSessionListItem } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { Popover, PopoverContent, PopoverTrigger } from '@shared/components/ui/popover'

import { AgentAvatar } from '../AgentAvatar'
import { parseMembersJson, type GroupMemberMeta } from './members'
import { plainPreview, previewPrefix, relativeTimeLabel } from './groupPresentation'

/** 行需要的最小形状：清单行（ChatSessionListItem）与刚建好的会话行（ChatSession）都满足。 */
export interface GroupRowItem {
  id: number
  title: string | null
  members_json?: string | null
  updated_at: number
  last_read_at?: number | null
  last_message?: ChatSessionListItem['last_message']
  /** 子群（狼人杀的狼群 / 预言家群）→ 父群 id；顶级群恒空。 */
  parent_session_id?: number | null
}

export function GroupRow({
  item,
  parentTitle,
  memberMeta,
  selected,
  unread,
  speaking,
  speakerId,
  renaming,
  now,
  onSelect,
  onStartRename,
  onSubmitRename,
  onCancelRename,
  onDelete
}: {
  item: GroupRowItem
  /** 父群标题（子群才有；父群不在清单里时由 GroupList 传 null，chip 退回 `#id`）。 */
  parentTitle?: string | null
  memberMeta: Map<string, GroupMemberMeta>
  selected: boolean
  unread: boolean
  /** 这个群此刻在跑（事件三元组非空，或本地正在发的那一轮）。 */
  speaking: boolean
  /** 在写者（拿得到才显示名字，拿不到只说「有人在发言」）。 */
  speakerId: string | null
  renaming: boolean
  /** 相对时间的「现在」（由列表统一给，同一批行不各自读时钟）。 */
  now: number
  onSelect: () => void
  onStartRename: () => void
  onSubmitRename: (title: string) => void
  onCancelRename: () => void
  onDelete: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const memberIds = parseMembersJson(item.members_json ?? null)
  const title = item.title ?? t('groupChat.defaultTitle')
  const titleOf = (id: string): string => memberMeta.get(id)?.title?.trim() || id
  const last = item.last_message ?? null
  const stamp = relativeTimeLabel(last?.created_at ?? item.updated_at, now, t)

  // 行内重命名：草稿在进入重命名态时重新播种；Enter / Escape 都走 blur，提交/取消只有一条路径。
  const [draft, setDraft] = useState(title)
  const [wasRenaming, setWasRenaming] = useState(renaming)
  const escapeRef = useRef(false)
  if (renaming !== wasRenaming) {
    setWasRenaming(renaming)
    if (renaming) setDraft(title)
  }

  if (renaming) {
    return (
      <div className="relative flex items-center rounded-[var(--r-ctl)] bg-ink-3 pl-2.5">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              escapeRef.current = true
              e.currentTarget.blur()
            }
          }}
          onBlur={() => {
            if (escapeRef.current) {
              escapeRef.current = false
              onCancelRename()
              return
            }
            const next = draft.trim()
            if (next.length > 0 && next !== title) onSubmitRename(next)
            else onCancelRename()
          }}
          aria-label={t('groupChat.rename')}
          className="h-[52px] min-w-0 flex-1 bg-transparent pr-2.5 text-body text-ink-fg outline-none"
        />
      </div>
    )
  }

  return (
    <div
      data-group-row={item.id}
      className={cn(
        'group relative flex items-center rounded-[var(--r-ctl)]',
        selected ? '[background-image:var(--sel-wash)]' : 'hover:bg-ink-fg/[0.04]'
      )}
    >
      {selected && (
        <span
          className="absolute bottom-2 left-0 top-2 w-[3px] rounded-sm"
          style={{ background: 'rgb(var(--c-accent))' }}
        />
      )}
      <button
        type="button"
        onClick={onSelect}
        className="grid h-[52px] min-w-0 flex-1 grid-cols-[auto_1fr_auto] items-center gap-2.5 rounded-[var(--r-ctl)] pl-2.5 pr-2 text-left"
      >
        {/* 成员头像堆叠（最多 3 个，overlap）+ 右下角发言中脉冲点。 */}
        <span className="relative flex shrink-0 items-center -space-x-1.5">
          {memberIds.slice(0, 3).map((id) => (
            <span key={id} className="rounded-full ring-2 ring-[rgb(var(--c-bg,255_255_255))/0]">
              <AgentAvatar
                agentId={id}
                config={memberMeta.get(id)?.avatar}
                size={20}
                title={titleOf(id)}
              />
            </span>
          ))}
          {speaking && (
            <span
              aria-label={t('groupChat.speakingNow')}
              className="absolute -bottom-0.5 -right-0.5 size-2 animate-pulse rounded-full bg-ai"
            />
          )}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-baseline gap-2">
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-body',
                unread ? 'font-semibold text-ink-fg' : 'text-ink-fg-1'
              )}
              title={title}
            >
              {title}
            </span>
            {/* 子群标注是群名右侧的小 chip：第二行三态（发言中 / 预览 / 成员数）不让位给它。 */}
            {item.parent_session_id != null && (
              <span
                data-subgroup-of={item.parent_session_id}
                className="shrink-0 rounded-full bg-ink-3 px-1.5 py-px text-micro text-ink-fg-3"
              >
                {t('groupChat.subgroupOf', {
                  title: parentTitle ?? `#${item.parent_session_id}`
                })}
              </span>
            )}
            <span className="shrink-0 text-meta tabular-nums text-ink-fg-3">{stamp}</span>
          </span>
          <span className={cn('block truncate text-micro', speaking ? 'text-ai' : 'text-ink-fg-3')}>
            {speaking
              ? speakerId != null
                ? t('groupChat.typing', { name: titleOf(speakerId) })
                : t('groupChat.speaking')
              : last != null
                ? t('groupChat.previewLine', {
                    prefix: previewPrefix(last, titleOf, t),
                    text: plainPreview(last.content)
                  })
                : t('groupChat.memberCount', { count: memberIds.length })}
          </span>
        </span>
        {unread && (
          <span
            data-session-unread-dot
            aria-label={t('chat.sidebar.unread')}
            className="size-1.5 shrink-0 rounded-full bg-coral/100"
          />
        )}
      </button>
      <GroupRowMenu onRename={onStartRename} onDelete={onDelete} />
    </div>
  )
}

/** hover「…」菜单：只有重命名 / 删除（群没有置顶 / 星标 / 归档语义）。 */
function GroupRowMenu({
  onRename,
  onDelete
}: {
  onRename: () => void
  onDelete: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ITEM =
    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-aux transition-colors duration-fast'
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('agentView.more')}
          className={cn(
            'absolute right-1 grid size-6 place-items-center rounded text-ink-fg-3 transition-opacity duration-fast',
            'hover:bg-ink-4 hover:text-ink-fg',
            open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
          )}
        >
          <MoreHorizontal size={14} strokeWidth={2} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="right" sideOffset={6} className="w-36 p-1">
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            onRename()
          }}
          className={cn(ITEM, 'text-ink-fg-1 hover:bg-ink-3')}
        >
          <Pencil size={13} strokeWidth={1.75} className="shrink-0 text-ink-fg-3" />
          {t('groupChat.rename')}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            onDelete()
          }}
          className={cn(ITEM, 'text-fail hover:bg-fail/10')}
        >
          <Trash2 size={13} strokeWidth={1.75} className="shrink-0" />
          {t('groupChat.delete')}
        </button>
      </PopoverContent>
    </Popover>
  )
}
