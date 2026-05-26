/**
 * `mailagent://` deeplink 解析 + cold-start buffer (Sprint 19 island F6).
 *
 * 灵动岛 (ping-island) open 类 action (open_mail / open_notion) → plugin
 * `open mailagent://email/<id>` → 系统唤起 MailAgent 前端 → main `open-url`
 * (macOS) / `second-instance` argv (Win/Linux) → 本模块解析 → renderer 路由切到
 * 对应视图 (邮件 / 日历 / 看板).
 *
 * 解析逻辑纯函数 (parseDeeplink) 可单测; dispatch/sink 处理 cold-start 时序
 * (open-url 可能在 app ready / renderer mount 前触发, buffer 到 sink 注册后 flush).
 */

export interface DeeplinkTarget {
  kind: 'email' | 'calendar' | 'kanban' | 'llm' | 'settings'
  /** email internal_id (kind==='email') */
  id?: number
  /** calendar view / settings tab (kind==='calendar'|'settings') */
  view?: string
}

const SCHEME = 'mailagent'

/**
 * 解析 `mailagent://email/53675` / `mailagent://calendar?view=week` 等 → target.
 * 非法 / 未知 host → null (调用方 silent drop).
 */
export function parseDeeplink(raw: string): DeeplinkTarget | null {
  if (!raw || typeof raw !== 'string') return null
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== `${SCHEME}:`) return null
  const host = u.hostname
  const view = u.searchParams.get('view') || u.searchParams.get('tab') || undefined
  switch (host) {
    case 'email': {
      // mailagent://email/53675 — internal_id 在 pathname
      const seg = u.pathname.replace(/^\/+/, '').split('/')[0]
      const id = Number.parseInt(seg, 10)
      if (!Number.isInteger(id) || id < 0) return null
      return { kind: 'email', id }
    }
    case 'calendar':
      return { kind: 'calendar', view }
    case 'kanban':
      return { kind: 'kanban' }
    case 'llm':
      return { kind: 'llm' }
    case 'settings':
      return { kind: 'settings', view }
    default:
      return null
  }
}

/** 从 argv 提取首个 `mailagent://` url (Win/Linux second-instance / cold start). */
export function extractDeeplinkFromArgv(argv: readonly string[]): string | null {
  for (const a of argv) {
    if (typeof a === 'string' && a.startsWith(`${SCHEME}://`)) return a
  }
  return null
}

// ---- cold-start buffer + sink ------------------------------------------------
// open-url 在 macOS 冷启动 (app 未 ready) 时就可能触发, renderer 更晚 mount.
// 在 sink (= "聚焦窗口 + webContents.send") 注册前到达的 target 先 buffer, 注册时 flush.

let _pending: DeeplinkTarget | null = null
let _sink: ((t: DeeplinkTarget) => void) | null = null

/** 解析 raw url 并派发给 sink; sink 未就绪时 buffer 最后一个 target. */
export function dispatchDeeplink(raw: string): void {
  const t = parseDeeplink(raw)
  if (!t) return
  if (_sink) _sink(t)
  else _pending = t
}

/** 注册 sink (main whenReady + createWindow 后调); 有 buffer 立即 flush. */
export function setDeeplinkSink(fn: ((t: DeeplinkTarget) => void) | null): void {
  _sink = fn
  if (fn && _pending) {
    const p = _pending
    _pending = null
    fn(p)
  }
}

/** 测试用 — 清 buffer + sink. */
export function _resetDeeplinkStateForTest(): void {
  _pending = null
  _sink = null
}
