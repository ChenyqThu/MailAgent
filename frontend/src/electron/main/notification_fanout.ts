// task 08-20-notification-center M2 批 B4 — 通知中心的 Electron main 侧两件套。
//
// ① publishNotificationToCenter — main 侧信源（updater 更新就绪 / chat run 完成）的
//    loopback 发布入口：POST /api/notifications/publish（verify_local_token 单腿，
//    body **snake_case**）。serve-api 未起 / 重启窗口 → 失败即丢、只 log 不重试
//    （implement.md 风险清单 4 的写实边界；updater 侧靠 update-downloaded 再触发 +
//    服务端 dedupe 吸收实现补发）。
//
// ② registerNotificationFanout — macOS 原生通知 fanout（owner 拍板的 M2 0 号项，
//    删灵动岛的前置补位，docs/plans/remove-ping-island/README.md §5）。订阅 SSE
//    `notification.changed` —— 🔴 该事件按防回加闸不带行 id / 内容（payload data
//    键集 ⊆ {category}），所以收到后 debounce 合并连发，再拉未读列表补内容。
//    只弹 `severity==='critical' || category==='action_required'` 的条目（App 在
//    后台也该被打断的档）；其余类目铃铛徽标已呈现，不上系统通知。
//    水位（防重启轰炸）：模块内存 lastEventAt 游标，注册时刻初始化 —— 启动前的
//    存量未读**不弹**；只弹水位之后的新事件，弹后推进水位；(id, recurrenceNo)
//    seen set 防同轮重弹。不判 App 前台（macOS 自行降噪）；全吞异常，绝不影响
//    SSE 桥的其他消费者。

import { BrowserWindow, ipcMain, Notification, shell } from 'electron'

import { DEFAULT_API_PORT } from '@shared/lib/ports'
import { onSseEvent } from './events_bridge'
import { getLocalApiToken, LOCAL_TOKEN_HEADER } from './local_token'

export type NotificationChannelMode = 'banner' | 'both' | 'system_only' | 'center_only' | 'off'

export type NotificationChannelPrefs = Partial<Record<string, NotificationChannelMode>>

export type MacAuthState = 'unknown' | 'prompted' | 'delivered' | 'unsupported'

export interface NotificationAuthMeta {
  notificationAuthState?: 'unknown' | 'prompted' | 'delivered'
  notificationLastTestedAt?: number | null
}

export interface RegisterNotificationFanoutOptions {
  getChannelPrefs?: () => NotificationChannelPrefs | undefined
  getSuppressWhenFocused?: () => boolean | undefined
  ensureMainWindow?: () => Promise<BrowserWindow | null> | BrowserWindow | null
}

export interface RegisterNotificationSystemHandlersOptions {
  getAuthMeta?: () => NotificationAuthMeta
  saveAuthMeta?: (meta: {
    notificationAuthState: 'unknown' | 'prompted' | 'delivered'
    notificationLastTestedAt: number
  }) => void
  ensureMainWindow?: () => Promise<BrowserWindow | null> | BrowserWindow | null
}

// ---- loopback 基座 --------------------------------------------------------

function resolveApiBaseUrl(): string {
  const raw = process.env.MAILAGENT_API_PORT
  const parsed = raw == null ? Number.NaN : Number.parseInt(raw, 10)
  const port = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_API_PORT
  return `http://127.0.0.1:${port}/api`
}

// ---- ① internal publish face ---------------------------------------------

export interface NotifyCenterPublishInput {
  category: string
  source: string
  title: string
  /** 服务端 dedupe 键：活跃同 key 再发 = 计次 +1、未读化、severity 只升不降。 */
  dedupeKey: string
  body?: string
  severity?: string
  payload?: Record<string, unknown> | null
}

/**
 * Loopback 发布一条持久化通知。**永不 reject**：失败（连接拒绝 / 非 2xx）只
 * console.warn 后丢弃 —— 通知路径绝不影响触发它的业务动作（run_worker 挂点同款
 * 纪律），也不做重试队列（写实边界，见文件头注）。
 */
