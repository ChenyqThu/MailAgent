// L4 群聊 — 单个群聊会话的编排：群头 / 消息流 / 发送框三件拆在 GroupHeader / GroupTranscript /
// GroupComposer，本文件只持有数据流与两条驱动的分派。
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
//   地板 / 台账全在服务端）。renderer 不持有发言循环，改为：订阅 `chat:group-turn`（在场态 /
//   流式正文 / 沉默 / 失败 / 停止，useGroupTurnEvents）+ `chat:turn-persisted` 刷新（🔴 用返回的
//   disposer 清理）+ `group-turns` 台账（刷新后还原 meta 行）+ `/api/ai/run/active` 三态探针
//   （runAlive 判据 = 事件三元组任一非空 ‖ 探针 active）+ 停止 / 重试两个动作。
//
// 🔴 labs 开关未到达时的发送**不**按 off 走 v1：send 先 `await labs.ready()` 再分派（发送钮不因
//    loading 禁用；design §4.6 / §10 Q11）。否则 loading 期间被当成 off 起本地循环、服务端又同时
//    编排 = 双跑。
//
// T3 话题：同一条管线跑两种会话。顶层群的主时间线多三件事 —— 拉话题清单（挂 threadCard）、hover
// 「开话题」（createGroupThread 幂等，建好就打开话题面）、前台上报二元组 `{groupId, threadId}`；
// `thread` 模式（话题面里挂的就是本组件，`session.id` = 话题 id）则换群头为「话题 + 关闭」、把根消息
// 挂在消息流上方、composer 的唤醒人数改按参与者算，且**不**上报前台（父群视图报二元组）、不再拉
// 话题清单（话题不能再开话题，单层嵌套）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Info } from 'lucide-react'

import type { ChatMessage, ChatSession } from '@shared/api/types'
import type { GroupAttachment, GroupThreadSummary } from '@shared/chat_model'
import { qk } from '@shared/lib/queryKeys'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useLabsFlags } from '@shared/hooks/useLabsFlags'
import { errorMessage } from '@shared/lib/ipcErrors'
import { toastError } from '@shared/state/toast'
import {
  appendGroupUserMessage,
  probeGroupRun,
  retryGroupTurn,
  runGroupSpeaker
} from '@shared/assistant/groupChatClient'
import { resolveAiGatewayBaseUrl } from '@shared/assistant/runtime/flags'
import {
  createGroupThread,
  getGroupConfig,
  getGroupTurns,
  listGroupThreads
} from '@shared/api/groupSettings'

import { parseAttachmentsMetadata } from '../../../../ai-gateway/groupAttachments'
import { AgentAvatar } from '../AgentAvatar'
import { GroupBubble } from './GroupBubble'
import { GroupComposer } from './GroupComposer'
import { GroupHeader } from './GroupHeader'
import type { RetryUiState } from './GroupMetaRow'
import { GroupTranscript, type GroupTranscriptEmpty } from './GroupTranscript'
import { absoluteTimeLabel, colorOfMember, previewPrefix } from './groupPresentation'
import { groupThreadsKey } from './groupThreads'
import { buildGroupTimeline, groupStopMeta, type GroupTimelineItem } from './groupTimeline'
import { parseGroupMentions } from './mentions'
import { parseMembersJson, type GroupMemberMeta } from './members'
import {
  useGroupTurnEvents,
  useNowTick,
  withSeed,
  type GroupLiveTriple
} from './useGroupTurnEvents'

/** 兜底轮询节拍。Electron 有 `chat:group-turn` / `chat:turn-persisted` 广播 → 轮询纯属保险，取 30s
 *  （与 useBackgroundChatRun 的 ACTIVE_RUN_POLL_WITH_BROADCAST_MS 同一判据），且只在最近 60s 内
 *  发过消息或收到过事件时才转。 */
const GROUP_RUN_POLL_MS = 30_000
const RECENT_ACTIVITY_MS = 60_000
const GROUP_TURNS_LIMIT = 200
/** 稳定引用：子群 / 话题面没有话题清单，每次 render 新造 `[]` 会让 threadRootIds 的 memo 失效。 */
const NO_THREADS: readonly GroupThreadSummary[] = []

