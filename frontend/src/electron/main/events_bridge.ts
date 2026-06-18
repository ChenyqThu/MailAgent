// Sprint 16 — SSE events bridge.
//
// Main 进程持久连接 mail-sync 进程内的本地 SSE endpoint
// (http://127.0.0.1:9200/api/events/stream), 解析 SSE 帧, 通过
// IPC broadcast 给 renderer. 替换 EmailList / Sidebar / usePinnedSync
// 的 5s 硬轮询.
//
// 状态机:
//   idle          → 模块刚加载, 未启动
//   connecting    → 正在 fetch
//   connected     → 已收到 200 + 首批字节 (或心跳)
//   disconnected  → 上次连接 close (网络掉 / 服务端 shutdown)
//   reconnecting  → 计划在退避后重连
//   disabled      → MAILAGENT_SSE_ENABLED=false 时手动停用
//
// 退避: 1s → 2s → 5s → 10s → 30s (封顶 30s, 永远重连)
//
// IPC channels:
//   events:received  (push)  — broadcast 给 renderer; payload = SseEvent JSON
//   events:status    (push)  — broadcast 给 renderer; payload = EventsStatus
//   events:status    (invoke) — renderer 主动查询当前状态
//   events:reconnect (invoke) — renderer 手动触发立即重连

import { app, BrowserWindow, ipcMain } from 'electron'

import { getLocalApiToken, LOCAL_TOKEN_HEADER } from './local_token'

// ---- types --------------------------------------------------------------

export type EventsConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'disabled'

export interface EventsStatus {
  state: EventsConnectionState
  lastError: string | null
  lastEventTs: number | null
  url: string
}

interface ParsedSseEvent {
  event: string
  data: string
}

// ---- 内部状态 -------------------------------------------------------------

const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000]
let _state: EventsConnectionState = 'idle'
let _lastError: string | null = null
let _lastEventTs: number | null = null
let _abortController: AbortController | null = null
let _reconnectTimer: NodeJS.Timeout | null = null
let _backoffIdx = 0
let _attemptId = 0 // 自增避免 stale loop 复活
let _sseUrl = ''

// ---- broadcast helpers --------------------------------------------------

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send(channel, payload)
      } catch (err) {
        // 渲染进程已被销毁等 — 忽略
        void err
      }
    }
  }
}

function setState(next: EventsConnectionState, error: string | null = null): void {
  _state = next
  // B6 — 连上即清除上一次的错误。否则 reconnect 成功后 _lastError 残留 (下面的
  // `error !== null` 守卫让 setState('connected', null) 不清旧错), UI (RealtimeStorageTab
  // / StatusBar) 一直显示「fetch failed」不消失。connected 是唯一的成功态。
  if (next === 'connected') _lastError = null
  else if (error !== null) _lastError = error
  broadcast('events:status', currentStatus())
}

function currentStatus(): EventsStatus {
  return {
    state: _state,
    lastError: _lastError,
    lastEventTs: _lastEventTs,
    url: _sseUrl
  }
}

// ---- SSE 帧解析 ----------------------------------------------------------

/**
 * 增量 parse SSE 帧。
 *
 * SSE 帧由 `event:` / `data:` 行组成，空行结束。本函数接收累积 buffer，
 * 返回 [已解析事件列表, 剩余未完整 buffer]。
 *
 * 容错: 忽略 id: / retry: 等其他字段 (我们不需要); 多行 data 会合并 (规范是
 * 换行连接, 但我们的事件都是单行 JSON, 多行也安全).
 */
export function parseSseFrames(buffer: string): [ParsedSseEvent[], string] {
  const events: ParsedSseEvent[] = []
  // 空行(\n\n) 是 frame 分隔; 兼容 \r\n\r\n
  const normalized = buffer.replace(/\r\n/g, '\n')
  const lastBoundary = normalized.lastIndexOf('\n\n')
  if (lastBoundary < 0) return [events, buffer]

  const ready = normalized.slice(0, lastBoundary)
  const leftover = normalized.slice(lastBoundary + 2)

  for (const block of ready.split('\n\n')) {
    if (!block.trim()) continue
    let event = 'message'
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim())
      }
      // 忽略 id: / retry: / : (注释行)
    }
    events.push({ event, data: dataLines.join('\n') })
  }

  return [events, leftover]
}

// ---- 主循环 --------------------------------------------------------------