export async function publishNotificationToCenter(input: NotifyCenterPublishInput): Promise<void> {
  try {
    const res = await fetch(`${resolveApiBaseUrl()}/notifications/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [LOCAL_TOKEN_HEADER]: getLocalApiToken()
      },
      // 🔴 body snake_case（notifications.py::NotificationPublishRequest 契约）。
      body: JSON.stringify({
        category: input.category,
        source: input.source,
        severity: input.severity ?? 'info',
        title: input.title,
        body: input.body ?? '',
        dedupe_key: input.dedupeKey,
        payload: input.payload ?? null
      })
    })
    if (!res.ok) {
      console.warn(
        `[notify-center] publish dropped (HTTP ${res.status}) dedupe_key=${input.dedupeKey}`
      )
    }
  } catch (err) {
    console.warn(`[notify-center] publish dropped dedupe_key=${input.dedupeKey}`, err)
  }
}

// ---- ①b chat run 完成 → 通知中心（design §7 末行；调用点 ai_gateway_lifecycle
// ---- persistTurn 的 broadcast 之后） --------------------------------------

/** `PersistTurnInput` 的本模块消费子集（结构型 —— 不 import ai-gateway/config，
 *  避免把 gateway 模块图拖进本叶子模块与它的单测）。 */
export interface ChatRunTurnRef {
  sessionId: number | null
  runId?: string | null
  /** 落库那一刻客户端已断开 = detached run 在后台跑完（gateway 的 handleChat clientGone
   *  经 makePersistOnFinish 求值，见 PersistTurnInput.detached）。 */
  detached?: boolean
}

/** `ChatSession`（@shared/chat_model）的本模块消费子集。 */
export interface ChatSessionRef {
  title: string | null
  origin?: string | null
}

/**
 * chat run 完成的通知中心双写判定 + 发布。
 *
 * 🔴 骚扰面红线：`chat:turn-persisted` 每次 turn persist 都广播，照字面接会把每条手动
 * 对话都变成通知。判据只有一个：**`turn.detached === true`** —— 落库那一刻客户端已断开，
 * 即用户切走会话 / 关了面板而 run 在后台跑完（M3 C3 起 gateway 的 handleChat clientGone
 * 经 makePersistOnFinish 的 getter 穿进 PersistTurnInput）。用户盯着面板看完的回合
 * detached 恒 false，不发。
 *
 * 🔴 `MAILAGENT_CHAT_DETACHED_RUNS` 关闭时 `clientGone` 根本不武装、且信号与 detached 相与
 * ⇒ `turn.detached` 恒 false ⇒ 本挂点恒不发。语义正确：flag off 时客户端断开即 abort 掉
 * 这一回合，压根没有「后台完成」这回事。
 *
 * 🔴 再收一档（宁可少发不可多发）：origin='agent' 的会话（custom agent 定时/邮件触发、
 * matter followup、custom_agent_call 子会话）终态已由 Python run_worker 的 M1 通知信源
 * 覆盖（`agent_run:{job_id}` / `agent_run_failed:{agent_id}` / matter 失败键，
 * run_worker.py::_announce_terminal），这里再发 = 每个 run 双条 ⇒ 排除。
 *
 * dedupe 键 = `chat_run:{sessionId}:{runId}`（design §7）；无 lease 的 persist 退化为
 * `chat_session:{sessionId}:finished`（同一会话的多次后台完成合并计次）。
 *
 * `getSessionById` 由调用点注入（lifecycle 传 chat_db.getSession）——判定留在本
 * 叶子模块可单测，不把 better-sqlite3 图拖进来。永不 throw。
 */
export function maybeNotifyChatRunFinished(
  turn: ChatRunTurnRef,
  getSessionById: (sessionId: number) => ChatSessionRef | null
): void {
  try {
    if (turn.sessionId == null || turn.detached !== true) return
    const session = getSessionById(turn.sessionId)
    if (session?.origin === 'agent') return
    const sessionTitle = typeof session?.title === 'string' ? session.title.trim() : ''
    const runId = typeof turn.runId === 'string' && turn.runId.length > 0 ? turn.runId : null
    void publishNotificationToCenter({
      category: 'results',
      source: 'chat_run',
      severity: 'info',
      title: sessionTitle.length > 0 ? sessionTitle : 'AI 对话完成',
      body: 'AI 已在后台完成回复。',
      dedupeKey:
        runId != null
          ? `chat_run:${turn.sessionId}:${runId}`
          : `chat_session:${turn.sessionId}:finished`,
      payload: { link: { type: 'session', sessionId: turn.sessionId } }
    })
  } catch (err) {
    // 通知路径绝不影响已落库的 persist（run_worker.py:157-160 同款纪律）。
    console.warn('[ai-gateway] chat-run notification skipped (persist landed OK)', err)
  }
}

// ---- ①c 群聊成员回复 → 通知中心（L4 群聊 UX 批；调用点 ai_gateway_lifecycle
// ---- appendGroupMessage 的 broadcast 之后） ---------------------------------

/** `appendGroupMessage` 入参的本模块消费子集。 */
export interface GroupReplyRef {
  sessionId: number
  role: string
  content: string
  speakerAgentId: string | null
  chainId: number | null
}

/** `ChatSession` 的本模块消费子集（group_config_json 只读 `notify` 一键；T3 再读两列判话题）。 */
export interface GroupSessionRef extends ChatSessionRef {
  group_config_json?: string | null
  /** T3 — 话题判据恒是 `invoked_by === 'thread'`（不是 thread_root_message_id 非空）。 */
  invoked_by?: string | null
  /** T3 — 话题的父群 id（通知的标题 / notify 开关 / 深链都以父群为准）。 */
  parent_session_id?: number | null
}

/** 通知正文里成员回复的截取长度。 */
const GROUP_REPLY_BODY_CHARS = 80

/** T3 — 话题标题空（根消息无正文）时通知正文里的占位。 */
const THREAD_TITLE_FALLBACK = '未命名话题'

/** `group_config_json.notify`：只有显式 false 才关（缺列 / 坏 JSON / 缺键 = 开）。 */
function groupNotifyEnabled(raw: string | null | undefined): boolean {
  if (typeof raw !== 'string' || raw.length === 0) return true
  try {
    const parsed = JSON.parse(raw) as { notify?: unknown } | null
    return parsed?.notify !== false
  } catch {
    return true
  }
}

/**
 * 群聊成员回复的通知中心投影。判据三条：`role==='assistant'`（owner 自己的消息 / group_stop
 * 系统行不发）、`config.notify !== false`（群级开关）、群**不在前台**（renderer 经
 * `chat:group-foreground` 上报的群 id + 窗口有焦点；未上报过 = 不在前台 → 发）。
 *
 * dedupe 键 = `group_chain:{sessionId}:{chainId}`：同链后续回复命中同 key → 服务端计次，
 * 一条链一条通知；v1（labs off）路径无 chain_id → 退化为 `group_chain:{sessionId}:null`
 * = 每群一条活跃通知合并。深链是新型 `{type:'group'}`（`session` 型会落到主 agent 会话面）。
 *
 * T3 话题分支（父 design §4.8）：session 是话题（`invoked_by==='thread'` 且有父群）→
 * `source='group_thread'`、标题 = **父群**名、正文 = 「话题：<标题> · <说话人>：<摘要>」、
 * dedupe `group_thread:{groupId}:{threadId}`（一个话题一条活跃通知）、深链 `{type:'thread',
 * groupId, threadId}`。群级 `notify` 开关**只读父群**配置（话题复制的那份会随父群改动而过期）。
 * 前台抑制是二元组 `(groupId, threadId|null)`：群主线回复问 (群, null)，话题回复问 (父群, 话题)。
 *
 * `resolveSpeakerTitle` 由调用点注入（lifecycle 传 report_agent 读），失败回落 agent id。
 * 永不 throw。
 */
export function maybeNotifyGroupReply(
  reply: GroupReplyRef,
  getSessionById: (sessionId: number) => GroupSessionRef | null,
  isForeground: (groupId: number, threadId: number | null) => boolean,
  resolveSpeakerTitle?: (agentId: string) => Promise<string | null> | string | null
): void {
  try {
    if (reply.role !== 'assistant') return
    const session = getSessionById(reply.sessionId)
    const parentId = session?.parent_session_id
    const isThread = session?.invoked_by === 'thread' && typeof parentId === 'number'
    // 话题以父群为准：标题 / notify 开关 / 深链的群 id 都读父群那一行。
    const group = isThread ? getSessionById(parentId) : session
    const groupId = isThread ? parentId : reply.sessionId
    const threadId = isThread ? reply.sessionId : null
    if (!groupNotifyEnabled(group?.group_config_json)) return
    if (isForeground(groupId, threadId)) return
    const groupTitle = typeof group?.title === 'string' ? group.title.trim() : ''
    const threadTitle = typeof session?.title === 'string' ? session.title.trim() : ''
    const speakerId = reply.speakerAgentId
    void (async () => {
      let speaker = speakerId ?? ''
      if (speakerId != null && resolveSpeakerTitle) {
        try {
          const title = await resolveSpeakerTitle(speakerId)
          if (typeof title === 'string' && title.trim().length > 0) speaker = title.trim()
        } catch {
          /* 标题只是装饰，回落 id */
        }
      }
      const excerpt = reply.content.trim().slice(0, GROUP_REPLY_BODY_CHARS)
      const line = speaker.length > 0 ? `${speaker}：${excerpt}` : excerpt
      await publishNotificationToCenter({
        category: 'results',
        source: isThread ? 'group_thread' : 'group_chat',
        severity: 'info',
        title: groupTitle.length > 0 ? groupTitle : '群聊',
        body: isThread
          ? `话题：${threadTitle.length > 0 ? threadTitle : THREAD_TITLE_FALLBACK} · ${line}`
          : line,
        dedupeKey: isThread
          ? `group_thread:${groupId}:${threadId}`
          : `group_chain:${reply.sessionId}:${reply.chainId}`,
        payload: {
          link: isThread
            ? { type: 'thread', groupId, threadId }
            : { type: 'group', sessionId: reply.sessionId }
        }
      })
    })()
  } catch (err) {
    console.warn('[ai-gateway] group-reply notification skipped (append landed OK)', err)
  }
}

// ---- ② macOS 原生通知 fanout ---------------------------------------------

/** 连发合并窗口：一轮批量 publish 会连发多条 notification.changed（每条 commit 后
 *  各发一次），合并成一次列表拉取。 */
const FANOUT_DEBOUNCE_MS = 400

/** 每次只看最近这一页未读 —— fanout 是「新事件提醒」不是全量回放，水位之前的
 *  条目本就不弹，翻页无意义。 */
const FANOUT_FETCH_LIMIT = 20

/** seen set 的容量护栏。水位已挡住旧条目，这只是同窗口内的第二道防重弹带，
 *  超限直接清空（不做 LRU —— 不值）。 */
const SEEN_SET_CAP = 300

/** 消费的字段子集（wire 全形见 @shared/api/types/notifications.ts::NotificationItem；
 *  main 侧对 loopback 响应仍做宽松运行时校验，不信任类型断言）。 */
export interface FanoutActionSpec {
  id: string
  label: string
  url?: string
  emailId?: number
  emailSubject?: string
  icalUid?: string
  recurrenceId?: string | null
  occurrenceStartIso?: string
  meetingSummary?: string
  prepSessionId?: number
  agentId?: string
}

interface FanoutItem {
  id: number
  category: string
  severity: string
  state: string
  title: string
  body: string
  recurrenceNo: number
  lastEventAt: number
  readAt: number | null
  payload: Record<string, unknown> | null
}

let _watermarkMs = 0
let _registered = false
let _debounceTimer: ReturnType<typeof setTimeout> | null = null
const _seen = new Set<string>()
let _getChannelPrefs: (() => NotificationChannelPrefs | undefined) | null = null
let _getSuppressWhenFocused: (() => boolean | undefined) | null = null
let _ensureMainWindow: (() => Promise<BrowserWindow | null> | BrowserWindow | null) | null = null
let _fallbackAuthMeta: {
  notificationAuthState: 'unknown' | 'prompted' | 'delivered'
  notificationLastTestedAt: number | null
} = {
  notificationAuthState: 'unknown',
  notificationLastTestedAt: null
}

function isNotificationChangedEvent(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  return (payload as { event_type?: unknown }).event_type === 'notification.changed'
}

export function parseNotificationActions(
  payload: Record<string, unknown> | null | undefined
): FanoutActionSpec[] {
  if (!payload || !Array.isArray(payload.actions)) return []
  const out: FanoutActionSpec[] = []
  for (const raw of payload.actions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const r = raw as Record<string, unknown>
    if (typeof r.id !== 'string' || !r.id || typeof r.label !== 'string' || !r.label.trim()) {
      continue
    }
    const spec: FanoutActionSpec = { id: r.id, label: r.label.trim() }
    if (typeof r.url === 'string' && r.url.startsWith('https://')) spec.url = r.url
    if (typeof r.emailId === 'number' && Number.isInteger(r.emailId)) spec.emailId = r.emailId
    if (typeof r.emailSubject === 'string') spec.emailSubject = r.emailSubject
    if (typeof r.icalUid === 'string') spec.icalUid = r.icalUid
    if (typeof r.recurrenceId === 'string' || r.recurrenceId === null) {
      spec.recurrenceId = r.recurrenceId
    }
    if (typeof r.occurrenceStartIso === 'string') spec.occurrenceStartIso = r.occurrenceStartIso
    if (typeof r.meetingSummary === 'string') spec.meetingSummary = r.meetingSummary
    if (typeof r.prepSessionId === 'number' && Number.isInteger(r.prepSessionId)) {
      spec.prepSessionId = r.prepSessionId
    }
    if (typeof r.agentId === 'string') spec.agentId = r.agentId
    out.push(spec)
    if (out.length >= 2) break
  }
  return out
}

function parseFanoutItem(raw: unknown): FanoutItem | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (
    typeof r.id !== 'number' ||
    typeof r.category !== 'string' ||
    typeof r.severity !== 'string' ||
    typeof r.title !== 'string' ||
    typeof r.lastEventAt !== 'number'
  ) {
    return null
  }
  return {
    id: r.id,
    category: r.category,
    severity: r.severity,
    state: typeof r.state === 'string' ? r.state : 'open',
    title: r.title,
    body: typeof r.body === 'string' ? r.body : '',
    recurrenceNo: typeof r.recurrenceNo === 'number' ? r.recurrenceNo : 1,
    lastEventAt: r.lastEventAt,
    readAt: typeof r.readAt === 'number' ? r.readAt : null,
    payload:
      r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload)
        ? (r.payload as Record<string, unknown>)
        : null
  }
}

function isAnyMainWindowFocused(): boolean {
  try {
    return BrowserWindow.getAllWindows().some((win) => {
      if (!win || win.isDestroyed()) return false
      const focused = typeof win.isFocused === 'function' ? win.isFocused() : false
      if (!focused) return false
      return typeof win.isVisible === 'function' ? win.isVisible() : true
    })
  } catch {
    return false
  }
}

/**
 * 系统通知档位：
 * 1. 若后端已在 `payload.delivery` 注明通道决策（`'off' | 'center_only' | 'system_only' | 'both'`），优先遵守；
 * 2. 开启 `suppressWhenFocused` 且主窗口在前台聚焦时，跳过重复系统横幅（system + critical 故障除外）；
 * 3. 无 `payload.delivery` 时按设置页矩阵（`action_required` 默认 `'banner'`，其余 `'center_only'` 仅 `critical` 弹窗）。
 */
function shouldAlert(
  item: Pick<FanoutItem, 'category' | 'severity'> & { payload?: Record<string, unknown> | null },
  prefs?: NotificationChannelPrefs,
  opts?: { suppressWhenFocused?: boolean; isMainWindowFocused?: boolean }
): boolean {
  const delivery = item.payload?.delivery
  if (delivery === 'off' || delivery === 'center_only') return false

  const suppressedByFocus = Boolean(
    opts?.suppressWhenFocused &&
      opts?.isMainWindowFocused &&
      !(item.severity === 'critical' && item.category === 'system')
  )
  if (suppressedByFocus) return false

  if (delivery === 'system_only' || delivery === 'both') return true

  const mode: NotificationChannelMode =
    prefs?.[item.category] ?? (item.category === 'action_required' ? 'banner' : 'center_only')
  if (mode === 'off') return false
  if (mode === 'banner' || mode === 'both' || mode === 'system_only') return true
  return item.severity === 'critical'
}

function dispatchToWindow(
  mainWindow: BrowserWindow,
  item: FanoutItem,
  action: FanoutActionSpec | null = null
): void {
  if (mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (typeof mainWindow.show === 'function') mainWindow.show()
  mainWindow.focus()
  // renderer 侧（router-instance.tsx）经单源解析器 resolveNotificationLink /
  // executeNotificationAction 落地；普通点击维持 `{ id, payload }` 最小形状。
  const payload = action
    ? { id: item.id, payload: item.payload, action }
    : { id: item.id, payload: item.payload }
  const contents = mainWindow.webContents
  if (
    typeof contents.isLoading === 'function' &&
    contents.isLoading() &&
    typeof contents.once === 'function'
  ) {
    contents.once('did-finish-load', (): void => {
      if (!mainWindow.isDestroyed()) {
        contents.send('notifications:navigate', payload)
      }
    })
    return
  }
  contents.send('notifications:navigate', payload)
}

function navigateToNotification(
  item: FanoutItem,
  action: FanoutActionSpec | null = null,
  customEnsure?: (() => Promise<BrowserWindow | null> | BrowserWindow | null) | null
): void {
  const ensure = customEnsure ?? _ensureMainWindow
  if (!ensure) {
    const mainWindow = BrowserWindow.getAllWindows()[0]
    if (mainWindow) dispatchToWindow(mainWindow, item, action)
    return
  }
  const resolved = ensure()
  if (resolved && typeof (resolved as Promise<BrowserWindow | null>).then === 'function') {
    void (resolved as Promise<BrowserWindow | null>)
      .then((win): void => {
        if (win) dispatchToWindow(win, item, action)
      })
      .catch((err: unknown): void => {
        console.warn('[notify-center] ensureMainWindow failed:', err)
      })
    return
  }
  if (resolved) dispatchToWindow(resolved as BrowserWindow, item, action)
}

function markNotificationReadBestEffort(notificationId: number): void {
  if (!Number.isInteger(notificationId) || notificationId <= 0) return
  void fetch(`${resolveApiBaseUrl()}/notifications/${notificationId}/read`, {
    method: 'POST',
    headers: { [LOCAL_TOKEN_HEADER]: getLocalApiToken() }
  }).catch(() => {})
}

function snoozeNotification1hBestEffort(notificationId: number): void {
  if (!Number.isInteger(notificationId) || notificationId <= 0) return
  const key = `banner-snooze-${notificationId}-${Date.now()}`
  const until = Date.now() + 3_600_000
  void fetch(`${resolveApiBaseUrl()}/notifications/${notificationId}/snooze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [LOCAL_TOKEN_HEADER]: getLocalApiToken(),
      'Idempotency-Key': key
    },
    body: JSON.stringify({
      mutation: { idempotency_key: key },
      until
    })
  }).catch(() => {})
}

