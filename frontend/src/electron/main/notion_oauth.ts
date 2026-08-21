// task 08-20 — Notion OAuth 授权内核（Lane 2）。
//
// 设置页/onboarding「连接 Notion」→ 系统浏览器完成 Notion 公开集成授权 →
// localhost loopback 收 code → webhook-server 无状态代理换 token（client_secret
// 不在分发包）→ 2025-09-03 data source 语义发现邮件库/日历库 → 原子写 env 五键。
//
// 安全契约（design.md v2「桌面 App 侧」，逐条对应）：
//   * 单活跃 attempt：新 start 原子替换旧的；state = crypto.randomBytes(32) 一次性。
//   * loopback 双栈监听 127.0.0.1 + ::1 同端口（9280 → 9281 fallback），5min 超时。
//     redirect URI 是 `http://localhost:<port>` 形态（Notion 控制台拒收 127.0.0.1，
//     2026-08-20 owner 实操确认）；浏览器解析 localhost 可能先试 IPv6，故双栈。
//     `::1` 监听失败（无 IPv6 环境）可忽略；任一栈端口被占则整体切下一端口。
//   * 错 state / 错 path / 非 GET / 探测请求 → 固定错误页且**不消耗** attempt
//     （防本地恶意进程 DoS 打断进行中的授权）。
//   * state 匹配的 code 在发起 exchange **前**即标记已消费（双回调/重放无效）。
//   * 成功/失败页 = 固定常量 HTML 零参数回显 + 安全响应头；不开 CORS。
//   * access_token 只存 main 内存，直到 env 原子写成功或 attempt 终止；
//     永不进任何 IPC 载荷 / 日志（NOTION_TOKEN ∈ SECRET_ENV_KEYS 脱敏契约的上游）。
//   * cancel / 超时 / app quit → 关 server、清 state、清内存 token 与候选列表。
//
// 🔴 不写 NOTION_REFRESH_TOKEN（prd 非目标：refresh token 不落盘，401 一律重新授权）。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomBytes, timingSafeEqual } from 'crypto'

import { app, BrowserWindow, ipcMain, shell } from 'electron'

import {
  classifyDataSource,
  NOTION_API_VERSION,
  validateDataSourceProperties,
  type NotionDbRole,
  type NotionPropertyLike
} from '@shared/lib/notionDbSchema'
// IPC 契约（phase / errorCode / 候选形状 / channel 名）单源在 @shared —— renderer
// tsconfig 没有 main 的 path alias，两侧各写一份就是跨边界手抄常量。
import {
  NOTION_OAUTH_CANCEL_CHANNEL,
  NOTION_OAUTH_LIST_DATABASES_CHANNEL,
  NOTION_OAUTH_REMOVE_CONNECTION_CHANNEL,
  NOTION_OAUTH_SELECT_DATABASES_CHANNEL,
  NOTION_OAUTH_START_CHANNEL,
  NOTION_OAUTH_STATUS_CHANNEL,
  type NotionDbCandidate,
  type NotionOauthErrorCode,
  type NotionOauthPhase,
  type NotionOauthRemoveResult,
  type NotionOauthSelectResult,
  type NotionOauthStartResult,
  type NotionOauthStatusEvent
} from '@shared/lib/notionOauthContract'
import { writePatch, type EnvSetResult } from './handlers/env'

// ---- 常量（implement.md「固定契约」） -------------------------------------

/** 公开集成 client_id 内置默认值（2026-08-20 owner 建好集成后回填；client_id 是
 *  公开标识非密钥，可硬编码）。运行时可被 env `NOTION_OAUTH_CLIENT_ID` 覆盖（调试/
 *  换集成用）；两者都空 → start 拒绝（Lane 3 据此把按钮置灰——防未来换集成时空值裸奔）。 */
export const NOTION_OAUTH_CLIENT_ID_DEFAULT = '3c3d872b-594c-8168-871b-0037807be46f'

/** exchange 代理默认地址；env `NOTION_OAUTH_PROXY_URL` 覆盖（调试 / 部署方案 B）。 */
export const NOTION_OAUTH_PROXY_URL_DEFAULT = 'https://mailagent.chenge.ink'

/** Redirect URI 白名单端口（与服务端 exchange 白名单、Notion 控制台注册值三处同值，
 *  仅这两条）。host 用 `localhost` 不用字面 IP —— RFC 8252 首选 127.0.0.1，但 Notion
 *  控制台实测拒收（2026-08-20 owner 确认，集成已按 localhost 注册），按回退预案落地。 */
export const CALLBACK_PORTS: readonly number[] = [9280, 9281]
export const CALLBACK_PATH = '/oauth/notion/callback'
export const CALLBACK_HOST = 'localhost'

