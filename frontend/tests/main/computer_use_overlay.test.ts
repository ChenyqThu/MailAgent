import { describe, expect, test, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn()
  },
  screen: {
    getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1440, height: 900 } })
  }
}))

const { COMPUTER_USE_IPC, IDLE_COMPUTER_USE_ACTIVITY } =
  await import('../../src/shared/computerUseOverlayContract')
const { registerComputerUseOverlay } = await import('../../src/electron/main/computer_use_overlay')

function createMockIpc() {
  const handles = new Map<string, (...args: unknown[]) => unknown>()
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  return {
    handles,
    listeners,
    ipc: {
      handle: (ch: string, fn: (...args: unknown[]) => unknown) => {
        handles.set(ch, fn)
      },
      removeHandler: (ch: string) => {
        handles.delete(ch)
      },
      on: (ch: string, fn: (...args: unknown[]) => void) => {
        const set = listeners.get(ch) ?? new Set()
        set.add(fn)
        listeners.set(ch, set)
      },
      removeListener: (ch: string, fn: (...args: unknown[]) => void) => {
        listeners.get(ch)?.delete(fn)
      }
    }
  }
}

function createFakeWindow() {
  let visible = false
  let destroyed = false
  const closedListeners: Array<() => void> = []
  return {
    sent: [] as Array<{ ch: string; payload: unknown }>,
    ignoreCalls: [] as Array<{ ignore: boolean; options?: { forward?: boolean } }>,
    alwaysOnTopCalls: [] as Array<{ flag: boolean; level?: string }>,
    loadedUrls: [] as string[],
    win: {
      isDestroyed: () => destroyed,
      isVisible: () => visible,
      showInactive: vi.fn(() => {
        visible = true
      }),
      hide: vi.fn(() => {
        visible = false
      }),
      close: vi.fn(() => {
        destroyed = true
        for (const fn of closedListeners) fn()
      }),
      setBounds: vi.fn(),
      setAlwaysOnTop: vi.fn((flag: boolean, level?: string) => {
        // tracked via spy
        void flag
        void level
      }),
      setVisibleOnAllWorkspaces: vi.fn(),
      setIgnoreMouseEvents: vi.fn(),
      loadURL: vi.fn(),
      loadFile: vi.fn(),
      on: (_event: 'closed', fn: () => void) => {
        closedListeners.push(fn)
      },
      webContents: {
        isLoading: () => false,
        once: vi.fn(),
        send: vi.fn()
      }
    }
  }
}

describe('registerComputerUseOverlay', () => {
  test('仅在 desktop surface 激活时显示屏幕提示遮罩，browser surface 仅广播状态不弹遮罩', () => {
    const mockIpc = createMockIpc()
    const mainWin = createFakeWindow()
    const createdOverlays: Array<ReturnType<typeof createFakeWindow>['win']> = []

    const controller = registerComputerUseOverlay({
      preloadPath: '/tmp/preload.mjs',
      rendererHtmlPath: '/tmp/index.html',
      ipc: mockIpc.ipc,
      platform: 'darwin',
      getPrimaryDisplayBounds: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
      getAllWindows: () => [mainWin.win],
      createWindow: () => {
        const f = createFakeWindow()
        createdOverlays.push(f.win)
        return f.win
      }
    })

    // Browser Use 启动：绝不弹出全屏屏幕遮罩，但主窗收到状态广播
    controller.reportActivity({
      active: true,
      runId: 'run-browser-1',
      surface: 'browser',
      actionLabel: 'browser_snapshot',
      currentTarget: 'https://oa.example.com',
      stepCount: 1,
      startedAt: 100
    })
    expect(createdOverlays).toHaveLength(0)
    expect(mainWin.win.webContents.send).toHaveBeenLastCalledWith(
      COMPUTER_USE_IPC.activityChanged,
      expect.objectContaining({ active: true, surface: 'browser', runId: 'run-browser-1' })
    )

    // 切换到 Desktop Use：创建全屏 click-through overlay 并置顶显示
    controller.reportActivity({
      active: true,
      runId: 'run-desktop-1',
      surface: 'desktop',
      actionLabel: 'desktop_click',
      currentTarget: 'Microsoft Teams',
      stepCount: 2,
      startedAt: 200
    })
    expect(createdOverlays).toHaveLength(1)
    const overlay = createdOverlays[0]
    expect(overlay.loadFile).toHaveBeenCalledWith('/tmp/index.html', { search: 'cuOverlay=1' })
    expect(overlay.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver')
    expect(overlay.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      visibleOnFullScreen: true
    })
    expect(overlay.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true })
    expect(overlay.showInactive).toHaveBeenCalledTimes(1)
    expect(overlay.isVisible()).toBe(true)

    // 悬浮药丸触发交互切换
    const interactiveListeners = [
      ...(mockIpc.listeners.get(COMPUTER_USE_IPC.overlaySetInteractive) ?? [])
    ]
    expect(interactiveListeners).toHaveLength(1)
    interactiveListeners[0]({}, true)
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)
    interactiveListeners[0]({}, false)
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true })

    // 任务结束回到空闲：自动隐藏遮罩
    controller.reportActivity(IDLE_COMPUTER_USE_ACTIVITY)
    expect(overlay.hide).toHaveBeenCalledTimes(1)
    expect(overlay.isVisible()).toBe(false)

    controller.dispose()
    expect(overlay.close).toHaveBeenCalledTimes(1)
  })

  test('stopActive 触发已注册的 abort 回调并立刻恢复 idle', async () => {
    const mockIpc = createMockIpc()
    const abortFn = vi.fn()
    const createdOverlays: Array<ReturnType<typeof createFakeWindow>['win']> = []

    const controller = registerComputerUseOverlay({
      preloadPath: '/tmp/preload.mjs',
      rendererHtmlPath: '/tmp/index.html',
      ipc: mockIpc.ipc,
      platform: 'darwin',
      getAllWindows: () => [],
      createWindow: () => {
        const f = createFakeWindow()
        createdOverlays.push(f.win)
        return f.win
      }
    })

    controller.registerAbort('run-1', abortFn)
    controller.reportActivity({
      active: true,
      runId: 'run-1',
      surface: 'desktop',
      actionLabel: 'desktop_ax_snapshot',
      currentTarget: 'Notes',
      stepCount: 1,
      startedAt: 10
    })

    const getStateHandler = mockIpc.handles.get(COMPUTER_USE_IPC.getState)
    expect(getStateHandler?.()).toMatchObject({ active: true, runId: 'run-1' })

    const stopHandler = mockIpc.handles.get(COMPUTER_USE_IPC.stopActive)
    const res = stopHandler?.() as { stopped: boolean }
    expect(res).toEqual({ stopped: true })
    expect(abortFn).toHaveBeenCalledTimes(1)
    expect(controller.getState()).toEqual(IDLE_COMPUTER_USE_ACTIVITY)
    expect(createdOverlays[0].isVisible()).toBe(false)

    controller.dispose()
  })
})