function handleBannerAction(item: FanoutItem, action: FanoutActionSpec): void {
  markNotificationReadBestEffort(item.id)
  if (action.id === 'join_meeting' && action.url) {
    void shell.openExternal(action.url)
    return
  }
  if (action.id === 'snooze_1h') {
    snoozeNotification1hBestEffort(item.id)
    return
  }
  navigateToNotification(item, action)
}

function showNotification(item: FanoutItem): void {
  if (!Notification.isSupported()) return
  const actions = parseNotificationActions(item.payload)
  const opts: Electron.NotificationConstructorOptions = {
    title: item.title,
    body: item.body
  }
  if (process.platform === 'darwin' && actions.length > 0) {
    opts.actions = actions.map((act) => ({ type: 'button', text: act.label }))
  }
  const notification = new Notification(opts)
  notification.on('click', () => {
    markNotificationReadBestEffort(item.id)
    navigateToNotification(item, null)
  })
  if (actions.length > 0) {
    notification.on('action', (_event, index) => {
      const picked = actions[index]
      if (picked) handleBannerAction(item, picked)
    })
  }
  try {
    notification.show()
  } catch {
    /* 平台通知不可用 —— 吞掉，铃铛或静默丢弃 */
  }
}

async function fetchAndAlert(): Promise<void> {
  const res = await fetch(
    `${resolveApiBaseUrl()}/notifications?state=all&limit=${FANOUT_FETCH_LIMIT}`,
    { headers: { [LOCAL_TOKEN_HEADER]: getLocalApiToken() } }
  )
  if (!res.ok) return
  const json = (await res.json()) as { data?: unknown }
  const rows = Array.isArray(json?.data) ? json.data : []
  const items = rows
    .map(parseFanoutItem)
    .filter((it): it is FanoutItem => {
      if (it === null || it.lastEventAt <= _watermarkMs) return false
      if (it.payload?.delivery === 'system_only') return true
      return it.state !== 'resolved' && it.state !== 'dismissed' && it.readAt === null
    })
    // 列表按 lastEventAt DESC 返回；升序弹（旧的先弹，通知中心叠放次序自然）。
    .sort((a, b) => a.lastEventAt - b.lastEventAt)
  const prefs = _getChannelPrefs?.()
  const suppressWhenFocused = Boolean(_getSuppressWhenFocused?.())
  const focused = suppressWhenFocused ? isAnyMainWindowFocused() : false
  for (const item of items) {
    if (shouldAlert(item, prefs, { suppressWhenFocused, isMainWindowFocused: focused })) {
      const seenKey = `${item.id}:${item.recurrenceNo}`
      if (!_seen.has(seenKey)) {
        if (_seen.size >= SEEN_SET_CAP) _seen.clear()
        _seen.add(seenKey)
        showNotification(item)
      }
    }
    // 水位覆盖本快照全部已审视条目（含被档位过滤掉的）——它们已被有意跳过，
    // 下一轮不重看。
    if (item.lastEventAt > _watermarkMs) _watermarkMs = item.lastEventAt
  }
}

