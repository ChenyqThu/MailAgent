// task 08-20-notification-center M2 批 B4 — Electron main 侧信源 ×2 + macOS 原生通知 fanout。
//
// 覆盖三件交付物（notification_fanout.ts + handlers/updater.ts 挂点）：
//   ① publishNotificationToCenter 的 loopback 契约（snake_case body + local token +
//      永不 reject）；
//   ② updater update-downloaded 挂点的 publish 形状 + 「启动补发」= 重启后 re-download
//      再触发同 key publish（服务端 dedupe 吸收 —— 这里断言的是同 key 属性）；
//   ③ chat 挂点两向：manual turn（runId 非 null）不发 / headless persist 发；
//      origin='agent' 排除（Python run_worker 信源已覆盖，双发 = 骚扰面红线）；
//   ④ fanout：档位过滤（critical / action_required 之外不弹）、水位（注册前存量不弹）、
//      (id, recurrenceNo) seen set、debounce 合并连发、click 聚焦 + 深跳。
//
// harness 照 matter_notifications.test.ts（同一 SSE 桥、同一 Notification mock 形状）。

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
  app: { isPackaged: false, on: vi.fn(), getVersion: vi.fn(() => '1.2.3') },
  BrowserWindow: { getAllWindows: mocks.getAllWindowsMock },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  Notification: mocks.MockNotification
}))

// updater.ts 静态 import readSettings（→ keychain 图）；mock 掉保持叶子级。
vi.mock('../../src/electron/main/handlers/settings', () => ({
  readSettings: () => ({ autoDownloadUpdates: false })
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

import { __testing as eventsTesting } from '../../src/electron/main/events_bridge'
import {
  __testing as fanoutTesting,
  maybeNotifyChatRunFinished,
  publishNotificationToCenter,
  registerNotificationFanout
} from '../../src/electron/main/notification_fanout'
import {
  __resetForTesting as resetUpdaterForTesting,
  bindAutoUpdater,
  setBoundUpdater,
  type AutoUpdaterLike
} from '../../src/electron/main/handlers/updater'
import { LOCAL_TOKEN_HEADER } from '../../src/electron/main/local_token'

const API_PORT = 'MAILAGENT_API_PORT'
const savedApiPort = process.env[API_PORT]
const PUBLISH_URL = 'http://127.0.0.1:8317/api/notifications/publish'
const LIST_URL = 'http://127.0.0.1:8317/api/notifications?unreadOnly=true&limit=20'

type Listener = (...args: unknown[]) => void

function makeStubUpdater(): { stub: AutoUpdaterLike; fire: (ev: string, ...a: unknown[]) => void } {
  const listeners: Record<string, Listener[]> = {}
  const stub = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    logger: null,
    on(event: string, listener: Listener): void {
      ;(listeners[event] ??= []).push(listener)
    },
    checkForUpdates: vi.fn(async () => undefined),
    downloadUpdate: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(() => undefined)
  } as unknown as AutoUpdaterLike
  return {
    stub,
    fire: (event, ...args) => {
      for (const l of listeners[event] ?? []) l(...args)
    }
  }
}

/** fetch 调到 publish 端点的 JSON body 列表（按调用序）。 */
function publishBodies(): Array<Record<string, unknown>> {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([url]) => url === PUBLISH_URL)
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>)
}

