import { BrowserWindow, Notification } from 'electron'

import { DEFAULT_API_PORT } from '@shared/lib/ports'
import { onSseEvent } from './events_bridge'
import { getLocalApiToken, LOCAL_TOKEN_HEADER } from './local_token'

interface MatterNotifyData {
  matter_id: number | string
  public_id: string
  matter_title: string
  signal_id: number | string
  why: string
}

interface MatterNotifyEvent {
  event_type: 'matter.notify'
  data: MatterNotifyData
}

function resolveApiBaseUrl(): string {
  const raw = process.env.MAILAGENT_API_PORT
  const parsed = raw == null ? Number.NaN : Number.parseInt(raw, 10)
  const port = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_API_PORT
  return `http://127.0.0.1:${port}/api`
}

function parseMatterNotifyEvent(payload: unknown): MatterNotifyEvent | null {
  if (!payload || typeof payload !== 'object') return null
  const event = payload as { event_type?: unknown; data?: unknown }
  if (event.event_type !== 'matter.notify' || !event.data || typeof event.data !== 'object') {
    return null
  }

  const data = event.data as Partial<MatterNotifyData>
  if (
    (typeof data.matter_id !== 'number' && typeof data.matter_id !== 'string') ||
    typeof data.public_id !== 'string' ||
    typeof data.matter_title !== 'string' ||
    (typeof data.signal_id !== 'number' && typeof data.signal_id !== 'string') ||
    typeof data.why !== 'string'
  ) {
    return null
  }

  return { event_type: 'matter.notify', data: data as MatterNotifyData }
}

async function acknowledgeNotification(data: MatterNotifyData): Promise<void> {
  const matterId = encodeURIComponent(String(data.matter_id))
  const signalId = encodeURIComponent(String(data.signal_id))
  await fetch(`${resolveApiBaseUrl()}/matters/${matterId}/attention/${signalId}/notified`, {
    method: 'POST',
    headers: { [LOCAL_TOKEN_HEADER]: getLocalApiToken() }
  })
}

function navigateToMatter(publicId: string, signalId: number | string): void {
  const mainWindow = BrowserWindow.getAllWindows()[0]
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
  mainWindow.webContents.send('matters:navigate', { publicId, signalId })
}

function handleSseEvent(payload: unknown): void {
  const event = parseMatterNotifyEvent(payload)
  if (!event || !Notification.isSupported()) return

  const notification = new Notification({
    title: event.data.matter_title,
    body: event.data.why
  })
  notification.on('click', () => navigateToMatter(event.data.public_id, event.data.signal_id))

  try {
    notification.show()
  } catch {
    return
  }
  void acknowledgeNotification(event.data).catch(() => undefined)
}

export function registerMatterNotifications(): () => void {
  return onSseEvent(handleSseEvent)
}

export const __testing = {
  parseMatterNotifyEvent,
  resolveApiBaseUrl
}
