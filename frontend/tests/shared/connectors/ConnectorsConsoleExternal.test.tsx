// @vitest-environment happy-dom
//
// Connectors 配置台 — 外部连接 lane（08-06 Lane B）。
//
// 接替已删除的 tests/shared/ConnectorsSection.test.tsx：数据契约不变（/api/connector/*），
// 交互面从设置区块换成 master-detail 配置台。钉住的契约（每条都是"改错了用户会中招"的）：
//   1. 左栏：已连行（状态点 + 轨道标识）+ 未连目录项（「连接」affordance）+ Composio 账户。
//   2. 工具清单懒加载的新形态：**没选中该 connector 就不打 tools 请求**。
//   3. 信任可见性：connected detail 摆出 scopes / 令牌健康（null → 自动刷新，不是「未知」）。
//   4. crud 类别**默认折叠**（owner 拍板）；destructive→auto 单个与组级批量都过红确认；
//      Reset permissions = bulkSetToolMode(null)；orphan 行恒锁定。
//   5. 断开必须过确认对话框；superseded 行默认勾「同时清除工具配置」；🔴 08-06 双向
//      superseded：detail 给「切换轨道」动作（预勾 purge），清掉后落到目录条目。
//   6. 双轨（契约 §3）：direct 条目不受 BYOK gate 约束（没 key 也能连）、web 面 disabled；
//      composio 条目受 gate + 一次性出站告知；`track` 缺席按 composio 容错。
//   7. needs_reauth 主操作是「重新连接」。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import type {
  ConnectorCatalogEntry,
  ConnectorSummary,
  ConnectorToolSummary,
  ToolApprovalPrefsPayload
} from '../../../src/shared/api/types'

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

// t 恒返 key，但**记账**：插值参数（syncDone 计数等）查 mock.calls 而不是查 DOM 文本。
const { tMock } = vi.hoisted(() => ({
  tMock: vi.fn((key: string, _opts?: Record<string, unknown>) => key)
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tMock })
}))

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
    clearComposioKey: vi.fn()
  }
  return { stableMailApi: { chat: chatApi, connector: connectorApi }, chatApi, connectorApi }
})
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => stableMailApi
}))

import { ConnectorsConsolePage } from '../../../src/shared/components/connectors/ConnectorsConsolePage'

// ─── fixtures ───────────────────────────────────────────────────────────────

const HOUR = 3600

function prefsPayload(): ToolApprovalPrefsPayload {
  return {
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
  }
}

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
    flow: partial.flow ?? null,
    source: partial.source ?? 'custom_mcp',
    superseded_by_catalog: partial.superseded_by_catalog ?? false
  }
}

/** 目录条目夹具 —— 08-06 双轨契约的默认形状（composio 轨）。`track`/`server_url` 可覆盖，
 *  容错用例会显式делete `track`。 */
function catalogEntry(
  partial: Partial<ConnectorCatalogEntry> & { connector_id: string }
): ConnectorCatalogEntry {
  return {
    connector_id: partial.connector_id,
    display_name: partial.display_name ?? partial.connector_id,
    track: partial.track ?? 'composio',
    server_url: partial.server_url ?? null,
    description_key:
      partial.description_key ?? `settings.connectors.catalog.desc.${partial.connector_id}`,
    category: partial.category ?? 'work',
    logo_text: partial.logo_text ?? 'X',
    logo_color: partial.logo_color ?? '#111111',
    toolkits: partial.toolkits ?? [partial.connector_id.toUpperCase()],
    tool_count: 'tool_count' in partial ? (partial.tool_count ?? null) : 12,
    configured: partial.configured ?? false,
    superseded: partial.superseded ?? false
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
    expires_at: Math.floor(Date.now() / 1000) + 24 * HOUR,
    scope: 'notion.read notion.write',
    updated_at: Math.floor(Date.now() / 1000) - HOUR
  }
})

function tool(partial: Partial<ConnectorToolSummary> & { name: string }): ConnectorToolSummary {
  return {
    name: partial.name,
    description: partial.description ?? `${partial.name} description`,
    input_schema_json: partial.input_schema_json ?? null,
    output_schema_json: partial.output_schema_json ?? null,
    crud_type: partial.crud_type ?? 'read',
    destructive: partial.destructive ?? false,
    mode_override: partial.mode_override ?? null,
    effective_mode: partial.effective_mode ?? 'auto',
    orphan: partial.orphan ?? false,
    first_seen_at: partial.first_seen_at ?? 0,
    last_seen_at: partial.last_seen_at ?? 0
  }
}

const TOOLS: ConnectorToolSummary[] = [
  tool({ name: 'notion_search', crud_type: 'read' }),
  tool({ name: 'notion_create_page', crud_type: 'write' }),
  tool({
    name: 'notion_update_page',
    crud_type: 'update',
    mode_override: 'ask',
    effective_mode: 'ask',
    destructive: true
  }),
  tool({ name: 'notion_delete_page', crud_type: 'write', destructive: true })
]

