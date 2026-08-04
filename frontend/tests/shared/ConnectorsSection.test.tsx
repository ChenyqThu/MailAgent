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
//   5. (08-03 delete 特例退役) 破坏性写工具**照常可配** —— 「会不会毁数据」由 destructive
//      徽标承担，不再有一个恒 disabled 的第四 crud 档；只有 orphan 行仍锁定。
//   6. 断开必须先过确认对话框：只点「断开」不该发出 disconnect。
//   7. 远程 web 面「连接」按钮 disabled（OAuth 回调走 loopback，远程点了只会静默超时）。
//   8. (PR5) needs_reauth 不是 error 的同义词：主操作变「重新连接」——「重试」对一个被撤销的
//      授权永远无效，把用户送到唯一有用的那一步。
//   9. (PR5) `expires_at == null` 说「由自动刷新维护」而不是「未知」：有 refresh_token 的连接
//      （Notion）恒走这一支，旧文案把健康态说成可疑态。
//  10. (PR5) sync 结果带计数，且 orphaned>0 自动展开工具区 —— 说了「有 N 个失效」就得让证据
//      当场可见，不能让用户自己去翻。
//  11. (PR5) orphan 行数 > 0 才出「清理」入口，点了走 purgeOrphans + 刷新清单。
//
// 纯 UI 测试：useMailApi / flag fetcher / toast / i18n 全模块级 mock，不碰 IPC 与 better-sqlite3。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

import type { ConnectorSummary, ConnectorToolSummary } from '../../src/shared/api/types'

// t 恒返 key（断言按 key 走），但**记账**：插值参数是 syncDone 计数这类契约的唯一证据，
// 拼进返回值会把既有的 getByText(key) 断言全打散，所以查 mock.calls 而不是查 DOM 文本。
const { tMock } = vi.hoisted(() => ({
  tMock: vi.fn((key: string, _opts?: Record<string, unknown>) => key)
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tMock })
}))