const AUTHORIZE_URL = 'https://api.notion.com/v1/oauth/authorize'
const NOTION_API_BASE = 'https://api.notion.com'
const DEFAULT_ATTEMPT_TIMEOUT_MS = 5 * 60_000
const EXCHANGE_TIMEOUT_MS = 30_000
const NOTION_FETCH_TIMEOUT_MS = 15_000
/** 回调 URL 长度上限（Notion 的 code + state 远小于此；超长 = 探测/垃圾请求）。 */
const MAX_CALLBACK_URL_LENGTH = 2048
const MAX_CODE_LENGTH = 512
/** blocks children / search 翻页上限（防御性；模板页远小于此）。 */
const MAX_PAGINATION_PAGES = 20

export const STATUS_CHANNEL = NOTION_OAUTH_STATUS_CHANNEL

// ---- 固定常量 HTML（零参数回显；见 design「成功页/失败页」） ----------------

const PAGE_STYLE =
  '<style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;' +
  'justify-content:center;min-height:90vh;margin:0;background:#f7f6f3;color:#37352f}' +
  'main{text-align:center;max-width:28em;padding:2em}h1{font-size:1.3em}</style>'

export const SUCCESS_HTML =
  '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>MailAgent</title>' +
  PAGE_STYLE +
  '</head><body><main><h1>授权完成</h1><p>可以关闭本页面，回到 MailAgent 继续。</p></main></body></html>'

export const FAILURE_HTML =
  '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>MailAgent</title>' +
  PAGE_STYLE +
  '</head><body><main><h1>授权未完成</h1><p>可以关闭本页面，回到 MailAgent 重试。</p></main></body></html>'

export const ERROR_HTML =
  '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>MailAgent</title>' +
  PAGE_STYLE +
  '</head><body><main><h1>无效请求</h1><p>本页面仅用于 MailAgent 的 Notion 授权回调。</p></main></body></html>'

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  // 一次性回调 server 不留 keep-alive 长连接（attempt 结束即关站，悬挂 socket 只会
  // 让「server 已关」变得不可观测）。
  Connection: 'close'
}

// ---- 类型 ----------------------------------------------------------------

// phase / errorCode / status 事件 / 候选形状的**定义**在 @shared/lib/notionOauthContract
//（renderer 也要用）。这里 re-export 保住既有 import 路径（tests + index.ts）。
export type {
  NotionDbCandidate,
  NotionOauthErrorCode,
  NotionOauthPhase,
  NotionOauthStatusEvent
} from '@shared/lib/notionOauthContract'

interface InternalCandidate extends NotionDbCandidate {
  /** data source 所在 database 容器 id（写入 EMAIL/CALENDAR_DATABASE_ID 的值）。 */
  databaseId: string
}

interface ExchangeSuccess {
  ok: true
  accessToken: string
  workspaceId: string
  workspaceName: string
  duplicatedTemplateId: string | null
}

interface ExchangeFailure {
  ok: false
  errorCode: NotionOauthErrorCode
}

interface Attempt {
  id: string
  /** 一次性 state；code 消费后立即清空（后续回调恒不匹配 → 固定错误页）。 */
  state: string
  codeConsumed: boolean
  /** 双栈监听：127.0.0.1 必有；::1 失败（无 IPv6 环境）时只有一个。 */
  servers: Server[]
  port: number
  redirectUri: string
  timeout: NodeJS.Timeout | null
  phase: NotionOauthPhase
  /** 🔴 只在 main 内存；attempt 终止即清。 */
  token: string | null
  workspaceId: string | null
  workspaceName: string | null
  candidates: InternalCandidate[] | null
  finished: boolean
}

// ---- 可注入依赖（vitest 无 electron 环境下替换） ---------------------------

export interface NotionOauthDeps {
  openExternal: (url: string) => Promise<void>
  broadcast: (channel: string, payload: NotionOauthStatusEvent) => void
  writeEnvPatch: (patch: Record<string, string | null>) => EnvSetResult
  fetchImpl: typeof fetch
  attemptTimeoutMs: number
}

function defaultBroadcast(channel: string, payload: NotionOauthStatusEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send(channel, payload)
      } catch {
        /* renderer 已销毁 — 忽略 */
      }
    }
  }
}

const defaultDeps: NotionOauthDeps = {
  openExternal: (url) => shell.openExternal(url),
  broadcast: defaultBroadcast,
  writeEnvPatch: (patch) => writePatch(patch),
  fetchImpl: (...args: Parameters<typeof fetch>) => fetch(...args),
  attemptTimeoutMs: DEFAULT_ATTEMPT_TIMEOUT_MS
}

let deps: NotionOauthDeps = { ...defaultDeps }

// ---- attempt 状态机 -------------------------------------------------------

let active: Attempt | null = null

function resolveClientId(): string {
  return (process.env['NOTION_OAUTH_CLIENT_ID'] ?? '').trim() || NOTION_OAUTH_CLIENT_ID_DEFAULT
}