function handleSseEvent(payload: unknown): void {
  if (!isNotificationChangedEvent(payload)) return
  if (_debounceTimer) clearTimeout(_debounceTimer)
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null
    void fetchAndAlert().catch((err) => {
      console.warn('[notify-center] fanout fetch failed (skipped this round)', err)
    })
  }, FANOUT_DEBOUNCE_MS)
}

/** 注册 fanout：水位取注册时刻（启动前的存量未读不弹 —— 铃铛已呈现）。返回反注册。 */
export function registerNotificationFanout(opts?: RegisterNotificationFanoutOptions): () => void {
  _getChannelPrefs = opts?.getChannelPrefs ?? null
  _getSuppressWhenFocused = opts?.getSuppressWhenFocused ?? null
  _ensureMainWindow = opts?.ensureMainWindow ?? null
  if (!_registered) {
    _registered = true
    _watermarkMs = Date.now()
  }
  const off = onSseEvent(handleSseEvent)
  return (): void => {
    off()
    if (_debounceTimer) {
      clearTimeout(_debounceTimer)
      _debounceTimer = null
    }
  }
}

function resolveStatusSnapshot(getAuthMeta?: () => NotificationAuthMeta): {
  supported: boolean
  platform: string
  authState: MacAuthState
  lastTestedAt: number | null
} {
  const supported = Notification.isSupported()
  const meta = getAuthMeta?.() ?? _fallbackAuthMeta
  const rawState = meta.notificationAuthState
  const authState: MacAuthState = !supported
    ? 'unsupported'
    : rawState === 'delivered' || rawState === 'prompted'
      ? rawState
      : 'unknown'
  return {
    supported,
    platform: process.platform,
    authState,
    lastTestedAt: meta.notificationLastTestedAt ?? null
  }
}