const { toastSuccess } = vi.hoisted(() => ({ toastSuccess: vi.fn() }))
vi.mock('@shared/state/toast', () => ({ toastError: vi.fn(), toastSuccess }))

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
    disconnect: vi.fn(),
    purgeOrphans: vi.fn()
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
  // 08-03：曾经的 delete 行迁成「destructive 的 write」—— 服务端值域收敛后前端不再有恒
  // disabled 的第四档，这一行因此必须是**可配的**（下面有反转后的断言钉住）。
  tool({
    name: 'notion_delete_page',
    crud_type: 'write',
    destructive: true,
    enabled_override: null
  })
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
  connectorApi.sync.mockResolvedValue({
    connector_id: 'notion',
    total: 4,
    inserted: 0,
    updated: 4,
    orphaned: 0
  })
  connectorApi.purgeOrphans.mockResolvedValue({ connector_id: 'notion', purged: 1 })
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

  test('expires_at=null（有 refresh token）→ 说「由自动刷新维护」而不是「未知」', async () => {
    connectorApi.list.mockResolvedValue([
      { ...NOTION, credential: { ...NOTION.credential!, expires_at: null } }
    ])
    renderUi()
    await waitFor(() =>
      expect(screen.getByText('settings.connectors.tokenAutoRefresh')).toBeTruthy()
    )
    // 过期警告分支未被波及（这是**另一支**：无 refresh token 时才走）。
    expect(screen.queryByText('settings.connectors.tokenExpired')).toBeNull()
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
  test('展开后懒加载工具清单，四行全渲染', async () => {
    const { container } = renderUi()
    await waitFor(() => expect(screen.getByText('Notion')).toBeTruthy())
    expect(connectorApi.tools).not.toHaveBeenCalled()

    await expandTools(container, 'notion')
    await waitFor(() => expect(screen.getByText('notion_search')).toBeTruthy())
    expect(screen.getByText('notion_create_page')).toBeTruthy()
    expect(screen.getByText('notion_update_page')).toBeTruthy()
    expect(screen.getByText('notion_delete_page')).toBeTruthy()
    // destructive 徽标挂在两行（update + 迁移后的 delete→write）。
    expect(screen.getAllByText('settings.connectors.tools.destructive')).toHaveLength(2)
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

  test('destructive 的写工具照常可配 —— delete 特例退役后没有第四个恒禁用档', async () => {
    const { container } = renderUi()
    await waitFor(() => expect(screen.getByText('Notion')).toBeTruthy())
    await expandTools(container, 'notion')
    await waitFor(() => expect(stateGroups()).toHaveLength(4))

    const destructiveGroup = stateGroups()[3]
    for (const name of [STATE.default, STATE.on, STATE.off]) {
      // 本仓没装 jest-dom 匹配器 → 直接读原生 disabled 属性。
      expect(
        (within(destructiveGroup).getByRole('button', { name }) as HTMLButtonElement).disabled
      ).toBe(false)
    }
    fireEvent.click(within(destructiveGroup).getByRole('button', { name: STATE.on }))
    await waitFor(() =>
      expect(connectorApi.setToolEnabled).toHaveBeenCalledWith('notion', 'notion_delete_page', true)
    )
  })

  test('orphan 行仍恒锁定（远端已经没有这个工具，配了也不会注册）', async () => {
    connectorApi.tools.mockResolvedValue([
      ...TOOLS,
      tool({ name: 'notion_legacy_a', crud_type: 'read', orphan: true })
    ])
    const { container } = renderUi()
    await waitFor(() => expect(screen.getByText('Notion')).toBeTruthy())
    await expandTools(container, 'notion')
    await waitFor(() => expect(stateGroups()).toHaveLength(5))

    const orphanGroup = stateGroups()[4]
    for (const name of [STATE.default, STATE.on, STATE.off]) {
      expect(
        (within(orphanGroup).getByRole('button', { name }) as HTMLButtonElement).disabled
      ).toBe(true)
    }
    fireEvent.click(within(orphanGroup).getByRole('button', { name: STATE.on }))
    expect(connectorApi.setToolEnabled).not.toHaveBeenCalled()
  })
})

describe('ConnectorsSection — needs_reauth（PR5）', () => {
  const STALE = connector({
    connector_id: 'notion',
    display_name: 'Notion',
    status: 'needs_reauth',
    last_error: 'refresh token revoked'
  })

  test('药丸走 needsReauth，主操作文案是「重新连接」而不是「连接」', async () => {
    connectorApi.list.mockResolvedValue([STALE])
    renderUi()
    await waitFor(() =>
      expect(screen.getByText('settings.connectors.status.needsReauth')).toBeTruthy()
    )
    expect(screen.getByRole('button', { name: 'settings.connectors.reconnect' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'settings.connectors.connect' })).toBeNull()
    // needs_reauth ≠ connected：不该冒出同步 / 断开这些「连着才有意义」的操作。
    expect(screen.queryByRole('button', { name: 'settings.connectors.sync' })).toBeNull()
  })

  test('点「重新连接」走同一条 OAuth 连接流（没有第二套逻辑）', async () => {
    // happy-dom 的 window.open 会真去解析域名 —— 桩掉，否则测试输出里躺着一串 ENOTFOUND。
    vi.spyOn(window, 'open').mockReturnValue(null)
    connectorApi.list.mockResolvedValue([STALE])
    connectorApi.oauthStart.mockResolvedValue({
      connector_id: 'notion',
      authorize_url: 'https://notion.test/authorize',
      status: 'authorizing',
      callback_timeout_seconds: 300
    })
    renderUi()
    const btn = await screen.findByRole('button', { name: 'settings.connectors.reconnect' })
    fireEvent.click(btn)
    await waitFor(() => expect(connectorApi.oauthStart).toHaveBeenCalledWith('notion'))
  })

  test('error 行为不变：仍是「连接」按钮 + error 药丸', async () => {
    connectorApi.list.mockResolvedValue([{ ...STALE, status: 'error' as const }])
    renderUi()
    await waitFor(() => expect(screen.getByText('settings.connectors.status.error')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'settings.connectors.connect' })).toBeTruthy()
  })
})

describe('ConnectorsSection — sync 结果可见性（PR5）', () => {
  async function clickSync(): Promise<void> {
    renderUi()
    await waitFor(() => expect(screen.getByText('Notion')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'settings.connectors.sync' }))
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

  test('统计键缺席（服务端老版本 / 形状变了）→ 计数收窄成 0，绝不把 undefined 插进文案', async () => {
    connectorApi.sync.mockResolvedValue({ connector_id: 'notion' })
    await clickSync()
    await waitFor(() =>
      expect(tMock).toHaveBeenCalledWith('settings.connectors.syncDone', {
        inserted: 0,
        updated: 0,
        orphaned: 0
      })
    )
  })

  test('orphaned > 0 → 自动展开工具区（失效行当场可见）', async () => {
    connectorApi.sync.mockResolvedValue({
      connector_id: 'notion',
      total: 4,
      inserted: 0,
      updated: 3,
      orphaned: 1
    })
    await clickSync()
    // 展开 = 懒加载的工具 query 被启用 → 清单真的被拉了一次。
    await waitFor(() => expect(connectorApi.tools).toHaveBeenCalledWith('notion'))
  })

  test('orphaned = 0 → 不自动展开（没有需要看的东西就别把面板顶开）', async () => {
    await clickSync()
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
    expect(connectorApi.tools).not.toHaveBeenCalled()
  })
})

describe('ConnectorsSection — orphan 清理（PR5）', () => {
  const WITH_ORPHANS: ConnectorToolSummary[] = [
    ...TOOLS,
    tool({ name: 'notion_legacy_a', crud_type: 'read', orphan: true }),
    tool({ name: 'notion_legacy_b', crud_type: 'write', orphan: true })
  ]

  test('orphan 行数 = 0 → 不显示清理入口', async () => {
    const { container } = renderUi()
    await waitFor(() => expect(screen.getByText('Notion')).toBeTruthy())
    await expandTools(container, 'notion')
    await waitFor(() => expect(screen.getByText('notion_search')).toBeTruthy())
    expect(
      screen.queryByRole('button', { name: 'settings.connectors.tools.purgeOrphans' })
    ).toBeNull()
  })

  test('orphan 行数 > 0 → 显示清理入口，文案带行数', async () => {
    connectorApi.tools.mockResolvedValue(WITH_ORPHANS)
    const { container } = renderUi()
    await waitFor(() => expect(screen.getByText('Notion')).toBeTruthy())
    await expandTools(container, 'notion')
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'settings.connectors.tools.purgeOrphans' })
      ).toBeTruthy()
    )
    expect(tMock).toHaveBeenCalledWith('settings.connectors.tools.purgeOrphans', { count: 2 })
  })

  test('点清理 → 调 purgeOrphans 并重拉工具清单（无确认对话框：只删已失效行）', async () => {
    connectorApi.tools.mockResolvedValue(WITH_ORPHANS)
    const { container } = renderUi()
    await waitFor(() => expect(screen.getByText('Notion')).toBeTruthy())
    await expandTools(container, 'notion')
    const btn = await screen.findByRole('button', {
      name: 'settings.connectors.tools.purgeOrphans'
    })
    fireEvent.click(btn)
    await waitFor(() => expect(connectorApi.purgeOrphans).toHaveBeenCalledWith('notion'))
    // 没有 Dialog 挡在中间 —— 低风险动作不配确认卡。
    expect(screen.queryByRole('dialog')).toBeNull()
    // invalidate 生效 = 工具清单被重新拉了一次。
    await waitFor(() => expect(connectorApi.tools).toHaveBeenCalledTimes(2))
    expect(toastSuccess).toHaveBeenCalledWith('settings.connectors.tools.purgeDone')
    expect(tMock).toHaveBeenCalledWith('settings.connectors.tools.purgeDone', { count: 1 })
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