function resolveProxyBase(): string {
  const raw = (process.env['NOTION_OAUTH_PROXY_URL'] ?? '').trim() || NOTION_OAUTH_PROXY_URL_DEFAULT
  return raw.replace(/\/+$/, '')
}

function stateEqual(expected: string, got: string): boolean {
  if (expected.length === 0) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(got)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function sendFixedPage(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, SECURITY_HEADERS)
  res.end(html)
}

function emit(att: Attempt, event: Omit<NotionOauthStatusEvent, 'attemptId'>): void {
  deps.broadcast(STATUS_CHANNEL, { attemptId: att.id, ...event })
}

function setPhase(att: Attempt, phase: NotionOauthPhase): void {
  att.phase = phase
  emit(att, { phase })
}

/** 终止 attempt 并清空全部内存痕迹（server / state / token / 候选列表）。 */
function cleanupAttempt(att: Attempt): void {
  att.finished = true
  if (att.timeout) {
    clearTimeout(att.timeout)
    att.timeout = null
  }
  for (const server of att.servers) {
    try {
      server.close()
      // close() 只停新连接；把既有连接也断掉（Node ≥18.2），端口即刻真正下线。
      server.closeAllConnections?.()
    } catch {
      /* already closed */
    }
  }
  att.servers = []
  att.state = ''
  att.token = null
  att.candidates = null
  if (active === att) active = null
}

function finishError(att: Attempt, errorCode: NotionOauthErrorCode): void {
  if (att.finished) return
  att.phase = 'error'
  emit(att, { phase: 'error', errorCode })
  cleanupAttempt(att)
}

function finishDone(
  att: Attempt,
  info: { workspaceName: string; emailDbTitle: string; calendarDbTitle: string }
): void {
  if (att.finished) return
  att.phase = 'done'
  emit(att, { phase: 'done', ...info })
  cleanupAttempt(att)
}

/** attempt 是否仍是当前活跃的那一个（迟到的异步结果全部丢弃）。 */
function isCurrent(att: Attempt): boolean {
  return !att.finished && active === att
}

// ---- loopback 回调 --------------------------------------------------------

function handleCallbackRequest(att: Attempt, req: IncomingMessage, res: ServerResponse): void {
  // 探测/垃圾请求 → 固定错误页，不消耗 attempt（防本地 DoS）。
  if (!req.url || req.url.length > MAX_CALLBACK_URL_LENGTH) {
    sendFixedPage(res, 414, ERROR_HTML)
    return
  }
  if (req.method !== 'GET') {
    sendFixedPage(res, 405, ERROR_HTML)
    return
  }
  let parsed: URL
  try {
    parsed = new URL(req.url, 'http://127.0.0.1')
  } catch {
    sendFixedPage(res, 400, ERROR_HTML)
    return
  }
  if (parsed.pathname !== CALLBACK_PATH) {
    sendFixedPage(res, 404, ERROR_HTML)
    return
  }
  const gotState = parsed.searchParams.get('state') ?? ''
  // state 不匹配（含已消费后 state 已清空的重放/双回调）→ 固定错误页，不消耗。
  if (!isCurrent(att) || att.codeConsumed || !stateEqual(att.state, gotState)) {
    sendFixedPage(res, 400, ERROR_HTML)
    return
  }

  const errParam = parsed.searchParams.get('error')
  if (errParam !== null) {
    // Notion 侧用户取消/拒绝 —— state 匹配，终结 attempt（错误内容不回显）。
    att.codeConsumed = true
    att.state = ''
    sendFixedPage(res, 200, FAILURE_HTML)
    finishError(att, 'denied')
    return
  }

  const code = parsed.searchParams.get('code')
  if (!code || code.length > MAX_CODE_LENGTH) {
    // state 对但 code 缺失/畸形：不消耗（真回调必带 code 或 error）。
    sendFixedPage(res, 400, ERROR_HTML)
    return
  }

  // 🔴 发起 exchange 前即标记已消费 + 清 state —— 双回调/重放拿固定错误页。
  att.codeConsumed = true
  att.state = ''
  if (att.timeout) {
    clearTimeout(att.timeout)
    att.timeout = null
  }
  sendFixedPage(res, 200, SUCCESS_HTML)
  void runExchangeAndDiscovery(att, code)
}

type ListenOutcome = { ok: true; server: Server } | { ok: false; code: string }