const MODE = {
  auto: 'settings.connectors.tools.mode.auto',
  ask: 'settings.connectors.tools.mode.ask',
  off: 'settings.connectors.tools.mode.off'
} as const

const NOTICE_KEY = 'mailagent.connectors.toolfaceNotice.v1.notion'
const COMPOSIO_NOTICE_KEY = 'mailagent.connectors.composioOutboundNotice.v1'

function renderUi() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    createElement(QueryClientProvider, { client: qc }, createElement(ConnectorsConsolePage))
  )
}

/** 左栏外部连接段的行（按行文本里的 display_name 找）。nav 先于行渲染（列表 query 在途时
 *  就有外壳），所以要等**行**出现而不是等 nav。 */
async function externalRow(name: string): Promise<HTMLElement> {
  let found: HTMLElement | undefined
  await waitFor(() => {
    const nav = screen.getByRole('navigation', { name: 'connectorsConsole.sectionExternal' })
    found = within(nav)
      .getAllByRole('button')
      .find((b) => b.textContent?.includes(name))
    expect(found).toBeTruthy()
  })
  return found as HTMLElement
}

async function selectConnector(name: string): Promise<void> {
  fireEvent.click(await externalRow(name))
}

/** 展开某 crud 组（组头折叠开关按 aria-controls 定位）。 */
async function expandCrudGroup(container: HTMLElement, id: string, crud: string): Promise<void> {
  await waitFor(() =>
    expect(
      container.querySelector(`[aria-controls="connector-tools-${id}-${crud}"]`)
    ).not.toBeNull()
  )
  fireEvent.click(
    container.querySelector(`[aria-controls="connector-tools-${id}-${crud}"]`) as Element
  )
}

function modeGroups(): HTMLElement[] {
  return screen.getAllByRole('group', { name: 'settings.connectors.tools.mode.label' })
}

beforeEach(() => {
  routerState.search = {}
  flagFetch.mockResolvedValue(true)
  chatApi.getToolPrefs.mockResolvedValue(prefsPayload())
  connectorApi.list.mockResolvedValue([NOTION])
  connectorApi.tools.mockResolvedValue(TOOLS)
  connectorApi.sync.mockResolvedValue({
    connector_id: 'notion',
    total: 4,
    inserted: 0,
    updated: 4,
    orphaned: 0
  })
  connectorApi.purgeOrphans.mockResolvedValue({ connector_id: 'notion', purged: 1 })
  connectorApi.setEnabled.mockResolvedValue({ connector_id: 'notion', enabled: false })
  connectorApi.setToolMode.mockResolvedValue({
    connector_id: 'notion',
    tool_name: 'x',
    mode_override: 'off',
    effective_mode: 'off'
  })
  connectorApi.bulkSetToolMode.mockResolvedValue({
    connector_id: 'notion',
    mode: null,
    crud_type: null,
    updated: 4
  })
  connectorApi.disconnect.mockResolvedValue({
    connector_id: 'notion',
    deleted_credentials: 2,
    purged: false
  })
  connectorApi.setPreprocessEnabled.mockResolvedValue({
    connector_id: 'notion',
    preprocess_enabled: true
  })
  connectorApi.catalog.mockResolvedValue({
    composio: { configured: false, updated_at: null },
    entries: []
  })
  connectorApi.setComposioKey.mockResolvedValue({ configured: true, updated_at: 1 })
  connectorApi.clearComposioKey.mockResolvedValue({ configured: false, updated_at: null })
  window.localStorage.setItem(NOTICE_KEY, '1')
  window.localStorage.setItem(COMPOSIO_NOTICE_KEY, '1')
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  window.localStorage.clear()
})

describe('ConnectorsConsole — 外部连接左栏', () => {
  test('已连行带轨道标识；工具清单**没选中就不拉**（懒加载新形态）', async () => {
    renderUi()
    const row = await externalRow('Notion')
    // 轨道标识来自行的 source 字段（custom_mcp → 直连）。
    expect(row.textContent).toContain('settings.connectors.viaDirect')
    // 默认选中是内置工具第一组 → connector tools 一个请求都没有。
    expect(connectorApi.tools).not.toHaveBeenCalled()

    fireEvent.click(row)
    await waitFor(() => expect(connectorApi.tools).toHaveBeenCalledWith('notion'))
  })

  test('未连目录项渲染「连接」affordance，点击落到目录 detail（不直接发起授权）', async () => {
    connectorApi.catalog.mockResolvedValue({
      composio: { configured: true, updated_at: 1 },
      entries: [catalogEntry({ connector_id: 'gmail', display_name: 'Gmail', tool_count: 15 })]
    })
    renderUi()
    const row = await externalRow('Gmail')
    expect(row.textContent).toContain('settings.connectors.connect')
    fireEvent.click(row)
    // detail 上是真正的连接按钮；仅选中不该发起授权。
    expect(connectorApi.oauthStart).not.toHaveBeenCalled()
    await screen.findByText('settings.connectors.catalog.desc.gmail')
  })

  test('`?item=external` 深链落到外部第一项（已连行优先）', async () => {
    routerState.search = { item: 'external' }
    renderUi()
    // Notion detail 打开 → 拉工具清单。
    await waitFor(() => expect(connectorApi.tools).toHaveBeenCalledWith('notion'))
  })
})

