// @vitest-environment happy-dom
//
// Wave 3 — `managed_local` 连接器真实 zh-CN 翻译渲染与 Python 兜底路径单测。
// 不 mock react-i18next，显式切 `await i18n.changeLanguage('zh-CN')` 验真中文文案与 ICU 插值。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

import i18n from '@shared/i18n'
import type { ConnectorCatalogEntry, ConnectorSummary } from '@shared/api/types'

await i18n.changeLanguage('zh-CN')

if (typeof window !== 'undefined' && window.localStorage == null) {
  const store = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear()
    }
  })
}

const { toastSuccess } = vi.hoisted(() => ({ toastSuccess: vi.fn() }))
vi.mock('@shared/state/toast', () => ({ toastError: vi.fn(), toastSuccess }))

const routerState = vi.hoisted(() => ({ search: {} as { item?: string } }))
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => routerState.search,
  useNavigate: () => vi.fn()
}))

const { flagFetch } = vi.hoisted(() => ({ flagFetch: vi.fn<() => Promise<boolean>>() }))
vi.mock('@shared/components/settings/custom-ai/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/components/settings/custom-ai/shared')>()),
  fetchConnectorToolsEnabled: flagFetch
}))

const { stableMailApi, chatApi, connectorApi } = vi.hoisted(() => {
  const chatApi = {
    getToolPrefs: vi.fn(),
    setToolPref: vi.fn(),
    bulkSetToolPrefs: vi.fn(),
    applyToolPrefsPreset: vi.fn(),
    resetToolPrefs: vi.fn(),
    setSendWhitelist: vi.fn()
  }
  const connectorApi = {
    list: vi.fn(),
    status: vi.fn(),
    oauthStart: vi.fn(),
    sync: vi.fn(),
    tools: vi.fn(),
    setEnabled: vi.fn(),
    setToolMode: vi.fn(),
    bulkSetToolMode: vi.fn(),
    setPreprocessEnabled: vi.fn(),
    disconnect: vi.fn(),
    purgeOrphans: vi.fn(),
    catalog: vi.fn(),
    setComposioKey: vi.fn(),
    clearComposioKey: vi.fn(),
    install: vi.fn(),
    installStatus: vi.fn(),
    uninstall: vi.fn(),
    setRuntimeOptions: vi.fn(),
    systemPermissions: vi.fn(),
    openSystemPermission: vi.fn()
  }
  return { stableMailApi: { chat: chatApi, connector: connectorApi }, chatApi, connectorApi }
})
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => stableMailApi
}))

import { ConnectorsConsolePage } from '../../../src/shared/components/connectors/ConnectorsConsolePage'

function renderConsole() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    createElement(QueryClientProvider, { client: qc }, createElement(ConnectorsConsolePage))
  )
}