async function streamLoop(myAttemptId: number): Promise<void> {
  if (_abortController) {
    try {
      _abortController.abort()
    } catch {
      /* swallow */
    }
  }
  _abortController = new AbortController()
  setState('connecting')

  try {
    const resp = await fetch(_sseUrl, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
        // C2: 本地 token 鉴权 — 9200 SSE 配了 token 时要求此 header (sse_server._local_token_ok)。
        // 同机非 Electron 进程读不到流。dev/pm2 serve 未注入 token → 后端门关, 此 header 被忽略。
        [LOCAL_TOKEN_HEADER]: getLocalApiToken()
      },
      signal: _abortController.signal
    })

    if (!resp.ok || !resp.body) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`)
    }

    setState('connected', null) // setState 在 next==='connected' 时已清 _lastError (B6)
    _backoffIdx = 0 // 成功连上后重置退避

    const reader = resp.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      // 检查 attempt 是否仍然有效 (避免 stale loop 派发事件)
      if (myAttemptId !== _attemptId) {
        try {
          await reader.cancel()
        } catch {
          /* swallow */
        }
        return
      }
      buffer += decoder.decode(value, { stream: true })
      const [events, leftover] = parseSseFrames(buffer)
      buffer = leftover
      for (const ev of events) {
        if (ev.event === 'ping') continue // heartbeat
        if (ev.event !== 'mailagent') continue // 其他事件忽略
        _lastEventTs = Date.now()
        try {
          const payload = JSON.parse(ev.data)
          broadcast('events:received', payload)
        } catch (err) {
          // 单条 JSON 错不应该破坏整个流
          console.error('[events_bridge] failed to parse event JSON', err, ev.data)
        }
      }
    }

    // body 自然结束 (服务端 shutdown)
    setState('disconnected', 'stream ended')
  } catch (err) {
    const aborted =
      err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))
    if (aborted) {
      // 主动 abort (reconnect / shutdown / disable), 不进入退避
      return
    }
    const msg = err instanceof Error ? err.message : String(err)
    setState('disconnected', msg)
  }

  // 若仍是最新 attempt 才安排重连; 否则被新 streamLoop 接管
  if (myAttemptId !== _attemptId) return
  scheduleReconnect()
}

function scheduleReconnect(): void {
  if (_state === 'disabled') return
  const delay = BACKOFF_MS[Math.min(_backoffIdx, BACKOFF_MS.length - 1)]
  _backoffIdx += 1
  setState('reconnecting')
  if (_reconnectTimer) clearTimeout(_reconnectTimer)
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null
    _attemptId += 1
    void streamLoop(_attemptId)
  }, delay)
}

// ---- public API ---------------------------------------------------------

/**
 * 启动 events bridge.
 *
 * @param url SSE endpoint URL; 默认 http://127.0.0.1:9200/api/events/stream;
 *            $MAILAGENT_SSE_URL env 覆盖.
 */
export function startEventsBridge(url?: string): void {
  if (_state !== 'idle' && _state !== 'disabled') {
    // 防重复启动
    return
  }
  _sseUrl = url ?? process.env['MAILAGENT_SSE_URL'] ?? 'http://127.0.0.1:9200/api/events/stream'

  // 注册 IPC handlers (idempotent — Electron ipcMain.handle 重复注册同 channel 会抛)
  try {
    ipcMain.handle('events:status', () => currentStatus())
  } catch {
    /* already registered */
  }
  try {
    ipcMain.handle('events:reconnect', () => {
      // 立即重连: 清退避 + 取消当前 + 启新 attempt
      _backoffIdx = 0
      if (_reconnectTimer) {
        clearTimeout(_reconnectTimer)
        _reconnectTimer = null
      }
      if (_abortController) {
        try {
          _abortController.abort()
        } catch {
          /* swallow */
        }
      }
      _attemptId += 1
      void streamLoop(_attemptId)
      return currentStatus()
    })
  } catch {
    /* already registered */
  }

  // before-quit 清理
  app.once('before-quit', () => {
    stopEventsBridge()
  })

  _attemptId += 1
  void streamLoop(_attemptId)
}

/** 永久停用 (env disabled / 测试用). */
export function stopEventsBridge(): void {
  setState('disabled')
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer)
    _reconnectTimer = null
  }
  if (_abortController) {
    try {
      _abortController.abort()
    } catch {
      /* swallow */
    }
    _abortController = null
  }
}

// 测试 hook — 重置 module state, 避免单测互相影响
export const __testing = {
  parseSseFrames,
  currentStatus,
  reset(): void {
    stopEventsBridge()
    _state = 'idle'
    _lastError = null
    _lastEventTs = null
    _backoffIdx = 0
    _attemptId = 0
    _sseUrl = ''
  }
}