describe('ConnectorsConsole — connected detail 信任可见性', () => {
  test('scopes + 令牌有效期 + 上次同步 + server_url 全摆在 detail 上', async () => {
    const { container } = renderUi()
    await selectConnector('Notion')
    await waitFor(() => expect(screen.getByText('notion.read')).toBeTruthy())
    expect(screen.getByText('notion.write')).toBeTruthy()
    expect(screen.getByText('settings.connectors.tokenExpires')).toBeTruthy()
    expect(screen.getByText('settings.connectors.lastSynced')).toBeTruthy()
    expect(screen.getByText('settings.connectors.status.connected')).toBeTruthy()
    expect(container.textContent).toContain('https://mcp.notion.test/mcp')
  })

  test('expires_at=null（有 refresh token）→「由自动刷新维护」而不是「未知」', async () => {
    connectorApi.list.mockResolvedValue([
      { ...NOTION, credential: { ...NOTION.credential!, expires_at: null } }
    ])
    renderUi()
    await selectConnector('Notion')
    await waitFor(() =>
      expect(screen.getByText('settings.connectors.tokenAutoRefresh')).toBeTruthy()
    )
    expect(screen.queryByText('settings.connectors.tokenExpired')).toBeNull()
  })

  test('整体开关调 setEnabled；邮件预处理授权位独立调 setPreprocessEnabled', async () => {
    renderUi()
    await selectConnector('Notion')
    fireEvent.click(await screen.findByRole('switch', { name: 'settings.connectors.enabled' }))
    await waitFor(() => expect(connectorApi.setEnabled).toHaveBeenCalledWith('notion', false))
    fireEvent.click(screen.getByRole('switch', { name: 'settings.connectors.preprocess' }))
    await waitFor(() =>
      expect(connectorApi.setPreprocessEnabled).toHaveBeenCalledWith('notion', true)
    )
  })

  test('needs_reauth → 主操作是「重新连接」，不是「连接」也没有同步', async () => {
    connectorApi.list.mockResolvedValue([
      connector({ connector_id: 'notion', display_name: 'Notion', status: 'needs_reauth' })
    ])
    renderUi()
    await selectConnector('Notion')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'settings.connectors.reconnect' })).toBeTruthy()
    )
    expect(screen.queryByRole('button', { name: 'settings.connectors.connect' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'settings.connectors.sync' })).toBeNull()
  })
})

describe('ConnectorsConsole — 工具三档（默认折叠 + 危险确认）', () => {
  test('crud 组默认折叠（aria-expanded=false + 0fr + inert），点组头展开', async () => {
    const { container } = renderUi()
    await selectConnector('Notion')
    await waitFor(() =>
      expect(
        container.querySelector('[aria-controls="connector-tools-notion-read"]')
      ).not.toBeNull()
    )
    const toggle = container.querySelector(
      '[aria-controls="connector-tools-notion-read"]'
    ) as HTMLElement
    const region = container.querySelector('#connector-tools-notion-read') as HTMLElement
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(region.className).toContain('grid-rows-[0fr]')
    expect(region.hasAttribute('inert')).toBe(true)

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(region.className).toContain('grid-rows-[1fr]')
    expect(region.hasAttribute('inert')).toBe(false)
    expect(within(region).getByText('notion_search')).toBeTruthy()
  })

  test('destructive → auto 弹一次性红确认；取消不落库、确认才落', async () => {
    const { container } = renderUi()
    await selectConnector('Notion')
    await expandCrudGroup(container, 'notion', 'update')
    await waitFor(() => expect(screen.getByText('notion_update_page')).toBeTruthy())
    const seg = modeGroups().find((g) =>
      g.parentElement?.textContent?.includes('notion_update_page')
    ) as HTMLElement
    fireEvent.click(within(seg).getByRole('button', { name: MODE.auto }))
    expect(connectorApi.setToolMode).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('settings.connectors.destructiveAutoDialog.title')).toBeTruthy()
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'settings.connectors.destructiveAutoDialog.cancel'
      })
    )
    expect(connectorApi.setToolMode).not.toHaveBeenCalled()

    fireEvent.click(within(seg).getByRole('button', { name: MODE.auto }))
    const dialog2 = await screen.findByRole('dialog')
    fireEvent.click(
      within(dialog2).getByRole('button', {
        name: 'settings.connectors.destructiveAutoDialog.confirm'
      })
    )
    await waitFor(() =>
      expect(connectorApi.setToolMode).toHaveBeenCalledWith('notion', 'notion_update_page', 'auto')
    )
  })

  test('🔴 组级批量 auto 且组里有 destructive → 同样过红确认；批量 ask 直接落', async () => {
    const { container } = renderUi()
    await selectConnector('Notion')
    await waitFor(() =>
      expect(
        container.querySelector('[aria-controls="connector-tools-notion-write"]')
      ).not.toBeNull()
    )
    // write 组的批量下拉（组头右侧，不受折叠影响）。
    const bulkTriggers = screen.getAllByRole('button', {
      name: /settings\.connectors\.tools\.bulk\.label/
    })
    expect(bulkTriggers).toHaveLength(3) // read / write / update 各一
    fireEvent.click(bulkTriggers[1])
    fireEvent.click(
      await screen.findByRole('button', { name: 'settings.connectors.tools.bulk.auto' })
    )
    expect(connectorApi.bulkSetToolMode).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'settings.connectors.destructiveAutoDialog.confirm'
      })
    )
    await waitFor(() =>
      expect(connectorApi.bulkSetToolMode).toHaveBeenCalledWith('notion', 'auto', 'write')
    )

    connectorApi.bulkSetToolMode.mockClear()
    fireEvent.click(bulkTriggers[1])
    fireEvent.click(
      await screen.findByRole('button', { name: 'settings.connectors.tools.bulk.ask' })
    )
    await waitFor(() =>
      expect(connectorApi.bulkSetToolMode).toHaveBeenCalledWith('notion', 'ask', 'write')
    )
  })

  test('Reset permissions（顶部操作）→ bulkSetToolMode(null, 无 crud)', async () => {
    renderUi()
    await selectConnector('Notion')
    const reset = await screen.findByRole('button', {
      name: 'settings.connectors.tools.reset'
    })
    fireEvent.click(reset)
    await waitFor(() => expect(connectorApi.bulkSetToolMode).toHaveBeenCalledWith('notion', null))
  })

  test('orphan 行恒锁定（配了也不会注册）', async () => {
    connectorApi.tools.mockResolvedValue([
      ...TOOLS,
      tool({ name: 'notion_legacy_a', crud_type: 'read', orphan: true })
    ])
    const { container } = renderUi()
    await selectConnector('Notion')
    await expandCrudGroup(container, 'notion', 'read')
    await waitFor(() => expect(screen.getByText('notion_legacy_a')).toBeTruthy())
    const seg = modeGroups().find((g) =>
      g.parentElement?.textContent?.includes('notion_legacy_a')
    ) as HTMLElement
    for (const name of [MODE.auto, MODE.ask, MODE.off]) {
      expect((within(seg).getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    }
    fireEvent.click(within(seg).getByRole('button', { name: MODE.off }))
    expect(connectorApi.setToolMode).not.toHaveBeenCalled()
  })
})

