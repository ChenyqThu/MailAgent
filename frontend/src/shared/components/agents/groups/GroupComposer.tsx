// L4 群聊 UX 批 — 发送框：自增高 textarea（`field-sizing: content` + onInput 兜底，happy-dom 只有
// 后者生效）、@ 弹层（↑↓ 循环 / Enter · Tab 采纳 / Esc 关；「所有人」置顶；头像 + 响应模式角标）、
// 「将唤醒 N 位」提示、发送态、禁用态。labs off 与 on 共用（off 去掉唤醒提示与角标）。
// 🔴 弹层开着时 Enter 是「采纳」不是「发送」。

import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SendHorizontal, Users } from 'lucide-react'

import type { AgentAvatarConfig } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { Loader } from '@shared/components/ui/loader'

import { GROUP_MENTION_ALL_TOKENS } from '../../../../ai-gateway/groupChat'
import type { GroupResponseMode } from '../../../../ai-gateway/groupFloors'
import { AgentAvatar } from '../AgentAvatar'
import { detectMentionDraft } from './mentions'

const MAX_TEXTAREA_PX = 128
const MAX_MENTION_ITEMS = 8

export interface GroupComposerMember {
  agentId: string
  title: string
  avatar?: AgentAvatarConfig | null
}

type MentionItem = { kind: 'all' } | { kind: 'member'; member: GroupComposerMember }

export function GroupComposer({
  draft,
  onDraftChange,
  onSend,
  sending,
  disabled,
  members,
  modes,
  labsOn,
  labsLoading,
  wakeCount,
  runAlive
}: {
  draft: string
  onDraftChange: (next: string) => void
  onSend: () => void
  sending: boolean
  disabled: boolean
  members: readonly GroupComposerMember[]
  /** labs on 才有：缺行 = mention。null = 未加载 / labs off（不显角标）。 */
  modes: Record<string, GroupResponseMode> | null
  labsOn: boolean
  labsLoading: boolean
  /** labs on 且草稿非空时的唤醒人数；null = 不显示提示。 */
  wakeCount: number | null
  runAlive: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const listId = useId()
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  const query = mention?.query.toLowerCase() ?? ''
  const allLabel = t('groupChat.mentionAll')
  const items: MentionItem[] = mention
    ? [
        ...(query.length === 0 || allLabel.toLowerCase().includes(query) || 'all'.includes(query)
          ? [{ kind: 'all' } as const]
          : []),
        ...members
          .filter((m) => m.title.toLowerCase().includes(query))
          .slice(0, MAX_MENTION_ITEMS)
          .map((member) => ({ kind: 'member', member }) as const)
      ]
    : []
  const open = mention != null && items.length > 0
  const active = open ? Math.min(activeIndex, items.length - 1) : 0

  const refreshMention = (value: string, caret: number | null): void => {
    setMention(caret == null ? null : detectMentionDraft(value, caret))
    setActiveIndex(0)
  }
  const pick = (item: MentionItem): void => {
    if (!mention) return
    const label = item.kind === 'all' ? GROUP_MENTION_ALL_TOKENS[0] : `@${item.member.title}`
    const caret = inputRef.current?.selectionStart ?? draft.length
    onDraftChange(`${draft.slice(0, mention.start)}${label} ${draft.slice(caret)}`)
    setMention(null)
    inputRef.current?.focus()
  }
  const autosize = (el: HTMLTextAreaElement): void => {
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((active + 1) % items.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((active - 1 + items.length) % items.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pick(items[active])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMention(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      setMention(null)
      onSend()
    } else if (e.key === 'Escape') {
      setMention(null)
    }
  }

  const hint = labsLoading
    ? { text: t('groupChat.labsLoading'), warn: false }
    : labsOn && wakeCount != null
      ? wakeCount > 0
        ? { text: t('groupChat.wakeCount', { count: wakeCount }), warn: false }
        : { text: t('groupChat.wakeNone'), warn: true }
      : null

  return (
    <div className="relative shrink-0 border-t border-ink-border px-4 py-3">
      {open && (
        <div
          id={listId}
          role="listbox"
          className="glass-pop absolute bottom-full left-4 z-10 mb-1 w-64 rounded-[var(--r-ctl)] border border-ink-border-soft p-1"
        >
          {items.map((item, i) => {
            const selected = i === active
            const id = `${listId}-${i}`
            return (
              <button
                key={item.kind === 'all' ? '__all__' : item.member.agentId}
                id={id}
                type="button"
                role="option"
                aria-selected={selected}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(item)}
                onMouseEnter={() => setActiveIndex(i)}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-aux text-ink-fg-1 transition-colors duration-fast',
                  selected && 'bg-ink-3'
                )}
              >
                {item.kind === 'all' ? (
                  <>
                    <span className="grid size-5 shrink-0 place-items-center text-ink-fg-2">
                      <Users size={15} strokeWidth={2} />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{allLabel}</span>
                    <span className="truncate text-micro text-ink-fg-3">
                      {t('groupChat.mentionAllHint')}
                    </span>
                  </>
                ) : (
                  <>
                    <AgentAvatar
                      agentId={item.member.agentId}
                      config={item.member.avatar}
                      size={20}
                      title={item.member.title}
                    />
                    <span className="min-w-0 flex-1 truncate">{item.member.title}</span>
                    {labsOn && modes != null && (
                      <span className="rounded-full bg-ink-3 px-1.5 text-micro text-ink-fg-3">
                        {t(
                          (modes[item.member.agentId] ?? 'mention') === 'realtime'
                            ? 'groupChat.mentionModeRealtime'
                            : 'groupChat.mentionModeMention'
                        )}
                      </span>
                    )}
                  </>
                )}
              </button>
            )
          })}
        </div>
      )}
      {(hint != null || runAlive) && (
        <div className="mb-1.5 flex items-center gap-3 text-micro text-ink-fg-3">
          {hint != null && <span className={cn(hint.warn && 'text-warn')}>{hint.text}</span>}
          {runAlive && <span>{t('groupChat.queuedBehind')}</span>}
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={inputRef}
          value={draft}
          rows={1}
          disabled={disabled}
          placeholder={t('groupChat.composerPlaceholder')}
          aria-autocomplete="list"
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${active}` : undefined}
          onChange={(e) => {
            onDraftChange(e.target.value)
            refreshMention(e.target.value, e.target.selectionStart)
          }}
          onInput={(e) => autosize(e.currentTarget)}
          onKeyDown={onKeyDown}
          className={cn(
            'max-h-32 min-h-9 flex-1 resize-none rounded-lg border border-ink-border-soft bg-ink-2 px-3 py-2 [field-sizing:content]',
            'text-body text-ink-fg outline-none placeholder:text-ink-fg-3 disabled:cursor-not-allowed disabled:opacity-50'
          )}
        />
        <button
          type="button"
          onClick={onSend}
          disabled={disabled || sending || draft.trim().length === 0}
          aria-label={t('groupChat.send')}
          className={cn(
            'grid size-9 shrink-0 place-items-center rounded-lg text-accent-fg transition-opacity duration-fast',
            'disabled:opacity-40'
          )}
          style={{ background: 'rgb(var(--c-accent))' }}
        >
          {sending ? (
            <Loader variant="spinner" size={15} label={t('groupChat.send')} />
          ) : (
            <SendHorizontal size={15} strokeWidth={2} />
          )}
        </button>
      </div>
    </div>
  )
}
