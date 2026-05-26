// Phase 3 §P1-c — 共享 helpers for calendar handler 拆分.
// calendar-read.ts / calendar-write.ts / calendar-sync.ts 都从这里 import.

import type { IpcMainInvokeEvent } from 'electron'
import { ipcMain } from 'electron'

export const READ_TIMEOUT_MS = 30_000
export const WRITE_TIMEOUT_MS = 120_000

/** calendar_event 行 — better-sqlite3 raw return shape (read path mapper 输入). */
export interface DbCalendarRow {
  id: number
  ical_uid: string
  recurrence_id: string | null
  sequence: number
  summary: string | null
  description: string | null
  location: string | null
  organizer: string | null
  attendees_json: string | null
  dtstart_utc: number
  dtend_utc: number | null
  is_all_day: number
  rrule: string | null
  exdates_json: string | null
  rdates_json: string | null
  status: string | null
  response_status: string | null
  url: string | null
  ics_raw: string | null
  source: string
  notion_page_id: string | null
  related_email_internal_id: number | null
  calendar_name: string | null
}

export function epochToIso(epoch: number | null): string | null {
  if (epoch == null || Number.isNaN(epoch)) return null
  return new Date(epoch * 1000).toISOString()
}

export function parseJsonArray<T>(s: string | null): T[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

// F4 + F17 — assertSafeSender: defense-in-depth IPC sender frame URL 校验.
// Electron 默认 BrowserWindow + nodeIntegration:false + contextIsolation:true
// 已禁止外部 sender, 但 dev tools / BrowserView / 未来 webview 嵌入可能穿透.
// 只放行 file:// (打包后) + http://localhost (vite dev) + http://127.0.0.1.
// 拒绝时 throw, ipcMain.handle 自动 reject promise (renderer 收 error).
//
// F17 (Opus #H2): 严格化 — 老代码 ``if (!url) return`` 给"空 URL"放行作
// 测试环境兜底, 但 Electron lifecycle 早期 / BrowserView 刚 attach /
// about:blank 中转都可能拿到空 URL, 等于把 D in D 漏成 D in 0. 改成空
// URL 也 throw, vitest 直调 __testing.runXxx 不走 wrapper 不受影响.
export function assertSafeSender(
  event: IpcMainInvokeEvent,
  channel: string
): void {
  const url = (event.senderFrame?.url || '').toLowerCase()
  if (
    url.startsWith('file://') ||
    url.startsWith('http://localhost') ||
    url.startsWith('http://127.0.0.1')
  ) {
    return
  }
  // 空 URL 或非白名单 — 拒绝
  // eslint-disable-next-line no-console
  console.warn(
    `[calendar-handler] rejected unexpected IPC sender url=${JSON.stringify(url)} channel=${channel}`
  )
  throw new Error(`Rejected unexpected IPC sender: ${url || '(empty)'}`)
}

// F4 — wrapper 让所有 calendar handler 自动经过 sender 校验, 不必每个 callback
// 第一行手抖加 assertSafeSender.
export function safeIpcHandle(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertSafeSender(event, channel)
    return handler(event, ...args)
  })
}