function persistAuthState(
  opts: RegisterNotificationSystemHandlersOptions | undefined,
  state: 'prompted' | 'delivered',
  at: number
): void {
  _fallbackAuthMeta = { notificationAuthState: state, notificationLastTestedAt: at }
  opts?.saveAuthMeta?.({ notificationAuthState: state, notificationLastTestedAt: at })
}

function sendPermissionAndTestBanner(
  opts: RegisterNotificationSystemHandlersOptions | undefined,
  waitForShowMs: number
): Promise<{
  ok: boolean
  shown: boolean
  authState: MacAuthState
  detail?: string
}> {
  if (!Notification.isSupported()) {
    return Promise.resolve({
      ok: false,
      shown: false,
      authState: 'unsupported',
      detail: 'System notifications are not supported on this host.'
    })
  }
  const now = Date.now()
  const demoActions: FanoutActionSpec[] = [
    { id: 'open_calendar_today', label: '打开今日日程' },
    { id: 'open_assistant', label: '唤起 AI 助手' }
  ]
  const notifOpts: Electron.NotificationConstructorOptions = {
    title: 'MailAgent 系统通知已连接',
    body: '重要邮件与会前提醒将在此弹出。点击通知右侧按钮可直达日程或 AI 助手。'
  }
  if (process.platform === 'darwin') {
    notifOpts.actions = demoActions.map((act) => ({ type: 'button', text: act.label }))
  }

  let shown = false
  let resolveShowWait: (() => void) | null = null
  const notification = new Notification(notifOpts)
  const ensure = opts?.ensureMainWindow ?? _ensureMainWindow

  const targetItem = (payload: Record<string, unknown>): FanoutItem => ({
    id: 0,
    category: 'system',
    severity: 'info',
    state: 'open',
    title: 'MailAgent',
    body: '',
    recurrenceNo: 1,
    lastEventAt: now,
    readAt: null,
    payload
  })

  notification.on('show', () => {
    shown = true
    persistAuthState(opts, 'delivered', Date.now())
    resolveShowWait?.()
    resolveShowWait = null
  })
  notification.on('click', () => {
    navigateToNotification(targetItem({}), null, ensure)
  })
  notification.on('action', (_event, index) => {
    if (index === 0) {
      navigateToNotification(
        targetItem({ link: { type: 'route', to: '/admin/calendar', search: { view: 'today' } } }),
        null,
        ensure
      )
      return
    }
    if (index === 1) {
      navigateToNotification(
        targetItem({}),
        { id: 'open_assistant', label: '唤起 AI 助手' },
        ensure
      )
    }
  })

  try {
    notification.show()
  } catch (err) {
    return Promise.resolve({
      ok: false,
      shown: false,
      authState: 'prompted',
      detail: err instanceof Error ? err.message : String(err)
    })
  }

  if (shown) {
    return Promise.resolve({ ok: true, shown: true, authState: 'delivered' })
  }
  persistAuthState(opts, 'prompted', now)

  if (waitForShowMs <= 0) {
    return Promise.resolve({ ok: true, shown: false, authState: 'prompted' })
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolveShowWait = null
      resolve({
        ok: true,
        shown,
        authState: shown ? 'delivered' : 'prompted'
      })
    }, waitForShowMs)
    resolveShowWait = (): void => {
      clearTimeout(timer)
      resolve({ ok: true, shown: true, authState: 'delivered' })
    }
  })
}