function listenOn(
  host: string,
  port: number,
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<ListenOutcome> {
  return new Promise((resolve) => {
    const server = createServer({ maxHeaderSize: 16 * 1024 }, handler)
    server.on('error', (err: NodeJS.ErrnoException) => {
      resolve({ ok: false, code: err?.code ?? 'EUNKNOWN' })
    })
    server.listen(port, host, () => {
      server.removeAllListeners('error')
      server.on('error', () => {
        /* 运行期 socket 错误 — 不让它变成 uncaught */
      })
      resolve({ ok: true, server })
    })
  })
}

/** 双栈监听同一端口。redirect 是 `localhost` 形态，浏览器可能先解析 ::1：
 *  - 127.0.0.1 失败 → 该端口不可用；
 *  - ::1 端口被占（EADDRINUSE）→ 两栈必须同端口，整体切下一端口；
 *  - ::1 其它失败（EAFNOSUPPORT / EADDRNOTAVAIL 等无 IPv6 环境）→ 忽略，v4-only。 */
async function listenDualStack(
  port: number,
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<Server[] | null> {
  const v4 = await listenOn('127.0.0.1', port, handler)
  if (!v4.ok) return null
  const v6 = await listenOn('::1', port, handler)
  if (v6.ok) return [v4.server, v6.server]
  if (v6.code === 'EADDRINUSE') {
    try {
      v4.server.close()
    } catch {
      /* ignore */
    }
    return null
  }
  return [v4.server]
}

// ---- exchange（代理换 token） ---------------------------------------------

const KNOWN_EXCHANGE_ERRORS: ReadonlySet<string> = new Set([
  'invalid_grant',
  'upstream_error',
  'not_configured',
  'rate_limited',
  'invalid_redirect_uri'
])

async function exchangeCode(
  code: string,
  redirectUri: string
): Promise<ExchangeSuccess | ExchangeFailure> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS)
  let resp: Response
  try {
    resp = await deps.fetchImpl(`${resolveProxyBase()}/api/oauth/notion/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirect_uri: redirectUri }),
      signal: controller.signal
    })
  } catch {
    return { ok: false, errorCode: 'network_error' }
  } finally {
    clearTimeout(timer)
  }

  let body: unknown
  try {
    body = await resp.json()
  } catch {
    return { ok: false, errorCode: 'invalid_response' }
  }
  const rec = (body ?? {}) as Record<string, unknown>

  if (!resp.ok) {
    const err = typeof rec['error'] === 'string' ? (rec['error'] as string) : ''
    return {
      ok: false,
      errorCode: KNOWN_EXCHANGE_ERRORS.has(err) ? (err as NotionOauthErrorCode) : 'upstream_error'
    }
  }

  // allowlist DTO：只认这四个字段，其余（不该存在的）一律忽略。
  const accessToken = rec['access_token']
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    return { ok: false, errorCode: 'invalid_response' }
  }
  return {
    ok: true,
    accessToken,
    workspaceId: typeof rec['workspace_id'] === 'string' ? (rec['workspace_id'] as string) : '',
    workspaceName:
      typeof rec['workspace_name'] === 'string' ? (rec['workspace_name'] as string) : '',
    duplicatedTemplateId:
      typeof rec['duplicated_template_id'] === 'string' && rec['duplicated_template_id'].length > 0
        ? (rec['duplicated_template_id'] as string)
        : null
  }
}

// ---- 库发现（🔴 2025-09-03 data source 语义） ------------------------------

class NotionApiError extends Error {
  readonly status: number

  constructor(status: number, path: string) {
    // 不回显响应体（可能含错误描述）；status 足够定位。
    super(`notion api ${status} on ${path.split('?')[0]}`)
    this.status = status
  }
}

async function notionApi(
  token: string,
  path: string,
  init?: { method?: string; body?: string }
): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NOTION_FETCH_TIMEOUT_MS)
  try {
    const resp = await deps.fetchImpl(`${NOTION_API_BASE}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_API_VERSION,
        'Content-Type': 'application/json'
      },
      body: init?.body,
      signal: controller.signal
    })
    if (!resp.ok) {
      throw new NotionApiError(resp.status, path)
    }
    return (await resp.json()) as Record<string, unknown>
  } finally {
    clearTimeout(timer)
  }
}

function plainText(rich: unknown): string {
  if (!Array.isArray(rich)) return ''
  return rich
    .map((r) =>
      typeof (r as Record<string, unknown>)?.['plain_text'] === 'string'
        ? ((r as Record<string, unknown>)['plain_text'] as string)
        : ''
    )
    .join('')
}

function buildCandidate(
  dataSourceId: string,
  databaseId: string,
  title: string,
  properties: Record<string, NotionPropertyLike | undefined>
): InternalCandidate {
  const emailV = validateDataSourceProperties('email', properties)
  const calV = validateDataSourceProperties('calendar', properties)
  let role: NotionDbRole | 'unknown'
  if (emailV.valid && !calV.valid) role = 'email'
  else if (calV.valid && !emailV.valid) role = 'calendar'
  else if (emailV.valid && calV.valid)
    role = 'unknown' // 双角色字段都齐 —— 无法唯一识别
  else role = classifyDataSource(properties) // 按签名归角色，valid=false 时 missing 给具体清单
  const v = role === 'email' ? emailV : role === 'calendar' ? calV : null
  return {
    id: dataSourceId,
    databaseId,
    title,
    role,
    valid: v?.valid ?? false,
    missing: v?.missing ?? [],
    warnings: v?.warnings ?? []
  }
}

