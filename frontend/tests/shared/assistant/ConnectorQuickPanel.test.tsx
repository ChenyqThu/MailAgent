// @vitest-environment happy-dom
//
// ConnectorQuickPanel — composer 里的「外部连接」快捷面板（08-03 dogfood 批 · D2 lane）。
//
// 覆盖的契约（每条都是"改错了用户会中招"的那种）：
//   1. 显隐三态。flag off / flag 未知（加载中、端点不可达）→ 入口不渲染，且**一个
//      `/api/connector/*` 请求都不发**（flag off 时那些端点全 409 —— PR5 刚修过一个「不看
//      flag 就打 409」的破口，这里钉住不许重犯）。flag on 但零行 → 也不渲染。
//   2. 开关写穿全局 `setEnabled` 并 invalidate `qk.connectors()` —— 与设置区**同一个**缓存
//      键，所以两处即时同步；这正是"面板只是全局位的镜像、不是第二套状态"的判据。
//   3. 副作用提示：成功后的 toast 必须说清「约 30s 内对 AI 生效」（gateway manifest TTL），
//      否则用户会在生效前反复开关一个看似没反应的东西。
//   4. needs_reauth 走红点 + 状态文案，且开关**禁用**（后端没有可用配置行，点了只会 404）。
//   5. 「管理」跳设置 AI tab（深链落点）。
//
// 纯 UI 测试：useMailApi / flag fetcher / router / toast / i18n 全模块级 mock，不碰 IPC。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

import type { ConnectorSummary, ConnectorToolSummary } from '../../../src/shared/api/types'

// t 恒返 key（断言按 key 走），插值参数查 mock.calls（syncDone 同款手法）。
const { tMock } = vi.hoisted(() => ({
  tMock: vi.fn((key: string, _opts?: Record<string, unknown>) => key)
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tMock })
}))

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))
vi.mock('@shared/state/toast', () => ({ toastError, toastSuccess }))

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigateMock }))

// flag fetcher —— 部分 mock，保留 resolveApiBaseUrl 等真实实现（ConnectorsSection.test 同款）。
const { flagFetch } = vi.hoisted(() => ({ flagFetch: vi.fn<() => Promise<boolean>>() }))
vi.mock('@shared/components/settings/custom-ai/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/components/settings/custom-ai/shared')>()),
  fetchConnectorToolsEnabled: flagFetch
}))

const { connectorApi } = vi.hoisted(() => ({
  connectorApi: {
    list: vi.fn(),
    status: vi.fn(),
    oauthStart: vi.fn(),
    sync: vi.fn(),
    tools: vi.fn(),
    setEnabled: vi.fn(),
    setToolEnabled: vi.fn(),
    setPreprocessEnabled: vi.fn(),
    disconnect: vi.fn(),
    purgeOrphans: vi.fn()
  }
}))
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ connector: connectorApi })
}))

import { ConnectorQuickPanel } from '../../../src/shared/assistant/components/ConnectorQuickPanel'

// ─── fixtures ───────────────────────────────────────────────────────────────

function connector(
  partial: Partial<ConnectorSummary> & { connector_id: string }
): ConnectorSummary {
  return {
    connector_id: partial.connector_id,
    display_name: partial.display_name ?? partial.connector_id,
    status: partial.status ?? 'connected',
    enabled: partial.enabled ?? true,
    preprocess_enabled: partial.preprocess_enabled ?? false,
    scopes: partial.scopes ?? null,
    last_error: partial.last_error ?? null,
    last_synced_at: partial.last_synced_at ?? null,
    credential: partial.credential ?? null,
    flow: partial.flow ?? null,
    server_url: partial.server_url ?? 'https://mcp.notion.test/mcp',
    transport: partial.transport ?? 'http'
  }
}

const NOTION = connector({ connector_id: 'notion', display_name: 'Notion' })

const TOOLS: ConnectorToolSummary[] = [
  {
    name: 'notion_search',
    description: '',
    input_schema_json: null,
    output_schema_json: null,
    crud_type: 'read',
    destructive: false,
    enabled_override: null,
    effective_enabled: true,
    orphan: false,
    first_seen_at: 0,
    last_seen_at: 0
  },
  {
    name: 'notion_create_page',
    description: '',
    input_schema_json: null,
    output_schema_json: null,
    crud_type: 'write',
    destructive: false,
    enabled_override: null,
    effective_enabled: false,
    orphan: false,
    first_seen_at: 0,
    last_seen_at: 0
  }
]

const LABEL = 'chat.connectors.label'
const ENABLE_SWITCH = 'settings.connectors.enabled · Notion'

function renderUi(variant: 'icon' | 'chip' = 'icon') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(ConnectorQuickPanel, { variant })
    )
  )
}