describe('ConnectorsConsole — 断开与切换轨道', () => {
  test('断开必须过确认对话框；确认后 disconnect(id, false)', async () => {
    renderUi()
    await selectConnector('Notion')
    fireEvent.click(await screen.findByRole('button', { name: 'settings.connectors.disconnect' }))
    expect(connectorApi.disconnect).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'settings.connectors.disconnectDialog.confirm' })
    )
    await waitFor(() => expect(connectorApi.disconnect).toHaveBeenCalledWith('notion', false))
  })

  test('superseded 行：给「切换轨道」动作，预勾 purge，确认后 disconnect(id, true)', async () => {
    connectorApi.list.mockResolvedValue([{ ...NOTION, superseded_by_catalog: true }])
    renderUi()
    await selectConnector('Notion')
    // 直连行被 Composio 版取代（老方向）→ 老文案。
    await screen.findByText('settings.connectors.supersededHint')
    expect(screen.queryByText('connectorsConsole.supersededByDirect')).toBeNull()
    // 双向 superseded 不能只留一句提示 —— 必须有可执行的出路。
    fireEvent.click(await screen.findByRole('button', { name: 'connectorsConsole.switchTrack' }))
    const dialog = await screen.findByRole('dialog')
    const box = within(dialog).getByLabelText('settings.connectors.disconnectDialog.purge')
    expect((box as HTMLInputElement).checked).toBe(true)
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'settings.connectors.disconnectDialog.confirm' })
    )
    await waitFor(() => expect(connectorApi.disconnect).toHaveBeenCalledWith('notion', true))
  })

  test('🔴 反方向 superseded（composio 行、出厂轨已回直连 —— owner 的 atlassian 处境）→ 镜像文案', async () => {
    connectorApi.list.mockResolvedValue([
      connector({
        connector_id: 'atlassian',
        display_name: 'Atlassian',
        status: 'error',
        source: 'composio',
        last_error: 'Composio reported a failed connection for JIRA',
        superseded_by_catalog: true
      })
    ])
    renderUi()
    await selectConnector('Atlassian')
    // 方向必须对：这行是「Composio 版被直连版取代」，老文案（旧直连配置被 Composio 取代）
    // 与事实正好颠倒。
    await screen.findByText('connectorsConsole.supersededByDirect')
    expect(screen.queryByText('settings.connectors.supersededHint')).toBeNull()
    // error 行同样有切换轨道出路（旧 UI 的 error 行只有「连接」，无路可走）。
    expect(screen.getByRole('button', { name: 'connectorsConsole.switchTrack' })).toBeTruthy()
  })

  test('🔴 切轨走完整条路：行清掉后选中项落到同 id 的**目录**条目（direct 轨、可直接重连）', async () => {
    // 复核补：上一条只钉到 disconnect(id, true) 为止 —— 但「可执行性」的关键在**后半程**：
    // 行没了之后用户被丢在哪。掉回默认选中 = owner 得自己再找一遍 Atlassian，切轨这条路
    // 就断在最后一步（PRD §4.4 要的是「干净替换」，不是「清掉就完事」）。
    const ATLASSIAN_ROW = connector({
      connector_id: 'atlassian',
      display_name: 'Atlassian',
      status: 'error',
      source: 'composio',
      superseded_by_catalog: true
    })
    const DIRECT_ENTRY = catalogEntry({
      connector_id: 'atlassian',
      display_name: 'Atlassian',
      track: 'direct',
      server_url: 'https://mcp.atlassian.com/v1/mcp/authv2',
      toolkits: [],
      tool_count: null
    })
    // 🔴 目录里**另有一家未连**（Gmail 排在前面）：没有它这条用例是平凡的 —— 掉回默认选中
    // 也会撞上 `unconfiguredEntries[0]`，恰好还是 Atlassian，测不出「按 id 归位」这件事。
    const OTHER = catalogEntry({ connector_id: 'gmail', display_name: 'Gmail', tool_count: 15 })
    // 断开前：行在 + 目录条目 configured；断开（purge）后：行没了 + 目录条目空出来。
    connectorApi.list.mockResolvedValueOnce([ATLASSIAN_ROW]).mockResolvedValue([])
    connectorApi.catalog
      .mockResolvedValueOnce({
        composio: { configured: false, updated_at: null },
        entries: [OTHER, { ...DIRECT_ENTRY, configured: true, superseded: true }]
      })
      .mockResolvedValue({
        composio: { configured: false, updated_at: null },
        entries: [OTHER, DIRECT_ENTRY]
      })
    connectorApi.disconnect.mockResolvedValue({
      connector_id: 'atlassian',
      deleted_credentials: 1,
      purged: true
    })

    renderUi()
    await selectConnector('Atlassian')
    fireEvent.click(await screen.findByRole('button', { name: 'connectorsConsole.switchTrack' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'settings.connectors.disconnectDialog.confirm' })
    )
    await waitFor(() => expect(connectorApi.disconnect).toHaveBeenCalledWith('atlassian', true))

    // 落点 = 同 id 的目录 detail：官方端点在场、BYOK gate 不罩直连轨、连接当场可点。
    await screen.findByText('https://mcp.atlassian.com/v1/mcp/authv2')
    expect(screen.queryByText('settings.connectors.catalog.gateTitle')).toBeNull()
    expect(
      (screen.getByRole('button', { name: 'settings.connectors.connect' }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })
})

describe('ConnectorsConsole — 双轨目录（08-06 契约 §3）', () => {
  const DIRECT_NOTION = catalogEntry({
    connector_id: 'notion',
    display_name: 'Notion',
    track: 'direct',
    server_url: 'https://mcp.notion.com/mcp',
    toolkits: [],
    tool_count: null
  })
  const COMPOSIO_GMAIL = catalogEntry({
    connector_id: 'gmail',
    display_name: 'Gmail',
    tool_count: 15
  })

  test('direct 条目：没配 Composio key 也能连（BYOK gate 只罩 composio 轨）', async () => {
    connectorApi.oauthStart.mockResolvedValue({
      connector_id: 'notion',
      authorize_url: null,
      status: 'authorizing',
      callback_timeout_seconds: 300
    })
    connectorApi.list.mockResolvedValue([])
    connectorApi.catalog.mockResolvedValue({
      composio: { configured: false, updated_at: null },
      entries: [DIRECT_NOTION, COMPOSIO_GMAIL]
    })
    renderUi()
    await selectConnector('Notion')
    // direct 轨：无 gate 块、连接可点、显示官方端点、工具数如实说「连接后获取」。
    await screen.findByText('https://mcp.notion.com/mcp')
    expect(screen.getByText('connectorsConsole.toolCountUnknown')).toBeTruthy()
    expect(screen.queryByText('settings.connectors.catalog.gateTitle')).toBeNull()
    const connect = screen.getByRole('button', {
      name: 'settings.connectors.connect'
    }) as HTMLButtonElement
    expect(connect.disabled).toBe(false)
    fireEvent.click(connect)
    // direct 轨不经 Composio 出站告知，直接发起。
    await waitFor(() => expect(connectorApi.oauthStart).toHaveBeenCalledWith('notion'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('composio 条目：没配 key → gate 块 + 连接 disabled + 零授权请求', async () => {
    connectorApi.list.mockResolvedValue([])
    connectorApi.catalog.mockResolvedValue({
      composio: { configured: false, updated_at: null },
      entries: [COMPOSIO_GMAIL]
    })
    renderUi()
    await selectConnector('Gmail')
    await screen.findByText('settings.connectors.catalog.gateTitle')
    const connect = screen.getByRole('button', {
      name: 'settings.connectors.connect'
    }) as HTMLButtonElement
    expect(connect.disabled).toBe(true)
    fireEvent.click(connect)
    expect(connectorApi.oauthStart).not.toHaveBeenCalled()
  })

  test('composio 条目：配了 key，首连过一次性出站告知，确认后才 oauthStart', async () => {
    window.localStorage.removeItem(COMPOSIO_NOTICE_KEY)
    connectorApi.oauthStart.mockResolvedValue({
      connector_id: 'gmail',
      authorize_url: 'https://connect.composio.dev/link/abc',
      status: 'authorizing',
      callback_timeout_seconds: 300
    })
    vi.spyOn(window, 'open').mockReturnValue(null)
    connectorApi.list.mockResolvedValue([])
    connectorApi.catalog.mockResolvedValue({
      composio: { configured: true, updated_at: 1_700_000_000 },
      entries: [COMPOSIO_GMAIL]
    })
    renderUi()
    await selectConnector('Gmail')
    const connect = await screen.findByRole('button', { name: 'settings.connectors.connect' })
    expect((connect as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(connect)
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByText('settings.connectors.catalog.outboundDialog.title')
    ).toBeTruthy()
    expect(connectorApi.oauthStart).not.toHaveBeenCalled()
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'settings.connectors.catalog.outboundDialog.confirm'
      })
    )
    await waitFor(() => expect(connectorApi.oauthStart).toHaveBeenCalledWith('gmail'))
  })

  test('🔴 track 缺席（Lane A 未落地 / 老服务端）→ 按 composio 容错（gate 生效）', async () => {
    const legacy = catalogEntry({
      connector_id: 'gmail',
      display_name: 'Gmail',
      tool_count: 15
    }) as Record<string, unknown>
    delete legacy.track
    connectorApi.list.mockResolvedValue([])
    connectorApi.catalog.mockResolvedValue({
      composio: { configured: false, updated_at: null },
      entries: [legacy]
    })
    renderUi()
    await selectConnector('Gmail')
    // 缺 track 的条目按 composio 轨渲染：经 Composio 标识 + BYOK gate 罩住。
    await screen.findByText('settings.connectors.catalog.gateTitle')
    const connect = screen.getByRole('button', {
      name: 'settings.connectors.connect'
    }) as HTMLButtonElement
    expect(connect.disabled).toBe(true)
  })

  test('🔴 web 构建：direct 条目连接 disabled（loopback 回调），composio 条目照常可连', async () => {
    vi.stubEnv('VITE_BUILD_TARGET', 'web')
    connectorApi.list.mockResolvedValue([])
    connectorApi.catalog.mockResolvedValue({
      composio: { configured: true, updated_at: 1 },
      entries: [DIRECT_NOTION, COMPOSIO_GMAIL]
    })
    renderUi()
    await selectConnector('Notion')
    const directConnect = await screen.findByRole('button', {
      name: 'settings.connectors.connect'
    })
    expect((directConnect as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('settings.connectors.connectWeb')).toBeTruthy()

    await selectConnector('Gmail')
    await waitFor(() => {
      const btn = screen.getByRole('button', {
        name: 'settings.connectors.connect'
      }) as HTMLButtonElement
      expect(btn.disabled).toBe(false)
    })
  })

  test('composio 账户面：保存 key 走 setComposioKey 且输入框清空（明文不回显）', async () => {
    connectorApi.list.mockResolvedValue([])
    renderUi()
    fireEvent.click(await externalRow('connectorsConsole.composioAccount'))
    const input = await screen.findByLabelText('settings.connectors.catalog.keyLabel')
    expect((input as HTMLInputElement).type).toBe('password')
    fireEvent.change(input, { target: { value: 'ck_secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'settings.connectors.catalog.keySave' }))
    await waitFor(() => expect(connectorApi.setComposioKey).toHaveBeenCalledWith('ck_secret'))
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''))
  })
})

describe('ConnectorsConsole — 工具面变宽一次性概览', () => {
  test('未确认 → detail 出概览（计数来自清单）；「知道了」落标记并消失', async () => {
    window.localStorage.removeItem(NOTICE_KEY)
    renderUi()
    await selectConnector('Notion')
    await waitFor(() =>
      expect(screen.getByText('settings.connectors.toolfaceNotice.title')).toBeTruthy()
    )
    await waitFor(() =>
      expect(tMock).toHaveBeenCalledWith('settings.connectors.toolfaceNotice.body', {
        reads: 1,
        writes: 3,
        destructive: 2
      })
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.connectors.toolfaceNotice.dismiss' })
    )
    expect(window.localStorage.getItem(NOTICE_KEY)).toBe('1')
    expect(screen.queryByText('settings.connectors.toolfaceNotice.title')).toBeNull()
  })

  test('已确认（默认种子）→ 概览不渲染（一次性就是一次性）', async () => {
    renderUi()
    await selectConnector('Notion')
    await waitFor(() => expect(screen.getByText('notion.read')).toBeTruthy())
    expect(screen.queryByText('settings.connectors.toolfaceNotice.title')).toBeNull()
  })
})

// ─── 08-06 复核补回：迁移时丢掉的既有契约（功能都还在，只是没测试钉着）──────────
//
// 下面这些用例是从已删除的 tests/shared/ConnectorsSection.test.tsx 逐 case 对照后补回的
// 净损失覆盖。判据都实测过：把对应实现删掉/改坏，迁移后的 36 个用例**一个都不红**
//（实测：`{orphanCount > 0 ?` 改成恒 false、syncDone 的三个计数改成不传 —— 全绿）。

describe('ConnectorsConsole — 令牌健康（补回）', () => {
  test('令牌已过期 → 走 tokenExpired 文案（不是 tokenExpires）', async () => {
    connectorApi.list.mockResolvedValue([
      {
        ...NOTION,
        credential: { ...NOTION.credential!, expires_at: Math.floor(Date.now() / 1000) - HOUR }
      }
    ])
    renderUi()
    await selectConnector('Notion')
    await waitFor(() => expect(screen.getByText('settings.connectors.tokenExpired')).toBeTruthy())
    // 过期与未过期是**互斥**的两支：旧实现把过期说成「有效期至 …」正是这条要挡的。
    expect(screen.queryByText('settings.connectors.tokenExpires')).toBeNull()
  })
})

describe('ConnectorsConsole — 非 connected 行的主操作（补回）', () => {
  test('点「重新连接」走同一条 OAuth 连接流（没有第二套逻辑）', async () => {
    // happy-dom 的 window.open 会真去解析域名 —— 桩掉，否则输出里躺着一串 ENOTFOUND。
    vi.spyOn(window, 'open').mockReturnValue(null)
    connectorApi.list.mockResolvedValue([
      connector({ connector_id: 'notion', display_name: 'Notion', status: 'needs_reauth' })
    ])
    connectorApi.oauthStart.mockResolvedValue({
      connector_id: 'notion',
      authorize_url: 'https://notion.test/authorize',
      status: 'authorizing',
      callback_timeout_seconds: 300
    })
    renderUi()
    await selectConnector('Notion')
    fireEvent.click(await screen.findByRole('button', { name: 'settings.connectors.reconnect' }))
    await waitFor(() => expect(connectorApi.oauthStart).toHaveBeenCalledWith('notion'))
  })

  test('error 行：药丸走 error，主操作仍是「连接」；composio 行如实标「经 Composio」', async () => {
    connectorApi.list.mockResolvedValue([
      connector({
        connector_id: 'notion',
        display_name: 'Notion',
        status: 'error',
        source: 'composio',
        last_error: 'boom'
      })
    ])
    renderUi()
    await selectConnector('Notion')
    await waitFor(() => expect(screen.getByText('settings.connectors.status.error')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'settings.connectors.connect' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'settings.connectors.reconnect' })).toBeNull()
    // 出站告知：执行路线按**行的 source** 如实标注（不靠 URL 长相猜）。
    expect(screen.getAllByText('settings.connectors.viaComposio').length).toBeGreaterThan(0)
  })
})

describe('ConnectorsConsole — 三档直接落库（补回）', () => {
  test('非破坏性工具：off / ask 直接落 setToolMode 无确认；点已选中档不重复发', async () => {
    const { container } = renderUi()
    await selectConnector('Notion')
    await expandCrudGroup(container, 'notion', 'read')
    await waitFor(() => expect(screen.getByText('notion_search')).toBeTruthy())
    const seg = modeGroups().find((g) =>
      g.parentElement?.textContent?.includes('notion_search')
    ) as HTMLElement

    fireEvent.click(within(seg).getByRole('button', { name: MODE.off }))
    await waitFor(() =>
      expect(connectorApi.setToolMode).toHaveBeenCalledWith('notion', 'notion_search', 'off')
    )
    // 非破坏性不该弹红确认（确认是 destructive→auto 专属的摩擦，不是每次调档都拦）。
    expect(screen.queryByRole('dialog')).toBeNull()

    // 服务端回的清单里这一行仍是 auto（effective 没变）→ 点 auto = 点已选中档 = no-op。
    fireEvent.click(within(seg).getByRole('button', { name: MODE.auto }))
    expect(connectorApi.setToolMode).toHaveBeenCalledTimes(1)
  })
})

describe('ConnectorsConsole — sync 结果可见性（补回）', () => {
  async function clickSync(): Promise<void> {
    await selectConnector('Notion')
    fireEvent.click(await screen.findByRole('button', { name: 'settings.connectors.sync' }))
    await waitFor(() => expect(connectorApi.sync).toHaveBeenCalledWith('notion'))
  }

  test('toast 带 inserted/updated/orphaned 三个计数（不是固定文案）', async () => {
    connectorApi.sync.mockResolvedValue({
      connector_id: 'notion',
      total: 9,
      inserted: 2,
      updated: 4,
      orphaned: 3
    })
    renderUi()
    await clickSync()
    await waitFor(() =>
      expect(tMock).toHaveBeenCalledWith('settings.connectors.syncDone', {
        inserted: 2,
        updated: 4,
        orphaned: 3
      })
    )
    expect(toastSuccess).toHaveBeenCalledWith('settings.connectors.syncDone')
  })

  test('统计键缺席（老服务端 / 形状变了）→ 计数收窄成 0，绝不把 undefined 插进文案', async () => {
    connectorApi.sync.mockResolvedValue({ connector_id: 'notion' })
    renderUi()
    await clickSync()
    await waitFor(() =>
      expect(tMock).toHaveBeenCalledWith('settings.connectors.syncDone', {
        inserted: 0,
        updated: 0,
        orphaned: 0
      })
    )
  })

  test('orphaned > 0 → 自动展开**含 orphan 的组**（说了有失效就得让证据当场可见）', async () => {
    connectorApi.tools.mockResolvedValue([
      ...TOOLS,
      tool({ name: 'notion_legacy_a', crud_type: 'read', orphan: true })
    ])
    connectorApi.sync.mockResolvedValue({
      connector_id: 'notion',
      total: 5,
      inserted: 0,
      updated: 4,
      orphaned: 1
    })
    const { container } = renderUi()
    await clickSync()
    await waitFor(() =>
      expect(
        container
          .querySelector('[aria-controls="connector-tools-notion-read"]')
          ?.getAttribute('aria-expanded')
      ).toBe('true')
    )
    // 只展开有失效行的那一组 —— 不是把整张工具面顶开。
    expect(
      container
        .querySelector('[aria-controls="connector-tools-notion-write"]')
        ?.getAttribute('aria-expanded')
    ).toBe('false')
  })

  test('orphaned = 0 → 不自动展开（没有需要看的东西就别把面板顶开）', async () => {
    const { container } = renderUi()
    await clickSync()
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
    expect(
      container
        .querySelector('[aria-controls="connector-tools-notion-read"]')
        ?.getAttribute('aria-expanded')
    ).toBe('false')
  })
})

describe('ConnectorsConsole — orphan 清理（补回）', () => {
  const WITH_ORPHANS: ConnectorToolSummary[] = [
    ...TOOLS,
    tool({ name: 'notion_legacy_a', crud_type: 'read', orphan: true }),
    tool({ name: 'notion_legacy_b', crud_type: 'write', orphan: true })
  ]

  test('orphan 行数 = 0 → 不显示清理入口', async () => {
    renderUi()
    await selectConnector('Notion')
    await waitFor(() => expect(connectorApi.tools).toHaveBeenCalledWith('notion'))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'settings.connectors.tools.reset' })).toBeTruthy()
    )
    expect(
      screen.queryByRole('button', { name: 'settings.connectors.tools.purgeOrphans' })
    ).toBeNull()
  })

  test('orphan 行数 > 0 → 清理入口在场（文案带行数）；点它走 purgeOrphans + 重拉清单，无确认对话框', async () => {
    connectorApi.tools.mockResolvedValue(WITH_ORPHANS)
    renderUi()
    await selectConnector('Notion')
    const btn = await screen.findByRole('button', {
      name: 'settings.connectors.tools.purgeOrphans'
    })
    expect(tMock).toHaveBeenCalledWith('settings.connectors.tools.purgeOrphans', { count: 2 })

    fireEvent.click(btn)
    await waitFor(() => expect(connectorApi.purgeOrphans).toHaveBeenCalledWith('notion'))
    // 只删已失效行（恒不注册、恒不可调用）→ 低风险动作不配确认卡。
    expect(screen.queryByRole('dialog')).toBeNull()
    // invalidate 生效 = 工具清单被重新拉了一次。
    await waitFor(() => expect(connectorApi.tools).toHaveBeenCalledTimes(2))
    expect(toastSuccess).toHaveBeenCalledWith('settings.connectors.tools.purgeDone')
    expect(tMock).toHaveBeenCalledWith('settings.connectors.tools.purgeDone', { count: 1 })
  })
})

describe('ConnectorsConsole — 已配置目录条目不给第二个入口（补回）', () => {
  test('已连行占着同一个 id → 左栏只出一行（目录侧不重复渲染）', async () => {
    connectorApi.catalog.mockResolvedValue({
      composio: { configured: true, updated_at: 1 },
      entries: [
        catalogEntry({
          connector_id: 'notion',
          display_name: 'Notion',
          track: 'direct',
          server_url: 'https://mcp.notion.com/mcp',
          toolkits: [],
          tool_count: null,
          configured: true
        }),
        catalogEntry({ connector_id: 'gmail', display_name: 'Gmail', tool_count: 15 })
      ]
    })
    renderUi()
    await externalRow('Gmail')
    const nav = screen.getByRole('navigation', { name: 'connectorsConsole.sectionExternal' })
    const notionRows = within(nav)
      .getAllByRole('button')
      .filter((b) => b.textContent?.includes('Notion'))
    expect(notionRows).toHaveLength(1)
    // 留下的那一行是**已连行**（右侧是轨道标识），不是目录的「连接」卡。
    expect(notionRows[0].textContent).toContain('settings.connectors.viaDirect')
    expect(notionRows[0].textContent).not.toContain('settings.connectors.connect')
  })
})