/** T3 — 话题面模式的输入（GroupThreadPane 解析好再交进来）。 */
export interface GroupChatThreadMode {
  groupId: number
  summary: GroupThreadSummary
  /** 父群里的根消息行；父群消息未加载 / 根消息已清 → null，只显示摘要。 */
  rootMessage: ChatMessage | null
  onClose: () => void
  onViewInGroup: () => void
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

interface LiveBubble {
  key: string
  kind: 'user' | 'speaker'
  agentId?: string
  text: string
  status: 'streaming' | 'done' | 'failed'
  error?: string
}

type GroupMetaFailed = Extract<GroupTimelineItem, { kind: 'meta' }>

/** 重试 UI 态的存储形：「重试中」多记一个点击时刻，派生成 RetryUiState 时与最近事件时刻比较。 */
type RetryStore = Exclude<RetryUiState, { kind: 'retrying' }> | { kind: 'retrying'; at: number }

export function GroupChatView({
  session,
  memberMeta,
  onActivity,
  detailsOpen,
  onToggleDetails,
  initialLive,
  onSendingChange,
  activeThreadId,
  onOpenThread,
  thread
}: {
  session: ChatSession
  memberMeta: Map<string, GroupMemberMeta>
  onActivity: () => void
  /** 群详情面开合（Workspace 持有；缺省 = 不渲染详情钮）。 */
  detailsOpen?: boolean
  onToggleDetails?: () => void
  /** Workspace 的 useGroupLiveMap 给的在场三元组初值（事件未到前的兜底）。 */
  initialLive?: GroupLiveTriple | null
  /** labs off 的 v1 发送期间上抛，供列表「发言中」脉冲。 */
  onSendingChange?: (sending: boolean) => void
  /** T3 — 当前打开的话题（Workspace 持有），只用于前台上报的二元组；缺省 = 没开。 */
  activeThreadId?: number | null
  /** T3 — 打开某个话题面（hover「开话题」建好之后 / 点话题卡）。缺省 = 没有话题入口。 */
  onOpenThread?: (threadId: number) => void
  /** T3 — 话题面模式：本视图渲染的是话题会话（`session.id` = 话题 id）。 */
  thread?: GroupChatThreadMode
}): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const qc = useQueryClient()
  const sessionId = session.id
  const isThread = thread != null
  const threadGroupId = thread?.groupId ?? null
  // 只有顶层群能开话题（单层嵌套：子群 / 话题里都不渲染入口，服务端同判据 400 兜底）。
  const canThread = !isThread && (session.parent_session_id ?? null) == null
  const memberIds = useMemo(() => parseMembersJson(session.members_json), [session.members_json])
  const memberEntries = useMemo(
    () =>
      memberIds.map((id) => ({
        agentId: id,
        title: memberMeta.get(id)?.title?.trim() || id,
        avatar: memberMeta.get(id)?.avatar
      })),
    [memberIds, memberMeta]
  )
  const nowMs = useNowTick()
  // 🔴 判据是真值不是 `!= null`：web 构建下 resolveAiGatewayBaseUrl 返回空串（GroupChatWorkspace 同注）。
  const hasGateway = useMemo(() => Boolean(resolveAiGatewayBaseUrl()), [])

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
          (m.role === 'user' || m.role === 'assistant' || groupStopMeta(m) != null)
      ),
    [messagesQ.data]
  )
  const earliestCreatedAt = useMemo(
    () =>
      rows.reduce<number | null>(
        (acc, m) =>
          m.role !== 'system' && (acc == null || m.created_at < acc) ? m.created_at : acc,
        null
      ),
    [rows]
  )

  const [live, setLive] = useState<LiveBubble[]>([])
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [lastSentAt, setLastSentAt] = useState<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => () => abortRef.current?.abort(), [])
  useEffect(() => {
    onSendingChange?.(sending)
  }, [sending, onSendingChange])

  // ── labs on 的服务端编排模态 ─────────────────────────────────────────────────────
  const labs = useLabsFlags()
  const labsOn = labs.groupAgents

  const { live: liveEvents, dispatch } = useGroupTurnEvents(sessionId, labsOn, initialLive)

  const recentActivity =
    (liveEvents.lastEventAt != null && nowMs - liveEvents.lastEventAt < RECENT_ACTIVITY_MS) ||
    (lastSentAt != null && nowMs - lastSentAt < RECENT_ACTIVITY_MS)
  const probeQ = useQuery({
    queryKey: qk.chat.groupRunActive(sessionId),
    queryFn: () => probeGroupRun(sessionId),
    enabled: labsOn && hasGateway,
    retry: false,
    refetchInterval: recentActivity ? GROUP_RUN_POLL_MS : false
  })
  // 事件未到前用探针的三元组兜底（刷新 / 重开群时的初值）。
  const liveView = useMemo(
    () => withSeed(liveEvents, probeQ.data?.group ?? null),
    [liveEvents, probeQ.data]
  )
  const runAlive =
    labsOn &&
    (liveView.inFlight != null ||
      liveView.preparing != null ||
      liveView.queued.length > 0 ||
      probeQ.data?.state === 'active')
  const gatewayState: 'ok' | 'web' | 'unreachable' = !hasGateway
    ? 'web'
    : probeQ.data?.state === 'unreachable'
      ? 'unreachable'
      : 'ok'

  // 话题里响应模式不生效（参与者制，design §4.4），群配置不拉：拉了也只会把 realtime 成员画成
  // 「会自动回复」，而话题里他们不会。
  const configQ = useQuery({
    queryKey: qk.chat.groupConfig(sessionId),
    queryFn: () => getGroupConfig(sessionId),
    enabled: labsOn && !isThread,
    staleTime: 30_000
  })
  const modes = labsOn && !isThread ? (configQ.data?.modes ?? null) : null
  const topic = configQ.data?.config.topic?.trim() || null
  // 话题的参与者 = 根消息说话人 ∪ 话题里已发过言的成员（gateway 的候选集判据，这里只为「将唤醒
  // N 位」与群头的头像行算同一份事实；人发的根消息说话人为 null，不计）。
  const rootSpeakerId = thread?.rootMessage?.speaker_agent_id ?? null
  const participantIds = useMemo(() => {
    if (!isThread) return memberIds
    const ids = new Set<string>()
    if (rootSpeakerId != null) ids.add(rootSpeakerId)
    for (const m of messagesQ.data ?? []) {
      if (m.role === 'assistant' && m.speaker_agent_id != null) ids.add(m.speaker_agent_id)
    }
    return [...ids]
  }, [isThread, memberIds, rootSpeakerId, messagesQ.data])
  const realtimeCount = isThread
    ? participantIds.length
    : modes != null
      ? memberIds.filter((id) => modes[id] === 'realtime').length
      : null

  // T3 — 话题清单：只有顶层群拉；key 有意不挂 allSessions 前缀（话题一动不该连带重拉群列表）。
  const threadsQ = useQuery({
    queryKey: groupThreadsKey(sessionId),
    queryFn: () => listGroupThreads(sessionId),
    enabled: canThread,
    staleTime: 5_000
  })
  const threads = canThread ? (threadsQ.data ?? NO_THREADS) : NO_THREADS
  const threadRootIds = useMemo(() => new Set(threads.map((th) => th.rootMessageId)), [threads])
  // turn-persisted 的分派要认「这条是不是本群某个话题的」；用 ref 免得清单一变就重订阅。
  const threadIdsRef = useRef<ReadonlySet<number>>(new Set())
  useEffect(() => {
    threadIdsRef.current = new Set(threads.map((th) => th.sessionId))
  }, [threads])
  const onOpenThreadRef = useRef(onOpenThread)
  useEffect(() => {
    onOpenThreadRef.current = onOpenThread
  }, [onOpenThread])
  // 幂等：同一条根重复点返回已有话题（serve-api 契约），所以「开」与「进」是同一个动作。
  // 🔴 引用稳定：它经 GroupTranscript 落到每个 memo 的 GroupMessageGroup 上，流式 delta 期间
  // 每帧换一个新函数就等于把整条时间线的 memo 全废了。
  const createThread = useCallback(
    async (messageId: number): Promise<void> => {
      try {
        const created = await createGroupThread(sessionId, messageId)
        await qc.invalidateQueries({ queryKey: groupThreadsKey(sessionId) })
        onOpenThreadRef.current?.(created.sessionId)
      } catch (err) {
        toastError(errorMessage(err))
      }
    },
    [sessionId, qc]
  )

  // 台账：since = 最早一条落库消息（无消息 → 不请求；清空历史后旧 meta 行随之退出对话）。
  const turnsQ = useQuery({
    queryKey: qk.chat.groupTurns(sessionId),
    queryFn: () =>
      getGroupTurns(sessionId, { limit: GROUP_TURNS_LIMIT, since: earliestCreatedAt ?? undefined }),
    enabled: labsOn && earliestCreatedAt != null,
    staleTime: 5_000
  })
  // since 不进 key（同群一份缓存）→ 最早消息变了要主动失效。
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: qk.chat.groupTurns(sessionId) })
  }, [qc, sessionId, earliestCreatedAt])

  // 🔴 IPC 订阅必须用返回的 disposer 清理（useBackgroundChatRun.ts:32 同一纪律）；
  // onTurnPersisted 在 web（HttpApi）缺省 → `?.`，此时只剩探针兜底。
  useEffect(() => {
    if (!labsOn) return undefined
    return mailApi.chat.onTurnPersisted?.((payload) => {
      // 本群某个话题里落了一条：只刷话题卡（回复数 / 最新 / 未读）与群列表的 has_unread_threads，
      // 主时间线不动 —— 话题回复不在这条会话里。
      if (threadIdsRef.current.has(payload.sessionId)) {
        void qc.invalidateQueries({ queryKey: groupThreadsKey(sessionId) })
        void qc.invalidateQueries({ queryKey: qk.chat.groupOriginSessions() })
        return
      }
      if (payload.sessionId !== sessionId) return
      void qc.refetchQueries({ queryKey: qk.chat.messages(sessionId) }).then(() => {
        const data = qc.getQueryData<ChatMessage[]>(qk.chat.messages(sessionId))
        if (data != null) {
          dispatch({ type: 'persisted', messageIds: new Set(data.map((m) => m.id)) })
        }
      })
      void qc.invalidateQueries({ queryKey: qk.chat.groupTurns(sessionId) })
      void qc.invalidateQueries({ queryKey: qk.chat.groupRunActive(sessionId) })
      void qc.invalidateQueries({ queryKey: qk.chat.groupOriginSessions() })
    })
  }, [labsOn, mailApi, qc, sessionId, dispatch])

  // 选中即已读（话题面打开即已读同一条）；话题读过还要刷父群的话题卡（unread 点）。
  useEffect(() => {
    void mailApi.chat.markSessionRead(sessionId).then(() => {
      void qc.invalidateQueries({ queryKey: qk.chat.groupOriginSessions() })
      if (threadGroupId != null) {
        void qc.invalidateQueries({ queryKey: groupThreadsKey(threadGroupId) })
      }
    })
  }, [mailApi, qc, sessionId, threadGroupId])
  // 告诉 main 前台是哪个群 + 哪个话题（通知投影据此跳过），卸载 / 切群上报 null。
  // 🔴 只有群视图报：话题面自己不报，否则两处 effect 互相覆盖、关话题面还会把群一并报成 null。
  useEffect(() => {
    if (isThread) return undefined
    void mailApi.chat.setGroupForeground?.({ groupId: sessionId, threadId: activeThreadId ?? null })
    return () => {
      void mailApi.chat.setGroupForeground?.(null)
    }
  }, [mailApi, sessionId, isThread, activeThreadId])

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

  // 失败行重试：按 item.key 记 UI 态；「重试中」持续到点击之后的第一条事件到达（requeue 会发 queued）。
  const [retryStates, setRetryStates] = useState<Map<string, RetryStore>>(() => new Map())
  const setRetryState = (key: string, state: RetryStore): void =>
    setRetryStates((prev) => new Map(prev).set(key, state))
  const retry = async (item: GroupMetaFailed): Promise<void> => {
    setRetryState(item.key, { kind: 'retrying', at: Date.now() })
    try {
      await retryGroupTurn(sessionId, item.agentId, item.chainId)
    } catch (err) {
      const code = (err as { code?: unknown }).code
      if (code === 'E_RUN_STOPPED') setRetryState(item.key, { kind: 'stopped' })
      else if (code === 'E_LABS_ORCHESTRATED') setRetryState(item.key, { kind: 'labsOff' })
      else setRetryState(item.key, { kind: 'error', message: errorMessage(err) })
    }
  }
  const retryUiStates = useMemo(() => {
    const out = new Map<string, RetryUiState>()
    for (const [key, state] of retryStates) {
      if (state.kind === 'retrying') {
        const resolved = liveEvents.lastEventAt != null && liveEvents.lastEventAt >= state.at
        out.set(key, resolved ? { kind: 'idle' } : { kind: 'retrying' })
      } else {
        out.set(key, state)
      }
    }
    return out
  }, [retryStates, liveEvents.lastEventAt])

  /** labs on 的发送：只落一条用户消息，之后由服务端调度器接管（renderer 无发言循环）。 */
  const sendOrchestrated = async (
    text: string,
    attachments: readonly GroupAttachment[]
  ): Promise<void> => {
    const userKey = `user-${Date.now()}`
    setLive([{ key: userKey, kind: 'user', text, status: 'done' }])
    setLastSentAt(Date.now())
    try {
      await appendGroupUserMessage(sessionId, text, attachments)
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

  /** 两条路径共用的发送入口：正文由 GroupComposer trim 好，附件已由它读出（图片 text=null），
   *  随 append 的 body 落进该行 metadata（T2 落法 β）。 */
  const send = async (text: string, attachments: readonly GroupAttachment[]): Promise<void> => {
    if (text.length === 0 || sending || memberEntries.length === 0) return
    setSending(true)
    // 上一轮的失败气泡随新一轮开始清掉（不落库，仅本地）。
    setLive([])
    if (await labs.ready()) {
      await sendOrchestrated(text, attachments)
      return
    }
    const controller = new AbortController()
    abortRef.current = controller
    const mentioned = parseGroupMentions(text, memberEntries)
    const targets = mentioned.length > 0 ? mentioned : memberIds
    const userKey = `user-${Date.now()}`
    setLive([{ key: userKey, kind: 'user', text, status: 'done' }])
    try {
      await appendGroupUserMessage(sessionId, text, attachments)
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

  // 本地气泡恒在落库行之后：ts 取当前分钟节拍 + 序号（只影响日期分隔与「刚刚」）。
  const localBubbles = useMemo(() => live.map((b, i) => ({ ...b, ts: nowMs + i })), [live, nowMs])
  const timeline = useMemo(
    () =>
      buildGroupTimeline({
        messages: messagesQ.data ?? [],
        turns: labsOn && turnsQ.data != null ? turnsQ.data.turns : null,
        turnsHasMore: turnsQ.data?.hasMore ?? false,
        live: labsOn ? liveView : null,
        local: localBubbles,
        threads
      }),
    [messagesQ.data, labsOn, turnsQ.data, liveView, localBubbles, threads]
  )

  // 落库 user 行的附件（metadata.attachments → 气泡下的 chip）。本地气泡不带 chip：两条路径都在
  // append 后 refetch，落库行接管时 chip 随之出现。
  const attachmentsById = useMemo(() => {
    const out = new Map<number, readonly GroupAttachment[]>()
    for (const m of messagesQ.data ?? []) {
      if (m.role !== 'user') continue
      const attachments = parseAttachmentsMetadata(m.metadata)
      if (attachments != null) out.set(m.id, attachments)
    }
    return out
  }, [messagesQ.data])

  const emptyVariant: GroupTranscriptEmpty = isThread
    ? 'thread'
    : !labsOn
      ? 'v1'
      : realtimeCount === 0
        ? 'noRealtime'
        : 'orchestrated'
  const showChain =
    runAlive ||
    (liveEvents.lastEventAt != null && nowMs - liveEvents.lastEventAt < RECENT_ACTIVITY_MS)
  const onStop = (): void => {
    if (labsOn) void stop()
    else abortRef.current?.abort()
  }

  const groupTitle = session.title ?? t('groupChat.defaultTitle')
  const titleOf = (id: string): string => memberMeta.get(id)?.title?.trim() || id
  const root = thread?.rootMessage ?? null

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-group-chat={isThread ? undefined : sessionId}
      data-group-thread={isThread ? sessionId : undefined}
      data-group-mode={labs.loading ? undefined : labsOn ? 'orchestrated' : 'v1'}
    >
      <GroupHeader
        // 话题面：「话题」+ 摘要作副标题、头像行只画参与者、无详情钮、多一个关闭钮；停止钮照旧。
        title={isThread ? t('groupChat.thread.paneTitle') : groupTitle}
        topic={isThread ? thread.summary.title || null : labsOn ? topic : null}
        memberIds={participantIds}
        memberMeta={memberMeta}
        inFlight={labsOn ? (liveView.inFlight?.agentId ?? null) : null}
        queued={labsOn ? liveView.queued : []}
        chainProgress={labsOn ? liveEvents.chainProgress : null}
        showChain={labsOn && showChain}
        runAlive={labsOn ? runAlive : sending}
        stopping={stopping}
        onStop={onStop}
        detailsOpen={isThread ? undefined : detailsOpen}
        onToggleDetails={isThread ? undefined : onToggleDetails}
        onClose={thread?.onClose}
      />

      {thread != null && (
        // 根消息原样挂在消息流上方（它在父群里，不在话题会话里），带「在群里查看」回跳。
        <div
          className="flex shrink-0 flex-col gap-1.5 border-b border-ink-border px-4 py-3"
          data-thread-root={thread.summary.rootMessageId}
        >
          {root != null ? (
            <div className="flex items-start gap-2.5">
              {rootSpeakerId != null && (
                <div className="shrink-0 pt-0.5">
                  <AgentAvatar
                    agentId={rootSpeakerId}
                    config={memberMeta.get(rootSpeakerId)?.avatar}
                    size={24}
                    title={titleOf(rootSpeakerId)}
                  />
                </div>
              )}
              <div className="flex min-w-0 flex-col items-start">
                <div
                  data-time={absoluteTimeLabel(root.created_at)}
                  className="mb-0.5 text-micro font-semibold after:ml-1.5 after:font-normal after:tabular-nums after:text-ink-fg-3 after:content-[attr(data-time)] after:text-meta"
                  style={{
                    color:
                      rootSpeakerId != null
                        ? colorOfMember(memberIds, rootSpeakerId)
                        : 'rgb(var(--ink-fg-1))'
                  }}
                >
                  {previewPrefix(
                    {
                      role: root.role === 'user' ? 'user' : 'assistant',
                      speaker_agent_id: rootSpeakerId,
                      via: null
                    },
                    titleOf,
                    t
                  )}
                </div>
                <GroupBubble
                  text={root.content}
                  streaming={false}
                  variant={root.role === 'user' ? 'user' : 'member'}
                  members={memberEntries}
                  memberIds={memberIds}
                  usage={null}
                  attachments={
                    root.role === 'user' ? parseAttachmentsMetadata(root.metadata) : null
                  }
                />
              </div>
            </div>
          ) : (
            <div className="text-meta text-ink-fg-2">{thread.summary.title}</div>
          )}
          <button
            type="button"
            onClick={thread.onViewInGroup}
            className="self-start text-aux text-ink-fg-1 underline-offset-2 hover:underline"
          >
            {t('groupChat.thread.viewInGroup')}
          </button>
        </div>
      )}

      {gatewayState !== 'ok' && (
        <div className="flex shrink-0 items-center gap-2 border-b border-ink-border bg-ink-2 px-4 py-1.5 text-meta text-ink-fg-2">
          <Info size={13} strokeWidth={2} className="shrink-0" />
          <span>
            {t(
              gatewayState === 'web' ? 'groupChat.gatewayWebOnly' : 'groupChat.gatewayUnreachable'
            )}
          </span>
        </div>
      )}

      <GroupTranscript
        items={timeline.items}
        tail={timeline.tail}
        memberIds={memberIds}
        memberMeta={memberMeta}
        members={memberEntries}
        now={nowMs}
        loading={messagesQ.isLoading}
        error={messagesQ.isError ? errorMessage(messagesQ.error) : null}
        onRetryLoad={() => void messagesQ.refetch()}
        empty={emptyVariant}
        retryStates={retryUiStates}
        onRetry={(item) => void retry(item)}
        onOpenDetails={isThread ? undefined : onToggleDetails}
        attachmentsById={attachmentsById}
        // 在场态的 stalled / error 两支要的事实（turn 留痕 + 最近事件时刻）。labs off 没有事件源
        // → null，在场行只能走 idle（不是「没失败过」，是「不知道」）。
        live={labsOn ? liveView : null}
        onOpenThread={onOpenThread}
        onCreateThread={canThread ? createThread : undefined}
        threadRootIds={threadRootIds}
      />

      <GroupComposer
        onSend={send}
        sending={sending}
        disabled={gatewayState !== 'ok' || memberEntries.length === 0}
        members={memberEntries}
        modes={modes}
        labsOn={labsOn}
        labsLoading={labs.loading}
        realtimeCount={realtimeCount}
        runAlive={runAlive}
      />
    </div>
  )
}