async function openPanel(): Promise<void> {
  const trigger = await screen.findByRole('button', { name: LABEL })
  fireEvent.click(trigger)
  await screen.findByRole('dialog', { name: LABEL })
}

beforeEach(() => {
  flagFetch.mockResolvedValue(true)
  connectorApi.list.mockResolvedValue([NOTION])
  connectorApi.tools.mockResolvedValue(TOOLS)
  connectorApi.setEnabled.mockResolvedValue({ connector_id: 'notion', enabled: false })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ConnectorQuickPanel — 显隐三态', () => {
  test('flag off → 入口不渲染，且不打 /api/connector 请求', async () => {
    flagFetch.mockResolvedValue(false)
    renderUi()
    await waitFor(() => expect(flagFetch).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: LABEL })).toBeNull()
    expect(connectorApi.list).not.toHaveBeenCalled()
  })

  test('flag 未知（fetch 永不 settle）→ 按 off 处理，同样零请求', async () => {
    flagFetch.mockImplementation(() => new Promise<boolean>(() => {}))
    renderUi()
    await waitFor(() => expect(flagFetch).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: LABEL })).toBeNull()
    expect(connectorApi.list).not.toHaveBeenCalled()
  })

  test('flag on 但零行 → 入口不渲染（空面板的入口是纯噪音）', async () => {
    connectorApi.list.mockResolvedValue([])
    renderUi()
    await waitFor(() => expect(connectorApi.list).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: LABEL })).toBeNull()
  })

  test('flag on + 有行 → 入口渲染，点开出行与审批提示', async () => {
    renderUi()
    await openPanel()
    expect(screen.getByText('Notion')).toBeTruthy()
    expect(screen.getByText('chat.connectors.approvalHint')).toBeTruthy()
  })

  test('chip 变体同样渲染入口（AgentComposer 落点）', async () => {
    renderUi('chip')
    expect(await screen.findByRole('button', { name: LABEL })).toBeTruthy()
  })
})

describe('ConnectorQuickPanel — 开关写穿', () => {
  test('Switch 调 setEnabled 并 invalidate 列表（与设置区同一缓存键）', async () => {
    renderUi()
    await openPanel()

    fireEvent.click(screen.getByRole('switch', { name: ENABLE_SWITCH }))
    await waitFor(() => expect(connectorApi.setEnabled).toHaveBeenCalledWith('notion', false))
    // invalidate 生效 = 列表被重新拉了一次。
    await waitFor(() => expect(connectorApi.list).toHaveBeenCalledTimes(2))
  })

  test('成功 toast 说清「约 30s 内对 AI 生效」（gateway manifest TTL）', async () => {
    renderUi()
    await openPanel()

    fireEvent.click(screen.getByRole('switch', { name: ENABLE_SWITCH }))
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        'chat.connectors.saved',
        'chat.connectors.savedDetail'
      )
    )
    expect(tMock).toHaveBeenCalledWith('chat.connectors.saved', { name: 'Notion' })
  })

  test('已连接行展示工具数（已启用/总数，orphan 不算进已启用）', async () => {
    connectorApi.tools.mockResolvedValue([...TOOLS, { ...TOOLS[0], name: 'gone', orphan: true }])
    renderUi()
    await openPanel()
    await waitFor(() =>
      expect(tMock).toHaveBeenCalledWith('chat.connectors.toolCount', { enabled: 1, total: 3 })
    )
  })
})

describe('ConnectorQuickPanel — 未连接 / 授权失效', () => {
  test('needs_reauth → 状态文案上行 + 开关禁用（无配置行，点了只会 404）', async () => {
    connectorApi.list.mockResolvedValue([
      connector({ connector_id: 'notion', display_name: 'Notion', status: 'needs_reauth' })
    ])
    renderUi()
    await openPanel()

    expect(screen.getByText('settings.connectors.status.needsReauth')).toBeTruthy()
    const sw = screen.getByRole('switch', { name: ENABLE_SWITCH }) as HTMLButtonElement
    expect(sw.disabled).toBe(true)
    // 未连接的行不该为了一个工具数去打 tools（那必然 409/空）。
    expect(connectorApi.tools).not.toHaveBeenCalled()
  })
})

describe('ConnectorQuickPanel — 管理深链', () => {
  test('点「管理」跳设置 AI tab 并收起面板', async () => {
    renderUi()
    await openPanel()

    fireEvent.click(screen.getByRole('button', { name: 'chat.connectors.manage' }))
    expect(navigateMock).toHaveBeenCalledWith({ to: '/settings', search: { tab: 'ai' } })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: LABEL })).toBeNull())
  })
})
