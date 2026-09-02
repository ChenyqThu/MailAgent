// L4 群聊 — 单个群聊会话的消息流 + 发送框（飞书/Slack 式）。
//
// 视觉基准（原型 .msg/.av/.who/.bub，色值换 v3 token）：成员消息 = AgentAvatar 30px 左置 +
// 彩色名字 + 左对齐气泡（圆角 4 12 12 12）；用户消息右对齐（sel-wash 底，圆角 12 4 12 12）。
// 名字色 = token 调色板按成员序取（不引新十六进制）。
//
// 驱动有两条，由 labs 开关 `labs_group_agents` 选（g1）：
//
//   labs OFF（v1，默认）—— 发送 = ① appendGroupUserMessage 落用户消息 → ② 目标成员串行
//   runGroupSpeaker（一个说完下一个说；流式增量喂本地 live 气泡）→ ③ refetch 落库
//   transcript、清掉成功的 live 气泡。有 @ → 只点名的成员回；无 @ → 全员按 members_json 序
//   各回一轮。某成员失败 → 该气泡标失败继续下一个（失败气泡不落库，保留在 live 区直到下一轮
//   发送）。**这条路径在 labs on 之后一字未动**（AC9：关掉开关就是 v1）。
//
//   labs ON —— 发送只把消息落进共享 transcript，谁回、回几轮由 gateway 的调度器决定（候选集 /
//   地板 / 台账全在服务端）。renderer 不再持有发言循环，改为：订阅 `chat:turn-persisted`
//   刷新（🔴 用返回的 disposer 清理）+ 30s `/api/ai/run/active` 兜底探针 + 一个停止按钮
//   （POST `/api/ai/run/stop`）。地板命中时服务端会写一条 `role='system'` 行，这里渲染成居中
//   灰字「已停止：<原因>」。

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { SendHorizontal, Settings, Square } from 'lucide-react'

import type { AgentAvatarConfig, ChatMessage, ChatSession } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { qk } from '@shared/lib/queryKeys'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useLabsFlags } from '@shared/hooks/useLabsFlags'
import { errorMessage } from '@shared/lib/ipcErrors'
import { toastError } from '@shared/state/toast'
import { appendGroupUserMessage, runGroupSpeaker } from '@shared/assistant/groupChatClient'
import { resolveAiGatewayBaseUrl } from '@shared/assistant/runtime/flags'

import { AgentAvatar } from '../AgentAvatar'
import { GroupSettingsDialog } from './GroupSettingsDialog'
import { detectMentionDraft, parseGroupMentions } from './mentions'
import { parseMembersJson, type GroupMemberMeta } from './members'

/** 兜底轮询节拍。Electron 有 `chat:turn-persisted` 广播 → 轮询纯属保险，取 30s
 *  （与 useBackgroundChatRun 的 ACTIVE_RUN_POLL_WITH_BROADCAST_MS 同一判据）。 */
const GROUP_RUN_POLL_MS = 30_000

/** 群里此刻有没有成员在发言（gateway 的 ActiveRunRegistry 真源）。够不着 / 非 200 → false
 *  （fail-closed：宁可不显示「正在发言」，也不显示一个编出来的状态）。 */
async function probeGroupRunActive(sessionId: number): Promise<boolean> {
  const baseUrl = resolveAiGatewayBaseUrl()
  if (!baseUrl) return false
  try {
    const res = await fetch(`${baseUrl}/api/ai/run/active?sessionId=${sessionId}`)
    if (!res.ok) return false
    const body = (await res.json()) as { active?: unknown }
    return body.active === true
  } catch {
    return false
  }
}

