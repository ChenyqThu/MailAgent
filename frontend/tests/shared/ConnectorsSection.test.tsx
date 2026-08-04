// @vitest-environment happy-dom
//
// ConnectorsSection — 设置-AI「外部连接（MCP）」区（08-01 阶段 1 PR4 · T2 lane）。
//
// 覆盖的契约（每条都是"改错了用户会中招"的那种，不是凑覆盖率）：
//   1. flag off（connectorToolsEnabled ≠ true）→ 整区不渲染，且**一个 /api/connector/* 请求
//      都不发**（flag off 时那些端点全 409，渲染一个只会报错的区块比不渲染更糟）。
//   2. 信任可见性：connected 行摆出 scopes 与令牌健康 —— 这是产品纲领，不是装饰。
//   3. 整体开关走 setEnabled 并刷新列表。
//   4. per-tool **三态**：'关'→false · '开'→true · '默认'→**null（清除覆盖）**。第三态最容易
//      被实现成 false，单独钉住。
//   5. delete 类工具的控件恒 disabled（后端置 true 会 403），但行**照常渲染**——清单完整性。
//   6. 断开必须先过确认对话框：只点「断开」不该发出 disconnect。
//   7. 远程 web 面「连接」按钮 disabled（OAuth 回调走 loopback，远程点了只会静默超时）。
//
// 纯 UI 测试：useMailApi / flag fetcher / toast / i18n 全模块级 mock，不碰 IPC 与 better-sqlite3。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

import type { ConnectorSummary, ConnectorToolSummary } from '../../src/shared/api/types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('@shared/state/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }))

// flag fetcher —— 部分 mock，保留 resolveApiBaseUrl 等真实实现（SkillsSection.test 同款手法）。
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
    disconnect: vi.fn()
  }
}))
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ connector: connectorApi })
}))

import { ConnectorsSection } from '../../src/shared/components/settings/custom-ai/ConnectorsSection'

// ─── fixtures ───────────────────────────────────────────────────────────────

const HOUR = 3600

function connector(
  partial: Partial<ConnectorSummary> & { connector_id: string }
): ConnectorSummary {
  return {
    connector_id: partial.connector_id,
    display_name: partial.display_name ?? partial.connector_id,
    server_url: partial.server_url ?? `https://mcp.${partial.connector_id}.test/mcp`,
    transport: partial.transport ?? 'http',
    status: partial.status ?? 'disconnected',
    enabled: partial.enabled ?? true,
    preprocess_enabled: partial.preprocess_enabled ?? false,
    scopes: partial.scopes ?? null,
    last_error: partial.last_error ?? null,
    last_synced_at: partial.last_synced_at ?? null,
    credential: partial.credential ?? null,
    flow: partial.flow ?? null
  }
}

const NOTION = connector({
  connector_id: 'notion',
  display_name: 'Notion',
  status: 'connected',
  enabled: true,
  scopes: ['notion.read', 'notion.write'],
  last_synced_at: Math.floor(Date.now() / 1000) - HOUR,
  credential: {
    has_tokens: true,
    has_client_info: true,
    // 未来时间 → 走 tokenExpires 而不是 tokenExpired。
    expires_at: Math.floor(Date.now() / 1000) + 24 * HOUR,
    scope: 'notion.read notion.write',
    updated_at: Math.floor(Date.now() / 1000) - HOUR
  }
})

const ATLASSIAN = connector({
  connector_id: 'atlassian',
  display_name: 'Atlassian',
  status: 'disconnected'
})

function tool(partial: Partial<ConnectorToolSummary> & { name: string }): ConnectorToolSummary {
  return {
    name: partial.name,
    description: partial.description ?? `${partial.name} description`,
    input_schema_json: partial.input_schema_json ?? null,
    output_schema_json: partial.output_schema_json ?? null,
    crud_type: partial.crud_type ?? 'read',
    destructive: partial.destructive ?? false,
    enabled_override: partial.enabled_override ?? null,
    effective_enabled: partial.effective_enabled ?? false,
    orphan: partial.orphan ?? false,
    first_seen_at: partial.first_seen_at ?? 0,
    last_seen_at: partial.last_seen_at ?? 0
  }
}

// 顺序 = 渲染顺序 = getAllByRole('group') 的下标顺序。
const TOOLS: ConnectorToolSummary[] = [
  tool({
    name: 'notion_search',
    crud_type: 'read',
    enabled_override: null,
    effective_enabled: true
  }),
  tool({ name: 'notion_create_page', crud_type: 'write', enabled_override: null }),
  tool({
    name: 'notion_update_page',
    crud_type: 'update',
    enabled_override: true,
    effective_enabled: true,
    destructive: true
  }),
  tool({ name: 'notion_delete_page', crud_type: 'delete', enabled_override: null })
]