interface FetchedDataSource {
  properties: Record<string, NotionPropertyLike | undefined>
  databaseId: string
  name: string
}

async function fetchDataSource(token: string, dataSourceId: string): Promise<FetchedDataSource> {
  const ds = await notionApi(token, `/v1/data_sources/${encodeURIComponent(dataSourceId)}`)
  const parent = (ds['parent'] ?? {}) as Record<string, unknown>
  return {
    properties: (ds['properties'] ?? {}) as Record<string, NotionPropertyLike | undefined>,
    databaseId: typeof parent['database_id'] === 'string' ? (parent['database_id'] as string) : '',
    name: plainText(ds['title']) || plainText(ds['name'])
  }
}

async function candidatesFromDatabase(
  token: string,
  databaseId: string
): Promise<InternalCandidate[]> {
  const db = await notionApi(token, `/v1/databases/${encodeURIComponent(databaseId)}`)
  const dbTitle = plainText(db['title'])
  const sources = Array.isArray(db['data_sources'])
    ? (db['data_sources'] as Array<Record<string, unknown>>)
    : []
  const out: InternalCandidate[] = []
  for (const src of sources) {
    const dsId = typeof src['id'] === 'string' ? (src['id'] as string) : ''
    if (!dsId) continue
    const fetched = await fetchDataSource(token, dsId)
    const dsName =
      typeof src['name'] === 'string' && src['name'] ? (src['name'] as string) : fetched.name
    // 多 data source 的 database：标题带上 data source 名，选择器里可区分。
    const title = sources.length > 1 && dsName ? `${dbTitle} / ${dsName}` : dbTitle || dsName
    out.push(buildCandidate(dsId, fetched.databaseId || databaseId, title, fetched.properties))
  }
  return out
}

/** 容器块类型：真库可能嵌在这些块里（owner 模板实勘：真库在「数据库 & 文档」toggle
 *  内部）→ 遍历须递归下钻；`child_page` 有意不在列（独立子页面不下钻）。 */
const CONTAINER_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'toggle',
  'column_list',
  'column',
  'callout',
  'synced_block'
])
/** 容器递归深度上限（防御性；实勘模板一层 toggle 就到底了）。 */
const MAX_BLOCK_DESCENT_DEPTH = 5

/** 一个 block 的 children 全量翻页读取。 */
async function listBlockChildren(
  token: string,
  blockId: string
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  let cursor: string | null = null
  for (let i = 0; i < MAX_PAGINATION_PAGES; i++) {
    const qs = cursor
      ? `?page_size=100&start_cursor=${encodeURIComponent(cursor)}`
      : '?page_size=100'
    const page = await notionApi(token, `/v1/blocks/${encodeURIComponent(blockId)}/children${qs}`)
    if (Array.isArray(page['results'])) {
      out.push(...(page['results'] as Array<Record<string, unknown>>))
    }
    if (page['has_more'] !== true || typeof page['next_cursor'] !== 'string') break
    cursor = page['next_cursor'] as string
  }
  return out
}

/** 模板路径：duplicated_template_id → blocks children（翻页 + 递归下钻容器块）收
 *  child_database → database → data_sources[] → data source properties。
 *  linked view 同样以 child_database 块形态出现，判据：GET /v1/databases/{block.id}
 *  404 = linked view，静默跳过（真 child database 的 block id 即 database id）。 */
export async function discoverFromTemplate(
  token: string,
  templatePageId: string
): Promise<InternalCandidate[]> {
  const childDbIds: string[] = []
  const seenDbIds = new Set<string>()
  const queue: Array<{ id: string; depth: number }> = [{ id: templatePageId, depth: 0 }]
  while (queue.length > 0) {
    const { id, depth } = queue.shift()!
    for (const block of await listBlockChildren(token, id)) {
      const blockId = typeof block['id'] === 'string' ? (block['id'] as string) : ''
      if (!blockId) continue
      const type = block['type']
      if (type === 'child_database') {
        if (!seenDbIds.has(blockId)) {
          seenDbIds.add(blockId)
          childDbIds.push(blockId)
        }
      } else if (
        typeof type === 'string' &&
        CONTAINER_BLOCK_TYPES.has(type) &&
        block['has_children'] === true &&
        depth + 1 <= MAX_BLOCK_DESCENT_DEPTH
      ) {
        queue.push({ id: blockId, depth: depth + 1 })
      }
      // child_page 及其他类型：不下钻。
    }
  }
  const candidates: InternalCandidate[] = []
  for (const dbId of childDbIds) {
    try {
      candidates.push(...(await candidatesFromDatabase(token, dbId)))
    } catch (err) {
      if (err instanceof NotionApiError && err.status === 404) {
        continue // linked view（child_database 块形态但不是真库）——静默跳过
      }
      throw err
    }
  }
  return candidates
}