function listResponse(items: Array<Record<string, unknown>>): Response {
  return new Response(JSON.stringify({ data: items }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

function wireItem(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 1,
    category: 'system',
    source: 'system_alert',
    severity: 'info',
    state: 'open',
    title: '通知',
    body: '正文',
    payload: null,
    recurrenceNo: 1,
    firstCreatedAt: 0,
    lastEventAt: 0,
    readAt: null,
    ...overrides
  }
}

beforeEach(() => {
  eventsTesting.reset()
  fanoutTesting.reset()
  resetUpdaterForTesting('1.2.3')
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
  setBoundUpdater(null)
  eventsTesting.reset()
  fanoutTesting.reset()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  if (savedApiPort == null) delete process.env[API_PORT]
  else process.env[API_PORT] = savedApiPort
})

describe('publishNotificationToCenter (loopback internal face)', () => {
  test('POSTs snake_case body with the local token header', async () => {
    await publishNotificationToCenter({
      category: 'system',
      source: 'updater',
      title: 'T',
      dedupeKey: 'k:1',
      body: 'B',
      severity: 'warn',
      payload: { link: { type: 'updater_restart' } }
    })

    expect(fetch).toHaveBeenCalledWith(
      PUBLISH_URL,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          [LOCAL_TOKEN_HEADER]: expect.any(String)
        })
      })
    )
    // 🔴 body 逐键断言（snake_case 契约 —— NotificationPublishRequest）。
    expect(publishBodies()).toEqual([
      {
        category: 'system',
        source: 'updater',
        severity: 'warn',
        title: 'T',
        body: 'B',
        dedupe_key: 'k:1',
        payload: { link: { type: 'updater_restart' } }
      }
    ])
  })

  test('never rejects: connection failure is swallowed (drop, no retry)', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('connection refused'))
    await expect(
      publishNotificationToCenter({ category: 'system', source: 's', title: 't', dedupeKey: 'k' })
    ).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledOnce()
  })
})

describe('updater update-downloaded → notification center', () => {
  test('publishes the update-ready shape on update-downloaded', async () => {
    const { stub, fire } = makeStubUpdater()
    bindAutoUpdater(stub)
    fire('update-downloaded', { version: '1.3.0', releaseName: 'Aurora' })

    await vi.waitFor(() => expect(publishBodies()).toHaveLength(1))
    const body = publishBodies()[0]
    expect(body.category).toBe('system')
    expect(body.source).toBe('updater')
    expect(body.severity).toBe('info')
    expect(body.dedupe_key).toBe('app_update:1.3.0')
    expect(body.title).toContain('1.3.0')
    expect(body.body).toContain('Aurora')
    expect(body.payload).toEqual({ link: { type: 'updater_restart' } })
  })

  test('startup republish: post-restart re-download re-publishes the SAME dedupe key', async () => {
    // 第一个进程生命周期：下载完成 → publish。
    const first = makeStubUpdater()
    bindAutoUpdater(first.stub)
    first.fire('update-downloaded', { version: '1.3.0', releaseName: null })
    await vi.waitFor(() => expect(publishBodies()).toHaveLength(1))

    // 模拟 app 重启（in-process 状态机清零）→ re-check → re-download 再次发出
    // update-downloaded → 同 key 再 publish，服务端 dedupe 吸收成计次。
    resetUpdaterForTesting('1.2.3')
    const second = makeStubUpdater()
    bindAutoUpdater(second.stub)
    second.fire('update-downloaded', { version: '1.3.0', releaseName: null })

    await vi.waitFor(() => expect(publishBodies()).toHaveLength(2))
    const [a, b] = publishBodies()
    expect(a.dedupe_key).toBe('app_update:1.3.0')
    expect(b.dedupe_key).toBe(a.dedupe_key)
  })

  test('publish failure never breaks the updater state machine', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('serve-api down'))
    const { stub, fire } = makeStubUpdater()
    bindAutoUpdater(stub)
    expect(() => fire('update-downloaded', { version: '1.3.0', releaseName: null })).not.toThrow()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  })
})