/** 停止本群这一轮（registry 中止当前 turn；调度器按 family 清队列并各写一条系统行）。 */
async function stopGroupRun(sessionId: number): Promise<void> {
  const baseUrl = resolveAiGatewayBaseUrl()
  if (!baseUrl) return
  const res = await fetch(`${baseUrl}/api/ai/run/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId })
  })
  if (!res.ok) throw new Error(`run/stop HTTP ${res.status}`)
}

/** 群停止系统行的原因词（`metadata={kind:'group_stop', reason, runId}`）。
 *  🔴 只放行 `kind==='group_stop'`：其他 system 行不属于群 transcript，宁可不渲染也不猜它是什么。 */
function groupStopReason(message: ChatMessage): string | null {
  if (message.role !== 'system' || message.metadata == null) return null
  try {
    const parsed = JSON.parse(message.metadata) as { kind?: unknown; reason?: unknown }
    if (parsed.kind !== 'group_stop') return null
    return typeof parsed.reason === 'string' && parsed.reason.length > 0 ? parsed.reason : 'error'
  } catch {
    return null
  }
}

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
        (m) =>
          m.status === 'complete' &&
          (m.role === 'user' || m.role === 'assistant' || groupStopReason(m) != null)
      ),
    [messagesQ.data]
  )

  const [live, setLive] = useState<LiveBubble[]>([])
  const [sending, setSending] = useState(false)
  const [draft, setDraft] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [stopping, setStopping] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => () => abortRef.current?.abort(), [])

  // ── labs on 的服务端编排模态 ─────────────────────────────────────────────────────
  const { groupAgents: labsOn } = useLabsFlags()

  const runActiveQ = useQuery({
    queryKey: qk.chat.groupRunActive(sessionId),
    queryFn: () => probeGroupRunActive(sessionId),
    enabled: labsOn,
    retry: false,
    refetchInterval: GROUP_RUN_POLL_MS
  })
  const speaking = labsOn && runActiveQ.data === true

  // 🔴 IPC 订阅必须用返回的 disposer 清理（useBackgroundChatRun.ts:32 同一纪律）；
  // onTurnPersisted 在 web（HttpApi）缺省 → `?.`，此时只剩 30s 轮询兜底。
  useEffect(() => {
    if (!labsOn) return undefined
    return mailApi.chat.onTurnPersisted?.((payload) => {
      if (payload.sessionId !== sessionId) return
      void qc.invalidateQueries({ queryKey: qk.chat.messages(sessionId) })
      void qc.invalidateQueries({ queryKey: qk.chat.groupRunActive(sessionId) })
      void qc.invalidateQueries({ queryKey: qk.chat.groupOriginSessions() })
    })
  }, [labsOn, mailApi, qc, sessionId])

  const patchLive = (key: string, patch: Partial<LiveBubble>): void =>
    setLive((prev) => prev.map((b) => (b.key === key ? { ...b, ...patch } : b)))

  const stop = async (): Promise<void> => {
    setStopping(true)
    try {
      await stopGroupRun(sessionId)
    } catch (err) {
      toastError(t('groupChat.stopFailed', { error: errorMessage(err) }))
    } finally {
      setStopping(false)
      void qc.invalidateQueries({ queryKey: qk.chat.groupRunActive(sessionId) })
    }
  }

  /** labs on 的发送：只落一条用户消息，之后由服务端调度器接管（renderer 无发言循环）。 */
  const sendOrchestrated = async (text: string): Promise<void> => {
    const userKey = `user-${Date.now()}`
    setLive([{ key: userKey, kind: 'user', text, status: 'done' }])
    try {
      await appendGroupUserMessage(sessionId, text)
    } catch (err) {
      patchLive(userKey, { status: 'failed', error: errorMessage(err) })
      setSending(false)
      return
    }
    await messagesQ.refetch()
    setLive((prev) => prev.filter((b) => b.status === 'failed'))
    onActivity()
    void qc.invalidateQueries({ queryKey: qk.chat.groupOriginSessions() })
    void qc.invalidateQueries({ queryKey: qk.chat.groupRunActive(sessionId) })
    setSending(false)
  }

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (text.length === 0 || sending || memberEntries.length === 0) return
    setSending(true)
    setDraft('')
    // 上一轮的失败气泡随新一轮开始清掉（不落库，仅本地）。
    setLive([])
    if (labsOn) {
      await sendOrchestrated(text)
      return
    }
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
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {speaking && (
            <>
              <span className="text-micro text-ink-fg-3">{t('groupChat.speaking')}</span>
              <button
                type="button"
                onClick={() => void stop()}
                disabled={stopping}
                aria-label={t('groupChat.stop')}
                className="grid size-7 place-items-center rounded-md text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg disabled:opacity-40"
              >
                <Square size={12} strokeWidth={2} fill="currentColor" />
              </button>
            </>
          )}
          {labsOn && (
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label={t('groupChat.settings.open')}
              className="grid size-7 place-items-center rounded-md text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
            >
              <Settings size={15} strokeWidth={2} />
            </button>
          )}
        </span>
      </div>

      {labsOn && (
        <GroupSettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          sessionId={sessionId}
          memberIds={memberIds}
          memberMeta={memberMeta}
        />
      )}

      {/* 消息流。 */}
      <div ref={scrollRef} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {rows.length === 0 && live.length === 0 ? (
          <div className="px-6 py-10 text-center text-meta text-ink-fg-3">
            {t('groupChat.emptyThread')}
          </div>
        ) : (
          <div className="flex flex-col gap-3.5">
            {rows.map((m) => {
              const stopped = groupStopReason(m)
              return stopped != null ? (
                <StoppedRow key={m.id} reason={stopped} t={t} />
              ) : (
                <PersistedBubble
                  key={m.id}
                  message={m}
                  titleOfMember={titleOfMember}
                  colorOfMember={colorOfMember}
                  memberMeta={memberMeta}
                />
              )
            })}
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

/** 地板命中时服务端写的 `role='system'` 行：居中灰字「已停止：<原因>」。
 *  原因词表单源 = groupFloors.ts 的 GROUP_STOP_REASONS；查不到 i18n 条目就显示原始词
 *  （宁可露出机器词，也不把一个新增的停止原因静默渲染成空白）。 */
function StoppedRow({
  reason,
  t
}: {
  reason: string
  t: ReturnType<typeof useTranslation>['t']
}): React.ReactElement {
  return (
    <div className="py-1 text-center text-micro text-ink-fg-3">
      {t('groupChat.stoppedPrefix', {
        reason: t(`groupChat.stopped.${reason}`, { defaultValue: reason })
      })}
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