/** 已有页面路径：search 按 data source 过滤。兼容两种返回形态（object=data_source /
 *  object=database——以真实响应为准，fixture 两种都留）。 */
export async function discoverFromSearch(token: string): Promise<InternalCandidate[]> {
  const seen = new Set<string>()
  const candidates: InternalCandidate[] = []
  let cursor: string | null = null
  for (let i = 0; i < MAX_PAGINATION_PAGES; i++) {
    const body: Record<string, unknown> = {
      filter: { property: 'object', value: 'data_source' },
      page_size: 100
    }
    if (cursor) body['start_cursor'] = cursor
    const page = await notionApi(token, '/v1/search', {
      method: 'POST',
      body: JSON.stringify(body)
    })
    const results = Array.isArray(page['results'])
      ? (page['results'] as Array<Record<string, unknown>>)
      : []
    for (const item of results) {
      const obj = item['object']
      const id = typeof item['id'] === 'string' ? (item['id'] as string) : ''
      if (!id) continue
      if (obj === 'data_source') {
        if (seen.has(id)) continue
        seen.add(id)
        const inlineProps = item['properties']
        const parent = (item['parent'] ?? {}) as Record<string, unknown>
        if (inlineProps && typeof inlineProps === 'object') {
          candidates.push(
            buildCandidate(
              id,
              typeof parent['database_id'] === 'string' ? (parent['database_id'] as string) : '',
              plainText(item['title']),
              inlineProps as Record<string, NotionPropertyLike | undefined>
            )
          )
        } else {
          const fetched = await fetchDataSource(token, id)
          candidates.push(
            buildCandidate(
              id,
              fetched.databaseId,
              plainText(item['title']) || fetched.name,
              fetched.properties
            )
          )
        }
      } else if (obj === 'database') {
        for (const cand of await candidatesFromDatabase(token, id)) {
          if (seen.has(cand.id)) continue
          seen.add(cand.id)
          candidates.push(cand)
        }
      }
    }
    if (page['has_more'] !== true || typeof page['next_cursor'] !== 'string') break
    cursor = page['next_cursor'] as string
  }
  return candidates
}

// ---- exchange + 发现 + 写入主流程 -----------------------------------------

function buildEnvPatch(
  att: Attempt,
  email: InternalCandidate,
  cal: InternalCandidate
): Record<string, string> {
  // 🔴 七键原子 patch；不写 NOTION_REFRESH_TOKEN（不落盘拍板）。
  // DATA_SOURCE 两键（候选的 `id` 就是选中的 data source id）：库发现/选择是 data
  // source 粒度，而 Python 解析侧没有这两个键时恒取 database 的 data_sources[0] ——
  // 一个 database 含多个 data source 时选中的未必是第一个，不显式落盘就会静默写错
  // 数据源（task 08-20 Lane 5，显式 > 推断）。
  return {
    NOTION_TOKEN: att.token ?? '',
    EMAIL_DATABASE_ID: email.databaseId,
    CALENDAR_DATABASE_ID: cal.databaseId,
    EMAIL_DATA_SOURCE_ID: email.id,
    CALENDAR_DATA_SOURCE_ID: cal.id,
    NOTION_WORKSPACE_ID: att.workspaceId ?? '',
    NOTION_WORKSPACE_NAME: att.workspaceName ?? ''
  }
}

function writeAndFinish(att: Attempt, email: InternalCandidate, cal: InternalCandidate): void {
  setPhase(att, 'writing')
  const res = deps.writeEnvPatch(buildEnvPatch(att, email, cal))
  if (!res.ok) {
    finishError(att, 'env_write_failed')
    return
  }
  finishDone(att, {
    workspaceName: att.workspaceName ?? '',
    emailDbTitle: email.title,
    calendarDbTitle: cal.title
  })
}

async function runExchangeAndDiscovery(att: Attempt, code: string): Promise<void> {
  setPhase(att, 'exchanging')
  const ex = await exchangeCode(code, att.redirectUri)
  if (!isCurrent(att)) return
  if (!ex.ok) {
    finishError(att, ex.errorCode)
    return
  }
  att.token = ex.accessToken
  att.workspaceId = ex.workspaceId
  att.workspaceName = ex.workspaceName

  setPhase(att, 'discovering')
  let candidates: InternalCandidate[]
  try {
    candidates = ex.duplicatedTemplateId
      ? await discoverFromTemplate(ex.accessToken, ex.duplicatedTemplateId)
      : await discoverFromSearch(ex.accessToken)
  } catch {
    if (isCurrent(att)) finishError(att, 'discovery_failed')
    return
  }
  if (!isCurrent(att)) return

  const validEmails = candidates.filter((c) => c.role === 'email' && c.valid)
  const validCals = candidates.filter((c) => c.role === 'calendar' && c.valid)
  if (validEmails.length === 1 && validCals.length === 1) {
    writeAndFinish(att, validEmails[0], validCals[0])
    return
  }
  if (candidates.length === 0) {
    finishError(att, 'no_databases_found')
    return
  }
  att.candidates = candidates
  setPhase(att, 'need_selection')
}