beforeEach(() => {
  routerState.search = {}
  flagFetch.mockResolvedValue(true)
  chatApi.getToolPrefs.mockResolvedValue({
    tools: [
      {
        toolName: 'email_flag',
        group: 'email_write',
        defaultTier: 'auto',
        tier: null,
        effectiveTier: 'auto',
        configurable: true,
        dangerAuto: false
      }
    ],
    sendWhitelist: [],
    acceptEditsPreset: []
  })
  connectorApi.list.mockResolvedValue([])
  connectorApi.tools.mockResolvedValue([])
  connectorApi.catalog.mockResolvedValue({
    composio: { configured: false, updated_at: null },
    entries: []
  })
  connectorApi.install.mockResolvedValue({
    ok: true,
    connector_id: 'browser_use',
    installed: true,
    version: '0.0.41',
    mode: 'cdp_chrome',
    supported_modes: ['cdp_chrome', 'extension', 'isolated_profile'],
    runtime_config: { mode: 'cdp_chrome', browser_mode: 'cdp_chrome' },
    requires_permissions: [],
    platform_supported: true,
    executable: 'npx',
    error: null
  })
  connectorApi.systemPermissions.mockResolvedValue({
    platform: 'darwin',
    accessibility: 'denied',
    screen_recording: 'granted'
  })
  connectorApi.openSystemPermission.mockResolvedValue({
    ok: true,
    kind: 'accessibility',
    opened: true
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('ManagedLocal — 真实 zh-CN 文案与无 IPC 兜底', () => {
  test('目录卡片渲染中文「本机托管」「一键安装并启用」与诚实像素隐私告知', async () => {
    const entry: ConnectorCatalogEntry = {
      connector_id: 'browser_use',
      display_name: 'Browser Use',
      track: 'managed_local',
      server_url: null,
      description_key: 'settings.connectors.catalog.desc.browser_use',
      category: 'browser',
      logo_text: 'B',
      logo_color: '#111111',
      toolkits: [],
      tool_count: null,
      configured: false,
      superseded: false,
      platform_supported: true
    }
    connectorApi.catalog.mockResolvedValue({
      composio: { configured: false, updated_at: null },
      entries: [entry]
    })

    renderConsole()
    const rowBtn = await screen.findByRole('button', { name: /Browser Use/ })
    fireEvent.click(rowBtn)

    expect((await screen.findAllByText('本机托管')).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('截图与画面不走文本脱敏')).toBeTruthy()
    expect(screen.getByText(/privacyMaskMiddleware 仅对文本型工具入参和出参/)).toBeTruthy()

    const installBtn = screen.getByRole('button', { name: '一键安装并启用' })
    fireEvent.click(installBtn)
    await waitFor(() => expect(connectorApi.install).toHaveBeenCalledWith('browser_use'))
  })

  test('web 构建下 managed_local 目录安装被禁用并提示桌面端', async () => {
    vi.stubEnv('VITE_BUILD_TARGET', 'web')
    connectorApi.catalog.mockResolvedValue({
      composio: { configured: false, updated_at: null },
      entries: [
        {
          connector_id: 'desktop_use',
          display_name: 'Desktop Use',
          track: 'managed_local',
          server_url: null,
          description_key: 'settings.connectors.catalog.desc.desktop_use',
          category: 'desktop',
          logo_text: 'D',
          logo_color: '#111111',
          toolkits: [],
          tool_count: null,
          configured: false,
          superseded: false,
          platform_supported: true
        }
      ]
    })

    renderConsole()
    const rowBtn = await screen.findByRole('button', { name: /Desktop Use/ })
    fireEvent.click(rowBtn)

    await screen.findByText('本机托管运行时在本地电脑安装并操控本机程序，请在桌面端 App 中操作。')
    const installBtn = screen.getByRole('button', { name: '一键安装并启用' }) as HTMLButtonElement
    expect(installBtn.disabled).toBe(true)
  })

  test('无 window.electron 时 Desktop Use 安全回退 Python system-permissions 并展示中文 TCC 状态', async () => {
    const desktopRow: ConnectorSummary = {
      connector_id: 'desktop_use',
      display_name: 'Desktop Use',
      server_url: '',
      transport: 'stdio',
      status: 'connected',
      enabled: true,
      preprocess_enabled: false,
      scopes: null,
      last_error: null,
      last_synced_at: null,
      source: 'managed_local',
      credential: null,
      flow: null,
      superseded_by_catalog: false,
      is_custom: false,
      runtime_installed: true,
      requires_permissions: ['accessibility', 'screen_recording']
    }
    connectorApi.list.mockResolvedValue([desktopRow])

    renderConsole()
    const rowBtn = await screen.findByRole('button', { name: /Desktop Use/ })
    fireEvent.click(rowBtn)

    await screen.findByText('macOS 系统权限诊断')
    await waitFor(() => expect(connectorApi.systemPermissions).toHaveBeenCalledTimes(1))
    expect(screen.getByText('辅助功能')).toBeTruthy()
    expect(screen.getByText('屏幕录制')).toBeTruthy()
    expect(screen.getByText('未授权')).toBeTruthy()
    expect(screen.getByText('已授权')).toBeTruthy()

    const openButtons = screen.getAllByRole('button', { name: '前往系统设置' })
    fireEvent.click(openButtons[0])
    await waitFor(() => expect(connectorApi.openSystemPermission).toHaveBeenCalledWith('accessibility'))
  })
})