describe('chat turn persist → notification center (headless-only 判定)', () => {
  const getSessionSpy = vi.fn()

  beforeEach(() => {
    getSessionSpy.mockReset().mockReturnValue({ title: '整理周报', origin: null })
  })

  test('manual turn (leased runId) does NOT publish — 骚扰面红线', () => {
    maybeNotifyChatRunFinished({ sessionId: 5, runId: 'run-1' }, getSessionSpy)
    expect(fetch).not.toHaveBeenCalled()
    expect(getSessionSpy).not.toHaveBeenCalled()
  })

  test('unsaved session (sessionId null) does NOT publish', () => {
    maybeNotifyChatRunFinished({ sessionId: null, runId: null }, getSessionSpy)
    expect(fetch).not.toHaveBeenCalled()
  })

  test('headless persist (runId null, non-agent session) publishes the session link shape', async () => {
    maybeNotifyChatRunFinished({ sessionId: 5, runId: null }, getSessionSpy)
    await vi.waitFor(() => expect(publishBodies()).toHaveLength(1))
    expect(publishBodies()[0]).toEqual({
      category: 'results',
      source: 'chat_run',
      severity: 'info',
      title: '整理周报',
      body: 'AI 已在后台完成回复。',
      dedupe_key: 'chat_session:5:finished',
      payload: { link: { type: 'session', sessionId: 5 } }
    })
  })

  test("origin='agent' session does NOT publish (Python run_worker 信源已覆盖)", () => {
    getSessionSpy.mockReturnValue({ title: '每日摘要', origin: 'agent' })
    maybeNotifyChatRunFinished({ sessionId: 7, runId: null }, getSessionSpy)
    expect(fetch).not.toHaveBeenCalled()
  })

  test('missing/blank session title degrades to fallback copy (不硬造)', async () => {
    getSessionSpy.mockReturnValue(null)
    maybeNotifyChatRunFinished({ sessionId: 9, runId: null }, getSessionSpy)
    await vi.waitFor(() => expect(publishBodies()).toHaveLength(1))
    expect(publishBodies()[0].title).toBe('AI 对话完成')
  })

  test('a throwing session getter is swallowed (persist path unharmed)', () => {
    getSessionSpy.mockImplementation(() => {
      throw new Error('db closed')
    })
    expect(() =>
      maybeNotifyChatRunFinished({ sessionId: 5, runId: null }, getSessionSpy)
    ).not.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('macOS notification fanout', () => {
  test('alerts only critical / action_required above the watermark, then advances it', async () => {
    registerNotificationFanout()
    fanoutTesting.setWatermarkMs(1000)
    vi.mocked(fetch).mockResolvedValueOnce(
      listResponse([
        wireItem({
          id: 4,
          severity: 'warn',
          category: 'action_required',
          lastEventAt: 2002,
          title: '待审批'
        }),
        wireItem({
          id: 3,
          severity: 'info',
          category: 'results',
          lastEventAt: 2001,
          title: '结果'
        }),
        wireItem({
          id: 2,
          severity: 'critical',
          category: 'system',
          lastEventAt: 2000,
          title: '服务异常'
        }),
        wireItem({
          id: 1,
          severity: 'critical',
          category: 'system',
          lastEventAt: 900,
          title: '存量旧告警'
        })
      ])
    )

    await fanoutTesting.fetchAndAlert()

    // 弹的只有档位内且水位之上的两条（升序：旧的先弹）；info/results 与存量旧条不弹。
    expect(mocks.notificationInstances.map((n) => n.options.title)).toEqual(['服务异常', '待审批'])
    expect(mocks.notificationInstances.every((n) => n.show.mock.calls.length === 1)).toBe(true)
    // 水位推进到本快照最大 lastEventAt（含被档位过滤的条目）。
    expect(fanoutTesting.watermarkMs()).toBe(2002)
  })

  test('pre-registration backlog does not alert (watermark = registration time)', async () => {
    registerNotificationFanout()
    fanoutTesting.setWatermarkMs(5000)
    vi.mocked(fetch).mockResolvedValueOnce(
      listResponse([
        wireItem({ id: 1, severity: 'critical', lastEventAt: 4999 }),
        wireItem({ id: 2, category: 'action_required', lastEventAt: 1000 })
      ])
    )

    await fanoutTesting.fetchAndAlert()

    expect(mocks.notificationInstances).toHaveLength(0)
    expect(fanoutTesting.watermarkMs()).toBe(5000)
  })

  test('(id, recurrenceNo) seen set suppresses re-alert; a recurrence bump re-alerts', async () => {
    registerNotificationFanout()
    fanoutTesting.setWatermarkMs(1000)
    // 第一轮：id=1 rec=1 弹。
    vi.mocked(fetch).mockResolvedValueOnce(
      listResponse([wireItem({ id: 1, severity: 'critical', recurrenceNo: 1, lastEventAt: 2000 })])
    )
    await fanoutTesting.fetchAndAlert()
    expect(mocks.notificationInstances).toHaveLength(1)

    // 第二轮：同 (id, recurrenceNo)、仅 lastEventAt 前移 → seen set 拦下不重弹。
    vi.mocked(fetch).mockResolvedValueOnce(
      listResponse([wireItem({ id: 1, severity: 'critical', recurrenceNo: 1, lastEventAt: 3000 })])
    )
    await fanoutTesting.fetchAndAlert()
    expect(mocks.notificationInstances).toHaveLength(1)

    // 第三轮：计次 +1（dedupe 未读化语义「又发生了」）→ 再弹。
    vi.mocked(fetch).mockResolvedValueOnce(
      listResponse([wireItem({ id: 1, severity: 'critical', recurrenceNo: 2, lastEventAt: 4000 })])
    )
    await fanoutTesting.fetchAndAlert()
    expect(mocks.notificationInstances).toHaveLength(2)
  })

  test('debounce merges a burst of notification.changed into ONE list fetch', async () => {
    vi.useFakeTimers()
    registerNotificationFanout()
    fanoutTesting.setWatermarkMs(1000)
    vi.mocked(fetch).mockResolvedValue(listResponse([]))

    eventsTesting.dispatchSseEvent({
      event_type: 'notification.changed',
      data: { category: 'system' }
    })
    eventsTesting.dispatchSseEvent({
      event_type: 'notification.changed',
      data: { category: 'results' }
    })
    eventsTesting.dispatchSseEvent({ event_type: 'notification.changed', data: {} })
    expect(fetch).not.toHaveBeenCalled() // debounce 窗口内不拉

    await vi.advanceTimersByTimeAsync(500)
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith(
      LIST_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ [LOCAL_TOKEN_HEADER]: expect.any(String) })
      })
    )
  })

  test('unrelated SSE events never schedule a fetch', async () => {
    vi.useFakeTimers()
    registerNotificationFanout()
    eventsTesting.dispatchSseEvent({ event_type: 'matter.changed', data: {} })
    eventsTesting.dispatchSseEvent({ event_type: 'job.done', data: {} })
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetch).not.toHaveBeenCalled()
  })

  test('notification click focuses the main window and deep-links via notifications:navigate', async () => {
    mocks.isMinimizedMock.mockReturnValue(true)
    registerNotificationFanout()
    fanoutTesting.setWatermarkMs(1000)
    const payload = { link: { type: 'session', sessionId: 42 } }
    vi.mocked(fetch).mockResolvedValueOnce(
      listResponse([wireItem({ id: 8, category: 'action_required', lastEventAt: 2000, payload })])
    )
    await fanoutTesting.fetchAndAlert()
    expect(mocks.notificationInstances).toHaveLength(1)

    mocks.notificationInstances[0].emit('click')

    expect(mocks.restoreMock).toHaveBeenCalledOnce()
    expect(mocks.focusMock).toHaveBeenCalledOnce()
    expect(mocks.sendMock).toHaveBeenCalledWith('notifications:navigate', { id: 8, payload })
  })

  test('Notification unsupported → no throw, nothing shown', async () => {
    mocks.isSupportedMock.mockReturnValue(false)
    registerNotificationFanout()
    fanoutTesting.setWatermarkMs(1000)
    vi.mocked(fetch).mockResolvedValueOnce(
      listResponse([wireItem({ id: 1, severity: 'critical', lastEventAt: 2000 })])
    )
    await fanoutTesting.fetchAndAlert()
    expect(mocks.notificationInstances).toHaveLength(0)
  })
})
