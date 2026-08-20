import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const notificationInstances: Array<{
    options: { title: string; body: string }
    show: ReturnType<typeof vi.fn>
    emit(event: string): void
  }> = []
  const isSupportedMock = vi.fn(() => true)
  const sendMock = vi.fn()
  const focusMock = vi.fn()
  const restoreMock = vi.fn()
  const isMinimizedMock = vi.fn(() => false)
  const isDestroyedMock = vi.fn(() => false)
  const mainWindowMock = {
    isDestroyed: isDestroyedMock,
    isMinimized: isMinimizedMock,
    restore: restoreMock,
    focus: focusMock,
    webContents: { send: sendMock }
  }
  const getAllWindowsMock = vi.fn(() => [mainWindowMock])

  class MockNotification {
    static isSupported = isSupportedMock

    readonly options: { title: string; body: string }
    readonly show = vi.fn()
    private readonly listeners = new Map<string, () => void>()

    constructor(options: { title: string; body: string }) {
      this.options = options
      notificationInstances.push(this)
    }

    on(event: string, listener: () => void): this {
      this.listeners.set(event, listener)
      return this
    }

    emit(event: string): void {
      this.listeners.get(event)?.()
    }
  }

  return {
    MockNotification,
    notificationInstances,
    isSupportedMock,
    sendMock,
    focusMock,
    restoreMock,
    isMinimizedMock,
    isDestroyedMock,
    mainWindowMock,
    getAllWindowsMock
  }
})

vi.mock('electron', () => ({
  app: { isPackaged: false, on: vi.fn(), getVersion: vi.fn(() => 'test') },
  BrowserWindow: { getAllWindows: mocks.getAllWindowsMock },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  Notification: mocks.MockNotification
}))

import { __testing as eventsTesting, onSseEvent } from '../../src/electron/main/events_bridge'
import { registerMatterNotifications } from '../../src/electron/main/matter_notifications'
import { LOCAL_TOKEN_HEADER } from '../../src/electron/main/local_token'

const API_PORT = 'MAILAGENT_API_PORT'
const savedApiPort = process.env[API_PORT]

function notifyEvent(): {
  event_type: 'matter.notify'
  data: Record<string, string | number>
} {
  return {
    event_type: 'matter.notify',
    data: {
      matter_id: 42,
      public_id: 'MAT-0042',
      matter_title: 'Renew vendor agreement',
      signal_id: 9,
      kind: 'deadline_near',
      severity: 'warn',
      why: 'Deadline is three days away'
    }
  }
}

beforeEach(() => {
  eventsTesting.reset()
  mocks.notificationInstances.length = 0
  mocks.isSupportedMock.mockReset().mockReturnValue(true)
  mocks.getAllWindowsMock.mockReset().mockReturnValue([mocks.mainWindowMock])
  mocks.sendMock.mockReset()
  mocks.focusMock.mockReset()
  mocks.restoreMock.mockReset()
  mocks.isMinimizedMock.mockReset().mockReturnValue(false)
  mocks.isDestroyedMock.mockReset().mockReturnValue(false)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
  process.env[API_PORT] = '8317'
})

afterEach(() => {
  eventsTesting.reset()
  vi.unstubAllGlobals()
  if (savedApiPort == null) delete process.env[API_PORT]
  else process.env[API_PORT] = savedApiPort
})

describe('matter notifications', () => {
  test('SSE tap exceptions are isolated and renderer broadcast still runs', () => {
    const brokenTap = vi.fn(() => {
      throw new Error('tap failed')
    })
    const healthyTap = vi.fn()
    onSseEvent(brokenTap)
    onSseEvent(healthyTap)

    expect(() => eventsTesting.dispatchSseEvent(notifyEvent())).not.toThrow()
    expect(brokenTap).toHaveBeenCalledOnce()
    expect(healthyTap).toHaveBeenCalledOnce()
    expect(mocks.sendMock).toHaveBeenCalledWith('events:received', notifyEvent())
  })

  test('matter.notify shows a native notification then ACKs with the local token', async () => {
    registerMatterNotifications()
    eventsTesting.dispatchSseEvent(notifyEvent())

    expect(mocks.notificationInstances).toHaveLength(1)
    expect(mocks.notificationInstances[0].options).toEqual({
      title: 'Renew vendor agreement',
      body: 'Deadline is three days away'
    })
    expect(mocks.notificationInstances[0].show).toHaveBeenCalledOnce()
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:8317/api/matters/42/attention/9/notified',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ [LOCAL_TOKEN_HEADER]: expect.any(String) })
        })
      )
    })
  })

  test('ACK rejection is swallowed without retrying or breaking the bridge', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('connection refused'))
    registerMatterNotifications()

    expect(() => eventsTesting.dispatchSseEvent(notifyEvent())).not.toThrow()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    expect(mocks.notificationInstances[0].show).toHaveBeenCalledOnce()
  })

  test('notification click restores and focuses the main window, then navigates', () => {
    mocks.isMinimizedMock.mockReturnValue(true)
    registerMatterNotifications()
    eventsTesting.dispatchSseEvent(notifyEvent())

    mocks.notificationInstances[0].emit('click')

    expect(mocks.restoreMock).toHaveBeenCalledOnce()
    expect(mocks.focusMock).toHaveBeenCalledOnce()
    expect(mocks.sendMock).toHaveBeenCalledWith('matters:navigate', {
      publicId: 'MAT-0042',
      signalId: 9
    })
  })

})