/** 供 Settings「通知与常驻」页诊断系统通知权限、发起权限探测并跳转系统设置。 */
export function registerNotificationSystemHandlers(
  opts?: RegisterNotificationSystemHandlersOptions
): void {
  ipcMain.handle('notifications:systemStatus', async () => resolveStatusSnapshot(opts?.getAuthMeta))
  ipcMain.handle('notifications:sendTest', async (): Promise<{ ok: boolean; detail?: string }> => {
    const res = await sendPermissionAndTestBanner(opts, 0)
    return res.detail ? { ok: res.ok, detail: res.detail } : { ok: res.ok }
  })
  ipcMain.handle('notifications:requestPermission', async () =>
    sendPermissionAndTestBanner(opts, 350)
  )
  ipcMain.handle('notifications:openSystemSettings', async (): Promise<{ ok: boolean }> => {
    if (process.platform !== 'darwin') return { ok: false }
    try {
      await shell.openExternal(
        'x-apple.systempreferences:com.apple.Notifications-Settings.extension'
      )
      return { ok: true }
    } catch {
      try {
        await shell.openExternal('x-apple.systempreferences:com.apple.preference.notifications')
        return { ok: true }
      } catch {
        return { ok: false }
      }
    }
  })
}

export const __testing = {
  parseFanoutItem,
  parseNotificationActions,
  shouldAlert,
  fetchAndAlert,
  reset(watermarkMs?: number): void {
    _registered = false
    _watermarkMs = watermarkMs ?? 0
    _seen.clear()
    _getChannelPrefs = null
    _getSuppressWhenFocused = null
    _ensureMainWindow = null
    _fallbackAuthMeta = { notificationAuthState: 'unknown', notificationLastTestedAt: null }
    if (_debounceTimer) {
      clearTimeout(_debounceTimer)
      _debounceTimer = null
    }
  },
  watermarkMs(): number {
    return _watermarkMs
  },
  setWatermarkMs(value: number): void {
    _watermarkMs = value
  }
}
