// Shared sender-guard and timeout constants for legacy calendar IPC handlers.

import type { IpcMainInvokeEvent } from 'electron'
import { ipcMain } from 'electron'

export const READ_TIMEOUT_MS = 30_000
export const WRITE_TIMEOUT_MS = 120_000

// F4 + F17 — assertSafeSender: defense-in-depth IPC sender frame URL allowlist.
// Rejects empty URLs and non-loopback/non-file origins.
export function assertSafeSender(event: IpcMainInvokeEvent, channel: string): void {
  const url = (event.senderFrame?.url || '').toLowerCase()
  if (
    url.startsWith('file://') ||
    url.startsWith('http://localhost') ||
    url.startsWith('http://127.0.0.1')
  ) {
    return
  }

  console.warn(
    `[calendar-handler] rejected unexpected IPC sender url=${JSON.stringify(url)} channel=${channel}`
  )
  throw new Error(`Rejected unexpected IPC sender: ${url || '(empty)'}`)
}

export function safeIpcHandle(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertSafeSender(event, channel)
    return handler(event, ...args)
  })
}
