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

import { BrowserWindow, Notification } from 'electron'

import { DEFAULT_API_PORT } from '@shared/lib/ports'
import { onSseEvent } from './events_bridge'
import { getLocalApiToken, LOCAL_TOKEN_HEADER } from './local_token'

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

/** `ChatSession` 的本模块消费子集（group_config_json 只读 `notify` 一键）。 */
export interface GroupSessionRef extends ChatSessionRef {
  group_config_json?: string | null
}

/** 通知正文里成员回复的截取长度。 */
const GROUP_REPLY_BODY_CHARS = 80

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
 * `resolveSpeakerTitle` 由调用点注入（lifecycle 传 report_agent 读），失败回落 agent id。
 * 永不 throw。
 */
export function maybeNotifyGroupReply(
  reply: GroupReplyRef,
  getSessionById: (sessionId: number) => GroupSessionRef | null,
  isForeground: (sessionId: number) => boolean,
  resolveSpeakerTitle?: (agentId: string) => Promise<string | null> | string | null
): void {
  try {
    if (reply.role !== 'assistant') return
    const session = getSessionById(reply.sessionId)
    if (!groupNotifyEnabled(session?.group_config_json)) return
    if (isForeground(reply.sessionId)) return
    const sessionTitle = typeof session?.title === 'string' ? session.title.trim() : ''
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
      await publishNotificationToCenter({
        category: 'results',
        source: 'group_chat',
        severity: 'info',
        title: sessionTitle.length > 0 ? sessionTitle : '群聊',
        body: speaker.length > 0 ? `${speaker}：${excerpt}` : excerpt,
        dedupeKey: `group_chain:${reply.sessionId}:${reply.chainId}`,
        payload: { link: { type: 'group', sessionId: reply.sessionId } }
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
interface FanoutItem {
  id: number
  category: string
  severity: string
  title: string
  body: string
  recurrenceNo: number
  lastEventAt: number
  payload: Record<string, unknown> | null
}

let _watermarkMs = 0
let _registered = false
let _debounceTimer: ReturnType<typeof setTimeout> | null = null
const _seen = new Set<string>()

function isNotificationChangedEvent(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  return (payload as { event_type?: unknown }).event_type === 'notification.changed'
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
    title: r.title,
    body: typeof r.body === 'string' ? r.body : '',
    recurrenceNo: typeof r.recurrenceNo === 'number' ? r.recurrenceNo : 1,
    lastEventAt: r.lastEventAt,
    payload:
      r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload)
        ? (r.payload as Record<string, unknown>)
        : null
  }
}

/** 系统通知档位：critical（任何类目）或 Action Required（审批/待办类）。 */
function shouldAlert(item: Pick<FanoutItem, 'category' | 'severity'>): boolean {
  return item.severity === 'critical' || item.category === 'action_required'
}

function navigateToNotification(item: FanoutItem): void {
  const mainWindow = BrowserWindow.getAllWindows()[0]
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
  // renderer 侧（router-instance.tsx）经单源解析器 resolveNotificationLink 按
  // payload.link 深跳；无 link / 未知型 → 只聚焦（上面已做）。
  mainWindow.webContents.send('notifications:navigate', { id: item.id, payload: item.payload })
}

function showNotification(item: FanoutItem): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({ title: item.title, body: item.body })
  notification.on('click', () => navigateToNotification(item))
  try {
    notification.show()
  } catch {
    /* 平台通知不可用 —— 吞掉，铃铛仍有这条 */
  }
}

async function fetchAndAlert(): Promise<void> {
  const res = await fetch(
    `${resolveApiBaseUrl()}/notifications?unreadOnly=true&limit=${FANOUT_FETCH_LIMIT}`,
    { headers: { [LOCAL_TOKEN_HEADER]: getLocalApiToken() } }
  )
  if (!res.ok) return
  const json = (await res.json()) as { data?: unknown }
  const rows = Array.isArray(json?.data) ? json.data : []
  const items = rows
    .map(parseFanoutItem)
    .filter((it): it is FanoutItem => it !== null && it.lastEventAt > _watermarkMs)
    // 列表按 lastEventAt DESC 返回；升序弹（旧的先弹，通知中心叠放次序自然）。
    .sort((a, b) => a.lastEventAt - b.lastEventAt)
  for (const item of items) {
    if (shouldAlert(item)) {
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
export function registerNotificationFanout(): () => void {
  if (!_registered) {
    _registered = true
    _watermarkMs = Date.now()
  }
  const off = onSseEvent(handleSseEvent)
  return () => {
    off()
    if (_debounceTimer) {
      clearTimeout(_debounceTimer)
      _debounceTimer = null
    }
  }
}

export const __testing = {
  parseFanoutItem,
  shouldAlert,
  fetchAndAlert,
  reset(watermarkMs?: number): void {
    _registered = false
    _watermarkMs = watermarkMs ?? 0
    _seen.clear()
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
