// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k })
}))

vi.mock('@shared/state/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn()
}))

const mockLaunchBrowserWindow = vi.fn(async () => ({
  launched: true,
  pid: 101,
  profile_dir: '/tmp/p',
  executable: '/tmp/chrome'
}))
const mockStopBrowserLive = vi.fn(async () => ({ stopped: true }))
const mockManagedCookieDomains = vi.fn(async () => ({
  domains: [{ domain: 'oa.example.com', count: 2 }],
  total_cookies: 2
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    connector: {
      launchBrowserWindow: mockLaunchBrowserWindow,
      stopBrowserLive: mockStopBrowserLive,
      managedCookieDomains: mockManagedCookieDomains
    }
  })
}))

class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.OPEN
  sent: Array<Record<string, unknown>> = []
  onopen: (() => void) | null = null
  onmessage: ((evt: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  url: string

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => {
      this.onopen?.()
    })
  }

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
  }

  emitJson(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }
}

const { ManagedBrowserPane } = await import('@shared/components/browser/ManagedBrowserPane')
const { resolveBrowserLiveWsUrl } = await import('@shared/lib/apiBaseUrl')
const { useManagedBrowserUi } = await import('@shared/state/managed-browser-ui')
const { IDLE_COMPUTER_USE_ACTIVITY } = await import('@shared/computerUseOverlayContract')

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
  mockLaunchBrowserWindow.mockClear()
  mockStopBrowserLive.mockClear()
  useManagedBrowserUi.setState({
    sidebarOpen: false,
    sidebarWidth: 520,
    dismissedRunId: null,
    pendingUrl: null,
    activity: IDLE_COMPUTER_USE_ACTIVITY
  })
  mockManagedCookieDomains.mockClear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (window as unknown as { electron?: unknown }).electron
})

describe('ManagedBrowserPane', () => {
  test('renders multi-tab state and dispatches navigate, tab controls, and mouse clicks over WS', async () => {
    const onActiveTitleChange = vi.fn()
    render(<ManagedBrowserPane mode="sidebar" onActiveTitleChange={onActiveTitleChange} />)

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]
    expect(ws.url).toBe(resolveBrowserLiveWsUrl())

    ws.emitJson({
      type: 'state',
      tabs: [
        { id: 't1', title: 'OA Portal', url: 'https://oa.example.com/inbox' },
        { id: 't2', title: 'Notion', url: 'https://www.notion.so' }
      ],
      activeTargetId: 't1',
      url: 'https://oa.example.com/inbox',
      title: 'OA Portal',
      headless: true
    })

    await waitFor(() => {
      expect(screen.getByText('OA Portal')).toBeTruthy()
      expect(screen.getByText('Notion')).toBeTruthy()
    })
    expect(onActiveTitleChange).toHaveBeenCalledWith('OA Portal')

    // URL input submits navigate command
    const urlInput = screen.getByLabelText('browserPane.urlPlaceholder') as HTMLInputElement
    expect(urlInput.value).toBe('https://oa.example.com/inbox')
    fireEvent.change(urlInput, { target: { value: 'https://erp.example.com' } })
    fireEvent.submit(urlInput.closest('form') as HTMLFormElement)
    expect(ws.sent).toContainEqual({ type: 'navigate', url: 'https://erp.example.com' })

    // Switch tab & new tab
    fireEvent.click(screen.getByText('Notion'))
    expect(ws.sent).toContainEqual({ type: 'switch_tab', targetId: 't2' })

    fireEvent.click(screen.getByLabelText('browserPane.newTab'))
    expect(ws.sent).toContainEqual({ type: 'new_tab', url: 'about:blank' })

    // Mouse down dispatches mousePressed
    const canvas = document.querySelector('canvas') as HTMLCanvasElement
    fireEvent.pointerDown(canvas, { clientX: 100, clientY: 50, button: 0, buttons: 1, detail: 1 })
    expect(ws.sent.some((cmd) => cmd.type === 'mouse' && cmd.action === 'mousePressed')).toBe(true)
  })

  test('displays Agent active banner and invokes stopActive IPC', async () => {
    const invokeMock = vi.fn(async () => ({ stopped: true }))
    ;(window as unknown as { electron?: unknown }).electron = {
      ipcRenderer: { invoke: invokeMock }
    }
    useManagedBrowserUi.getState().setActivity({
      active: true,
      runId: 'cu-browser-99',
      surface: 'browser',
      actionLabel: 'browser_click',
      currentTarget: 'https://oa.example.com',
      stepCount: 2,
      startedAt: Date.now()
    })

    render(<ManagedBrowserPane mode="tab" />)
    await waitFor(() => expect(screen.getByText('browserPane.agentControlling')).toBeTruthy())

    fireEvent.click(screen.getByText('browserPane.stopTakeover'))
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('computer-use:stop-active'))
  })

  test('renders setup fallback CTA when runtime is not installed', async () => {
    const onOpenConnectors = vi.fn()
    render(<ManagedBrowserPane mode="sidebar" onOpenConnectors={onOpenConnectors} />)
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    FakeWebSocket.instances[0].emitJson({
      type: 'error',
      code: 'E_RUNTIME_NOT_INSTALLED',
      message: '请先安装 Browser Use'
    })

    await waitFor(() => expect(screen.getByText('browserPane.notInstalledTitle')).toBeTruthy())
    fireEvent.click(screen.getByText('browserPane.openConnectors'))
    expect(onOpenConnectors).toHaveBeenCalledTimes(1)
  })

  test('consumes pendingUrl on connect and opens inline cookie manager via more menu', async () => {
    useManagedBrowserUi.getState().setPendingUrl('https://docs.example.com/guide')
    render(<ManagedBrowserPane mode="sidebar" />)

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]
    await waitFor(() =>
      expect(ws.sent).toContainEqual({ type: 'navigate', url: 'https://docs.example.com/guide' })
    )
    expect(useManagedBrowserUi.getState().pendingUrl).toBeNull()

    // Open more menu -> open cookie manager panel inline
    fireEvent.click(screen.getByLabelText('browserPane.moreMenu'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'browserPane.manageCookies' }))
    await screen.findByTestId('browser-cookie-manager')
    await waitFor(() => expect(mockManagedCookieDomains).toHaveBeenCalledTimes(1))
  })
})
