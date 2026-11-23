import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  canInvokeElectronIpc,
  canSendElectronIpc,
  getElectronPlatform,
  invokeIpc,
  isElectronIpcAvailable,
  onIpcEvent,
  openExternalUrl,
  sendIpc,
  tryInvokeIpc
} from '@shared/ipc/client'
import { API_READY_CHANNEL } from '@shared/lib/ipcChannels'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('shared/ipc/client', () => {
  test('degrades cleanly when window.electron bridge is absent', async () => {
    vi.stubGlobal('window', { open: vi.fn() })
    expect(isElectronIpcAvailable()).toBe(false)
    expect(canInvokeElectronIpc()).toBe(false)
    expect(canSendElectronIpc()).toBe(false)
    expect(getElectronPlatform()).toBeUndefined()
    await expect(tryInvokeIpc('admin:dbPath')).resolves.toBeNull()
    await expect(invokeIpc('admin:dbPath')).rejects.toThrow(/IPC invoke unavailable/)
    expect(() => sendIpc('ping')).not.toThrow()
    expect(onIpcEvent(API_READY_CHANNEL, () => {})()).toBeUndefined()

    openExternalUrl('msteams://meet', 'https://teams.microsoft.com/l/meetup-join/1')
    expect(window.open).toHaveBeenCalledWith(
      'https://teams.microsoft.com/l/meetup-join/1',
      '_blank',
      'noopener'
    )
  })

  test('routes typed invoke, send, event subscription, and openExternal through bridge', async () => {
    const invoke = vi.fn().mockResolvedValue('/tmp/sync_store.db')
    const send = vi.fn()
    let registeredFn: ((evt: unknown, ...args: unknown[]) => void) | null = null
    const offMock = vi.fn()
    const on = vi.fn((_ch: string, fn: (evt: unknown, ...args: unknown[]) => void) => {
      registeredFn = fn
      return offMock
    })

    vi.stubGlobal('window', {
      open: vi.fn(),
      electron: {
        process: { platform: 'darwin' },
        ipcRenderer: { invoke, send, on }
      }
    })

    expect(isElectronIpcAvailable()).toBe(true)
    expect(canInvokeElectronIpc()).toBe(true)
    expect(canSendElectronIpc()).toBe(true)
    expect(getElectronPlatform()).toBe('darwin')

    await expect(invokeIpc('admin:dbPath')).resolves.toBe('/tmp/sync_store.db')
    sendIpc('appearance:surface', 'solid')
    expect(send).toHaveBeenCalledWith('appearance:surface', 'solid')

    const seen: unknown[] = []
    const unsub = onIpcEvent('mailagent:deeplink', (target) => seen.push(target))
    registeredFn!({ sender: {} }, { kind: 'kanban' })
    expect(seen).toEqual([{ kind: 'kanban' }])
    unsub()
    expect(offMock).toHaveBeenCalledTimes(1)

    openExternalUrl('https://example.com')
    expect(invoke).toHaveBeenCalledWith('shell:openExternal', 'https://example.com')
  })
})