const STATE = {
  default: 'settings.connectors.tools.state.default',
  on: 'settings.connectors.tools.state.on',
  off: 'settings.connectors.tools.state.off'
} as const

function renderUi() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    createElement(QueryClientProvider, { client: qc }, createElement(ConnectorsSection))
  )
}

/** 展开某个 connector 的工具面板（点行首的折叠按钮 —— 用 aria-controls 定位，
 *  比按可访问名匹配稳：那个按钮的名字包含整行的 meta 文本）。 */
async function expandTools(container: HTMLElement, id: string): Promise<void> {
  const toggle = container.querySelector(`[aria-controls="connector-tools-${id}"]`)
  expect(toggle).not.toBeNull()
  fireEvent.click(toggle as Element)
  await waitFor(() => expect(connectorApi.tools).toHaveBeenCalledWith(id))
}

function stateGroups(): HTMLElement[] {
  return screen.getAllByRole('group', { name: 'settings.connectors.tools.state.label' })
}

beforeEach(() => {
  flagFetch.mockResolvedValue(true)
  connectorApi.list.mockResolvedValue([NOTION])
  connectorApi.tools.mockResolvedValue(TOOLS)
  connectorApi.setEnabled.mockResolvedValue({ connector_id: 'notion', enabled: false })
  connectorApi.setToolEnabled.mockResolvedValue({
    connector_id: 'notion',
    tool_name: 'x',
    enabled_override: null,
    effective_enabled: false
  })
  connectorApi.disconnect.mockResolvedValue({ connector_id: 'notion', deleted_credentials: 2 })
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('ConnectorsSection — 门控', () => {
  test('flag off → 整区不渲染，且不打 /api/connector 请求', async () => {
    flagFetch.mockResolvedValue(false)
    renderUi()
    await waitFor(() => expect(flagFetch).toHaveBeenCalled())
    expect(screen.queryByText('settings.connectors.title')).toBeNull()
    expect(connectorApi.list).not.toHaveBeenCalled()
  })

  test('flag on → 渲染区块与连接行', async () => {
    renderUi()
    await waitFor(() => expect(screen.getByText('Notion')).toBeTruthy())
    expect(screen.getByText('settings.connectors.title')).toBeTruthy()
  })
})

describe('ConnectorsSection — 信任可见性', () => {
  test('connected 行摆出 scopes + 令牌有效期 + 上次同步', async () => {
    const { container } = renderUi()
    await waitFor(() => expect(screen.getByText('Notion')).toBeTruthy())

    expect(screen.getByText('notion.read')).toBeTruthy()
    expect(screen.getByText('notion.write')).toBeTruthy()
    expect(screen.getByText('settings.connectors.tokenExpires')).toBeTruthy()
    expect(screen.getByText('settings.connectors.lastSynced')).toBeTruthy()
    expect(screen.getByText('settings.connectors.status.connected')).toBeTruthy()
    // server_url 是 registry 静态字段，只有列表端点带 —— 行上必须看得见连的是哪台。
    expect(container.textContent).toContain('https://mcp.notion.test/mcp')
  })

  test('令牌已过期 → 走 tokenExpired 文案', async () => {
    connectorApi.list.mockResolvedValue([
      {
        ...NOTION,
        credential: { ...NOTION.credential!, expires_at: Math.floor(Date.now() / 1000) - HOUR }
      }
    ])
    renderUi()
    await waitFor(() => expect(screen.getByText('settings.connectors.tokenExpired')).toBeTruthy())
    expect(screen.queryByText('settings.connectors.tokenExpires')).toBeNull()
  })
})

describe('ConnectorsSection — 开关', () => {
  test('整体开关调 setEnabled 并刷新列表', async () => {
    renderUi()
    await waitFor(() => expect(screen.getByText('Notion')).toBeTruthy())

    fireEvent.click(screen.getByRole('switch', { name: 'settings.connectors.enabled' }))
    await waitFor(() => expect(connectorApi.setEnabled).toHaveBeenCalledWith('notion', false))
    // invalidate 生效 = 列表被重新拉了一次。
    await waitFor(() => expect(connectorApi.list).toHaveBeenCalledTimes(2))
  })

  test('邮件预处理授权位独立调 setPreprocessEnabled', async () => {
    connectorApi.setPreprocessEnabled.mockResolvedValue({
      connector_id: 'notion',
      preprocess_enabled: true
    })
    renderUi()
    await waitFor(() => expect(screen.getByText('Notion')).toBeTruthy())

    fireEvent.click(screen.getByRole('switch', { name: 'settings.connectors.preprocess' }))
    await waitFor(() =>
      expect(connectorApi.setPreprocessEnabled).toHaveBeenCalledWith('notion', true)
    )
  })
})

describe('ConnectorsSection — per-tool 三态', () => {
  test('展开后懒加载工具清单，四行全渲染（含 delete）', async () => {
    const { container } = renderUi()
    await waitFor(() => expect(screen.getByText('Notion')).toBeTruthy())
    expect(connectorApi.tools).not.toHaveBeenCalled()

    await expandTools(container, 'notion')
    await waitFor(() => expect(screen.getByText('notion_search')).toBeTruthy())
    expect(screen.getByText('notion_create_page')).toBeTruthy()
    expect(screen.getByText('notion_update_page')).toBeTruthy()
    expect(screen.getByText('notion_delete_page')).toBeTruthy()
    // destructive 徽标只挂在 notion_update_page 一行。
    expect(screen.getAllByText('settings.connectors.tools.destructive')).toHaveLength(1)
  })

  test("'关' → false · '开' → true · '默认' → null（清除覆盖）", async () => {
    const { container } = renderUi()
    await waitFor(() => expect(screen.getByText('Notion')).toBeTruthy())
    await expandTools(container, 'notion')
    await waitFor(() => expect(stateGroups()).toHaveLength(4))

    fireEvent.click(within(stateGroups()[0]).getByRole('button', { name: STATE.off }))
    await waitFor(() =>
      expect(connectorApi.setToolEnabled).toHaveBeenCalledWith('notion', 'notion_search', false)
    )

    fireEvent.click(within(stateGroups()[1]).getByRole('button', { name: STATE.on }))
    await waitFor(() =>
      expect(connectorApi.setToolEnabled).toHaveBeenCalledWith('notion', 'notion_create_page', true)
    )

    // 第三态：清除覆盖回默认档 —— 必须是 null，不是 false。
    fireEvent.click(within(stateGroups()[2]).getByRole('button', { name: STATE.default }))
    await waitFor(() =>
      expect(connectorApi.setToolEnabled).toHaveBeenCalledWith('notion', 'notion_update_page', null)
    )
  })

  test('delete 类行照常渲染，但三个档位全 disabled', async () => {
    const { container } = renderUi()
    await waitFor(() => expect(screen.getByText('Notion')).toBeTruthy())
    await expandTools(container, 'notion')
    await waitFor(() => expect(stateGroups()).toHaveLength(4))

    const deleteGroup = stateGroups()[3]
    for (const name of [STATE.default, STATE.on, STATE.off]) {
      // 本仓没装 jest-dom 匹配器 → 直接读原生 disabled 属性。
      expect(
        (within(deleteGroup).getByRole('button', { name }) as HTMLButtonElement).disabled
      ).toBe(true)
    }
    fireEvent.click(within(deleteGroup).getByRole('button', { name: STATE.on }))
    expect(connectorApi.setToolEnabled).not.toHaveBeenCalled()
  })
})

describe('ConnectorsSection — 断开', () => {
  test('必须先确认：点「断开」只开对话框，确认后才调 disconnect', async () => {
    renderUi()
    await waitFor(() => expect(screen.getByText('Notion')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'settings.connectors.disconnect' }))
    expect(connectorApi.disconnect).not.toHaveBeenCalled()

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('settings.connectors.disconnectDialog.desc')).toBeTruthy()

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'settings.connectors.disconnectDialog.confirm' })
    )
    await waitFor(() => expect(connectorApi.disconnect).toHaveBeenCalledWith('notion'))
  })
})

describe('ConnectorsSection — 远程 web', () => {
  test('web 构建下「连接」按钮 disabled（OAuth 回调走 loopback）', async () => {
    vi.stubEnv('VITE_BUILD_TARGET', 'web')
    connectorApi.list.mockResolvedValue([ATLASSIAN])
    renderUi()
    await waitFor(() => expect(screen.getByText('Atlassian')).toBeTruthy())

    const connect = screen.getByRole('button', {
      name: 'settings.connectors.connect'
    }) as HTMLButtonElement
    expect(connect.disabled).toBe(true)
    expect(screen.getByText('settings.connectors.connectWeb')).toBeTruthy()
  })

  test('桌面构建下「连接」按钮可用', async () => {
    connectorApi.list.mockResolvedValue([ATLASSIAN])
    renderUi()
    await waitFor(() => expect(screen.getByText('Atlassian')).toBeTruthy())

    const connect = screen.getByRole('button', {
      name: 'settings.connectors.connect'
    }) as HTMLButtonElement
    expect(connect.disabled).toBe(false)
  })
})