// ---- 对外操作（IPC handler 的实现体） --------------------------------------

export type StartResult = NotionOauthStartResult

export async function startNotionOauth(): Promise<StartResult> {
  // 单活跃 attempt：原子取消旧的再起新的（旧 attempt 的迟到回调/异步结果全部失效）。
  if (active) {
    const old = active
    old.phase = 'error'
    emit(old, { phase: 'error', errorCode: 'cancelled' })
    cleanupAttempt(old)
  }

  const clientId = resolveClientId()
  if (!clientId) return { ok: false, errorCode: 'client_id_missing' }

  const attemptId = randomBytes(12).toString('hex')
  const state = randomBytes(32).toString('hex')

  let servers: Server[] | null = null
  let port = 0
  // attempt 引用在 listen 之后才赋值；极小窗口内先到的请求拿固定错误页（不消耗任何状态）。
  let attRef: Attempt | null = null
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    if (!attRef) {
      sendFixedPage(res, 503, ERROR_HTML)
      return
    }
    handleCallbackRequest(attRef, req, res)
  }
  for (const candidate of CALLBACK_PORTS) {
    servers = await listenDualStack(candidate, handler)
    if (servers) {
      port = candidate
      break
    }
  }
  if (!servers) return { ok: false, errorCode: 'port_unavailable' }

  const att: Attempt = {
    id: attemptId,
    state,
    codeConsumed: false,
    servers,
    port,
    redirectUri: `http://${CALLBACK_HOST}:${port}${CALLBACK_PATH}`,
    timeout: null,
    phase: 'waiting_callback',
    token: null,
    workspaceId: null,
    workspaceName: null,
    candidates: null,
    finished: false
  }
  attRef = att
  active = att
  att.timeout = setTimeout(() => {
    if (isCurrent(att) && !att.codeConsumed) finishError(att, 'timeout')
  }, deps.attemptTimeoutMs)

  const authorize = new URL(AUTHORIZE_URL)
  authorize.searchParams.set('client_id', clientId)
  authorize.searchParams.set('redirect_uri', att.redirectUri)
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('owner', 'user')
  authorize.searchParams.set('state', state)

  emit(att, { phase: 'waiting_callback' })
  try {
    await deps.openExternal(authorize.toString())
  } catch {
    finishError(att, 'browser_open_failed')
    return { ok: false, errorCode: 'browser_open_failed' }
  }
  return { ok: true, attemptId }
}

export function cancelNotionOauth(attemptId: string): void {
  if (active && active.id === attemptId) {
    finishError(active, 'cancelled')
  }
}

export function listDatabases(attemptId: string): NotionDbCandidate[] {
  if (
    !active ||
    active.id !== attemptId ||
    active.phase !== 'need_selection' ||
    !active.candidates
  ) {
    return []
  }
  // 非敏感投影（不带 databaseId 内部字段也无妨，但按契约只出五个字段）。
  return active.candidates.map(({ id, title, role, valid, missing, warnings }) => ({
    id,
    title,
    role,
    valid,
    missing: [...missing],
    warnings: [...warnings]
  }))
}

export type SelectResult = NotionOauthSelectResult

/** main 侧重校验（不信任 renderer 传值）：两个 id 必须出自本 attempt 的候选列表、
 *  对当前 token 仍可见（重新 fetch）、schema 对目标角色合法、且指向不同库。 */
export async function selectDatabases(
  attemptId: string,
  emailDbId: string,
  calendarDbId: string
): Promise<SelectResult> {
  const att = active
  if (
    !att ||
    att.id !== attemptId ||
    att.phase !== 'need_selection' ||
    !att.token ||
    !att.candidates
  ) {
    return { ok: false, errorCode: 'selection_invalid' }
  }
  if (
    typeof emailDbId !== 'string' ||
    typeof calendarDbId !== 'string' ||
    emailDbId === calendarDbId
  ) {
    return { ok: false, errorCode: 'selection_invalid' }
  }
  const emailCand = att.candidates.find((c) => c.id === emailDbId)
  const calCand = att.candidates.find((c) => c.id === calendarDbId)
  if (!emailCand || !calCand) return { ok: false, errorCode: 'selection_invalid' }

  let emailFetched: FetchedDataSource
  let calFetched: FetchedDataSource
  try {
    emailFetched = await fetchDataSource(att.token, emailDbId)
    calFetched = await fetchDataSource(att.token, calendarDbId)
  } catch {
    return { ok: false, errorCode: 'selection_invalid' }
  }
  if (!isCurrent(att) || att.phase !== 'need_selection')
    return { ok: false, errorCode: 'selection_invalid' }

  const emailV = validateDataSourceProperties('email', emailFetched.properties)
  const calV = validateDataSourceProperties('calendar', calFetched.properties)
  if (!emailV.valid || !calV.valid) return { ok: false, errorCode: 'selection_invalid' }

  const emailDb = emailFetched.databaseId || emailCand.databaseId
  const calDb = calFetched.databaseId || calCand.databaseId
  if (!emailDb || !calDb || emailDb === calDb) return { ok: false, errorCode: 'selection_invalid' }

  writeAndFinish(att, { ...emailCand, databaseId: emailDb }, { ...calCand, databaseId: calDb })
  return { ok: true }
}

