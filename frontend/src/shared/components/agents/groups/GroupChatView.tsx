// L4 群聊 — 单个群聊会话的消息流 + 发送框（飞书/Slack 式）。
//
// 视觉基准（原型 .msg/.av/.who/.bub，色值换 v3 token）：成员消息 = AgentAvatar 30px 左置 +
// 彩色名字 + 左对齐气泡（圆角 4 12 12 12）；用户消息右对齐（sel-wash 底，圆角 12 4 12 12）。
// 名字色 = token 调色板按成员序取（不引新十六进制）。
//
// 驱动（searchAgentClient 同形态，不上 assistant-ui runtime）：
//   发送 = ① appendGroupUserMessage 落用户消息 → ② 目标成员串行 runGroupSpeaker（一个说完
//   下一个说；流式增量喂本地 live 气泡）→ ③ refetch 落库 transcript、清掉成功的 live 气泡。
//   有 @ → 只点名的成员回；无 @ → 全员按 members_json 序各回一轮。某成员失败 → 该气泡标
//   失败继续下一个（失败气泡不落库，保留在 live 区直到下一轮发送）。

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { SendHorizontal } from 'lucide-react'

import type { AgentAvatarConfig, ChatMessage, ChatSession } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { qk } from '@shared/lib/queryKeys'
import { useMailApi } from '@shared/hooks/useMailApi'
import { errorMessage } from '@shared/lib/ipcErrors'
import { appendGroupUserMessage, runGroupSpeaker } from '@shared/assistant/groupChatClient'

import { AgentAvatar } from '../AgentAvatar'
import { detectMentionDraft, parseGroupMentions } from './mentions'
import { parseMembersJson, type GroupMemberMeta } from './members'

/** 成员名字色（按 members_json 序取模）。全 token，不引新色值。 */
const NAME_COLORS = [
  'rgb(var(--c-ai))',
  'rgb(var(--c-info))',
  'rgb(var(--c-ok))',
  'rgb(var(--c-impt))',
  'rgb(var(--c-accent))'
] as const

interface LiveBubble {
  key: string
  kind: 'user' | 'speaker'
  agentId?: string
  text: string
  status: 'streaming' | 'done' | 'failed'
  error?: string
}