export type RemoveResult = NotionOauthRemoveResult

/** 「从本机移除连接」：token + 两库 ID + 两个 data source ID + workspace 信息全清
 *  （无「保留 token」选项——Notion 侧授权仍存在，撤销需去 Notion 设置，文案由 Lane 3
 *  如实表述）。🔴 DATA_SOURCE 两键必须一起清：留着会在用户改手填 token/库 ID 后
 *  指向上一个 workspace 的数据源（正是本键要修的那类静默写错）。 */
export function removeConnection(): RemoveResult {
  const res = deps.writeEnvPatch({
    NOTION_TOKEN: null,
    EMAIL_DATABASE_ID: null,
    CALENDAR_DATABASE_ID: null,
    EMAIL_DATA_SOURCE_ID: null,
    CALENDAR_DATA_SOURCE_ID: null,
    NOTION_WORKSPACE_ID: null,
    NOTION_WORKSPACE_NAME: null
  })
  return res.ok ? { ok: true } : { ok: false, errorCode: 'env_write_failed' }
}

// ---- IPC 注册 -------------------------------------------------------------

export function registerNotionOauthHandlers(): void {
  ipcMain.handle(NOTION_OAUTH_START_CHANNEL, async (): Promise<StartResult> => startNotionOauth())
  ipcMain.handle(NOTION_OAUTH_CANCEL_CHANNEL, (_evt, arg: unknown): void => {
    const attemptId = (arg as { attemptId?: unknown } | null)?.attemptId
    if (typeof attemptId === 'string') cancelNotionOauth(attemptId)
  })
  ipcMain.handle(NOTION_OAUTH_LIST_DATABASES_CHANNEL, (_evt, arg: unknown): NotionDbCandidate[] => {
    const attemptId = (arg as { attemptId?: unknown } | null)?.attemptId
    return typeof attemptId === 'string' ? listDatabases(attemptId) : []
  })
  ipcMain.handle(
    NOTION_OAUTH_SELECT_DATABASES_CHANNEL,
    async (_evt, arg: unknown): Promise<SelectResult> => {
      const a = (arg ?? {}) as { attemptId?: unknown; emailDbId?: unknown; calendarDbId?: unknown }
      if (
        typeof a.attemptId !== 'string' ||
        typeof a.emailDbId !== 'string' ||
        typeof a.calendarDbId !== 'string'
      ) {
        return { ok: false, errorCode: 'selection_invalid' }
      }
      return selectDatabases(a.attemptId, a.emailDbId, a.calendarDbId)
    }
  )
  ipcMain.handle(NOTION_OAUTH_REMOVE_CONNECTION_CHANNEL, (): RemoveResult => removeConnection())

  // app quit → 清干净（server / state / token / 候选列表）。
  app.on('before-quit', () => {
    if (active) cleanupAttempt(active)
  })
}

// ---- 测试钩子 -------------------------------------------------------------

export const __test__ = {
  setDeps(overrides: Partial<NotionOauthDeps>): void {
    deps = { ...deps, ...overrides }
  },
  resetDeps(): void {
    deps = { ...defaultDeps }
  },
  /** 内部态快照（不暴露 token/state 明文 —— 测试只需要存在性判断）。 */
  snapshot(): {
    hasActive: boolean
    attemptId: string | null
    phase: NotionOauthPhase | null
    port: number | null
    codeConsumed: boolean | null
    hasToken: boolean
    hasState: boolean
    candidateCount: number | null
    serverCount: number
  } {
    return {
      hasActive: active !== null,
      attemptId: active?.id ?? null,
      phase: active?.phase ?? null,
      port: active?.port ?? null,
      codeConsumed: active?.codeConsumed ?? null,
      hasToken: (active?.token ?? null) !== null,
      hasState: (active?.state ?? '') !== '',
      candidateCount: active?.candidates?.length ?? null,
      serverCount: active?.servers.length ?? 0
    }
  },
  /** 测试拿授权 URL 里的 state 用（真实浏览器流里 state 在 URL 上本就可见于本机）。 */
  currentState(): string | null {
    return active?.state ?? null
  },
  reset(): void {
    if (active) cleanupAttempt(active)
    deps = { ...defaultDeps }
  }
}