export function GroupChatView({
  session,
  memberMeta,
  onActivity
}: {
  session: ChatSession
  memberMeta: Map<string, GroupMemberMeta>
  onActivity: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const qc = useQueryClient()
  const sessionId = session.id
  const memberIds = useMemo(() => parseMembersJson(session.members_json), [session.members_json])
  const memberEntries = useMemo(
    () => memberIds.map((id) => ({ agentId: id, title: memberMeta.get(id)?.title?.trim() || id })),
    [memberIds, memberMeta]
  )
  const titleOfMember = (id: string): string => memberMeta.get(id)?.title?.trim() || id
  const colorOfMember = (id: string): string =>
    NAME_COLORS[Math.max(0, memberIds.indexOf(id)) % NAME_COLORS.length]

  const messagesQ = useQuery({
    queryKey: qk.chat.messages(sessionId),
    queryFn: () => mailApi.chat.listMessages(sessionId),
    staleTime: 5_000
  })
  const rows = useMemo(
    () =>
      (messagesQ.data ?? []).filter(
        (m) => (m.role === 'user' || m.role === 'assistant') && m.status === 'complete'
      ),
    [messagesQ.data]
  )

  const [live, setLive] = useState<LiveBubble[]>([])
  const [sending, setSending] = useState(false)
  const [draft, setDraft] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => () => abortRef.current?.abort(), [])

  const patchLive = (key: string, patch: Partial<LiveBubble>): void =>
    setLive((prev) => prev.map((b) => (b.key === key ? { ...b, ...patch } : b)))

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (text.length === 0 || sending || memberEntries.length === 0) return
    setSending(true)
    setDraft('')
    // 上一轮的失败气泡随新一轮开始清掉（不落库，仅本地）。
    setLive([])
    const controller = new AbortController()
    abortRef.current = controller
    const mentioned = parseGroupMentions(text, memberEntries)
    const targets = mentioned.length > 0 ? mentioned : memberIds
    const userKey = `user-${Date.now()}`
    setLive([{ key: userKey, kind: 'user', text, status: 'done' }])
    try {
      await appendGroupUserMessage(sessionId, text)
    } catch (err) {
      patchLive(userKey, { status: 'failed', error: errorMessage(err) })
      setSending(false)
      return
    }
    for (const target of targets) {
      const key = `spk-${Date.now()}-${target}`
      setLive((prev) => [
        ...prev,
        { key, kind: 'speaker', agentId: target, text: '', status: 'streaming' }
      ])
      try {
        await runGroupSpeaker({
          sessionId,
          speakAsAgentId: target,
          signal: controller.signal,
          onDelta: (delta) =>
            setLive((prev) => prev.map((b) => (b.key === key ? { ...b, text: b.text + delta } : b)))
        })
        patchLive(key, { status: 'done' })
      } catch (err) {
        if (controller.signal.aborted) {
          patchLive(key, { status: 'failed', error: errorMessage(err) })
          break
        }
        // 某成员失败 → 标失败，继续下一个成员（服务端不落这条，气泡仅本地留证）。
        patchLive(key, { status: 'failed', error: errorMessage(err) })
      }
    }
    // 落库 transcript 接管成功气泡；失败气泡保留（DB 里没有对应行）。
    await messagesQ.refetch()
    setLive((prev) => prev.filter((b) => b.status === 'failed'))
    onActivity()
    void qc.invalidateQueries({ queryKey: qk.chat.groupOriginSessions() })
    setSending(false)
  }

  // 自动滚底（消息/流式增量变化时）。
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [rows.length, live])

  // @ 补全弹层。
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null)
  const mentionCandidates = mention
    ? memberEntries.filter((m) => m.title.toLowerCase().includes(mention.query.toLowerCase()))
    : []
  const refreshMention = (value: string, caret: number | null): void =>
    setMention(caret == null ? null : detectMentionDraft(value, caret))
  const pickMention = (title: string): void => {
    if (!mention) return
    const caret = inputRef.current?.selectionStart ?? draft.length
    const next = `${draft.slice(0, mention.start)}@${title} ${draft.slice(caret)}`
    setDraft(next)
    setMention(null)
    inputRef.current?.focus()
  }

  const groupTitle = session.title ?? t('groupChat.defaultTitle')

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-group-chat={sessionId}>
      {/* 群头：标题 + 成员头像行。 */}
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-ink-border px-4">
        <span className="min-w-0 truncate text-body font-semibold text-ink-fg">{groupTitle}</span>
        <span className="flex shrink-0 items-center -space-x-1.5">
          {memberIds.map((id) => (
            <AgentAvatar
              key={id}
              agentId={id}
              config={memberMeta.get(id)?.avatar}
              size={20}
              title={titleOfMember(id)}
            />
          ))}
        </span>
        <span className="shrink-0 text-micro text-ink-fg-3">
          {t('groupChat.memberCount', { count: memberIds.length })}
        </span>
      </div>

      {/* 消息流。 */}
      <div ref={scrollRef} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {rows.length === 0 && live.length === 0 ? (
          <div className="px-6 py-10 text-center text-meta text-ink-fg-3">
            {t('groupChat.emptyThread')}
          </div>
        ) : (
          <div className="flex flex-col gap-3.5">
            {rows.map((m) => (
              <PersistedBubble
                key={m.id}
                message={m}
                titleOfMember={titleOfMember}
                colorOfMember={colorOfMember}
                memberMeta={memberMeta}
              />
            ))}
            {live.map((b) =>
              b.kind === 'user' ? (
                <UserBubble
                  key={b.key}
                  text={b.text}
                  failed={b.status === 'failed'}
                  error={b.error}
                  t={t}
                />
              ) : (
                <SpeakerBubble
                  key={b.key}
                  agentId={b.agentId as string}
                  name={titleOfMember(b.agentId as string)}
                  color={colorOfMember(b.agentId as string)}
                  avatar={memberMeta.get(b.agentId as string)?.avatar}
                  text={b.text}
                  streaming={b.status === 'streaming'}
                  failed={b.status === 'failed'}
                  error={b.error}
                  t={t}
                />
              )
            )}
          </div>
        )}
      </div>

      {/* 发送框（@ 补全弹层贴在上方）。 */}
      <div className="relative shrink-0 border-t border-ink-border px-4 py-3">
        {mention && mentionCandidates.length > 0 && (
          <div className="glass-pop absolute bottom-full left-4 z-10 mb-1 w-56 rounded-[var(--r-ctl)] border border-ink-border-soft p-1">
            {mentionCandidates.map((m) => (
              <button
                key={m.agentId}
                type="button"
                onClick={() => pickMention(m.title)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-aux text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3"
              >
                <AgentAvatar
                  agentId={m.agentId}
                  config={memberMeta.get(m.agentId)?.avatar}
                  size={20}
                  title={m.title}
                />
                <span className="min-w-0 flex-1 truncate">{m.title}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={draft}
            rows={1}
            placeholder={t('groupChat.composerPlaceholder')}
            onChange={(e) => {
              setDraft(e.target.value)
              refreshMention(e.target.value, e.target.selectionStart)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                setMention(null)
                void send()
              } else if (e.key === 'Escape') {
                setMention(null)
              }
            }}
            className={cn(
              'max-h-32 min-h-9 flex-1 resize-none rounded-lg border border-ink-border-soft bg-ink-2 px-3 py-2',
              'text-body text-ink-fg outline-none placeholder:text-ink-fg-3'
            )}
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || draft.trim().length === 0}
            aria-label={t('groupChat.send')}
            className={cn(
              'grid size-9 shrink-0 place-items-center rounded-lg text-white transition-opacity duration-fast',
              'disabled:opacity-40'
            )}
            style={{ background: 'rgb(var(--c-accent))' }}
          >
            <SendHorizontal size={15} strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  )
}

function PersistedBubble({
  message,
  titleOfMember,
  colorOfMember,
  memberMeta
}: {
  message: ChatMessage
  titleOfMember: (id: string) => string
  colorOfMember: (id: string) => string
  memberMeta: Map<string, GroupMemberMeta>
}): React.ReactElement {
  const { t } = useTranslation()
  if (message.role === 'user') {
    return <UserBubble text={message.content} failed={false} t={t} />
  }
  const speaker = message.speaker_agent_id ?? null
  return (
    <SpeakerBubble
      agentId={speaker ?? 'assistant'}
      name={speaker != null ? titleOfMember(speaker) : 'AI'}
      color={speaker != null ? colorOfMember(speaker) : 'rgb(var(--c-ai))'}
      avatar={speaker != null ? memberMeta.get(speaker)?.avatar : null}
      text={message.content}
      streaming={false}
      failed={false}
      t={t}
    />
  )
}

function SpeakerBubble({
  agentId,
  name,
  color,
  avatar,
  text,
  streaming,
  failed,
  error,
  t
}: {
  agentId: string
  name: string
  color: string
  avatar?: AgentAvatarConfig | null
  text: string
  streaming: boolean
  failed: boolean
  error?: string
  t: ReturnType<typeof useTranslation>['t']
}): React.ReactElement {
  return (
    <div className="flex max-w-[86%] items-start gap-2.5">
      <div className="shrink-0 pt-0.5">
        <AgentAvatar agentId={agentId} config={avatar} size={30} title={name} />
      </div>
      <div className="min-w-0">
        <div className="mb-0.5 text-micro font-semibold" style={{ color }}>
          {name}
        </div>
        <div
          className={cn(
            'whitespace-pre-wrap rounded-[4px_12px_12px_12px] bg-ink-3 px-3 py-2 text-body leading-relaxed text-ink-fg',
            failed && 'opacity-70'
          )}
        >
          {text.length > 0 ? (
            text
          ) : streaming ? (
            <span className="text-ink-fg-3">{t('groupChat.typing', { name })}</span>
          ) : null}
          {streaming && text.length > 0 && (
            <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse rounded-sm bg-ink-fg-3 align-middle" />
          )}
        </div>
        {failed && (
          <div className="mt-1 text-micro text-fail">
            {t('groupChat.speakerFailed', { error: error ?? 'unknown' })}
          </div>
        )}
      </div>
    </div>
  )
}

function UserBubble({
  text,
  failed,
  error,
  t
}: {
  text: string
  failed: boolean
  error?: string
  t: ReturnType<typeof useTranslation>['t']
}): React.ReactElement {
  return (
    <div className="flex flex-col items-end self-end">
      <div
        className="max-w-full whitespace-pre-wrap rounded-[12px_4px_12px_12px] px-3 py-2 text-body leading-relaxed text-ink-fg"
        style={{ backgroundImage: 'var(--sel-wash)' }}
      >
        {text}
      </div>
      {failed && (
        <div className="mt-1 text-micro text-fail">
          {t('groupChat.sendFailed', { error: error ?? 'unknown' })}
        </div>
      )}
    </div>
  )
}
