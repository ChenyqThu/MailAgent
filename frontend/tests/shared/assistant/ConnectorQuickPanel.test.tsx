// @vitest-environment happy-dom
//
// ConnectorQuickPanel — composer 里的「外部连接」快捷面板（08-03 dogfood 批 · D2 lane）。
// 🔴 08-04 WP6 起入口收编进菜单，08-05 WP-13 又从「+」搬进**滑块菜单**（`ComposerToolsMenu`），
// 所以这里连**入口本身**一起测：「有没有那一项」就是原来的「渲不渲染那颗钮」，判据
// （`useConnectorQuickRows`）逐字未变。
//
// 覆盖的契约（每条都是"改错了用户会中招"的那种）：
//   1. 显隐三态。flag off / flag 未知（加载中、端点不可达）→ 菜单里**没有**「外部连接」项，
//      且**一个 `/api/connector/*` 请求都不发**（flag off 时那些端点全 409 —— PR5 刚修过一个
//      「不看 flag 就打 409」的破口，这里钉住不许重犯）。flag on 但零行 → 也不出该项。
//      🔴 附带钉住「菜单本身恒在」：connector 不可用不等于滑块菜单消失（技能项永远在）。
//   2. 开关写穿全局 `setEnabled` 并 invalidate `qk.connectors()` —— 与设置区**同一个**缓存
//      键，所以两处即时同步；这正是"面板只是全局位的镜像、不是第二套状态"的判据。
//   3. 副作用提示：成功后的 toast 必须说清「约 30s 内对 AI 生效」（gateway manifest TTL），
//      否则用户会在生效前反复开关一个看似没反应的东西。
//   4. needs_reauth 走红点 + 状态文案，且开关**禁用**（后端没有可用配置行，点了只会 404）。
//   5. 「管理」跳设置 AI tab（深链落点）。
//
// 纯 UI 测试：useMailApi / flag fetcher / router / toast / i18n 全模块级 mock，不碰 IPC。
// `useAui()` 在无 AuiProvider 时返回一个惰性 Proxy（只有真去调 `aui.composer()` 才炸），所以
// 这里不必架 runtime —— 附件项的点击链路由 composer_plus_menu.test.tsx 在真 runtime 上测。

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

// 两处路由 API：ConnectorQuickContent 用 useNavigate（只在二级挂载时调），滑块菜单本体用
// useRouter({warn:false})（触发器一挂载就在树上，见 ComposerToolsMenu 文件头）。
const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
  useRouter: () => ({ navigate: navigateMock })
}))

// flag fetcher —— 部分 mock，保留 resolveApiBaseUrl 等真实实现（ConnectorsSection.test 同款）。
const { flagFetch } = vi.hoisted(() => ({ flagFetch: vi.fn<() => Promise<boolean>>() }))
vi.mock('@shared/components/settings/custom-ai/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/components/settings/custom-ai/shared')>()),
  fetchConnectorToolsEnabled: flagFetch
}))

const { connectorApi, chatApi } = vi.hoisted(() => ({
  chatApi: {
    listSkills: vi.fn(async () => []),
    setSkillEnabled: vi.fn(async () => {})
  },
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
  useMailApi: () => ({ connector: connectorApi, chat: chatApi })
}))

import { ComposerToolsMenu } from '../../../src/shared/assistant/components/ComposerToolsMenu'

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
    mode_override: null,
    effective_mode: 'auto',
    orphan: false,
    first_seen_at: 0,
    last_seen_at: 0
  },
  {
    // 08-05 三档：显式 off 档（默认已是 auto——「不算进已启用」的行要显式关）。
    name: 'notion_create_page',
    description: '',
    input_schema_json: null,
    output_schema_json: null,
    crud_type: 'write',
    destructive: false,
    mode_override: 'off',
    effective_mode: 'off',
    orphan: false,
    first_seen_at: 0,
    last_seen_at: 0
  }
]

const LABEL = 'chat.connectors.label'
const TOOLS_LABEL = 'chat.tools.label'
const ENABLE_SWITCH = 'settings.connectors.enabled · Notion'

function renderUi(variant: 'icon' | 'chip' = 'icon') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(ComposerToolsMenu, { variant })
    )
  )
}

/** 打开滑块菜单（一级）。菜单恒在，所以这一步永远成立。 */
async function openToolsMenu(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: TOOLS_LABEL }))
  await screen.findByRole('menu', { name: TOOLS_LABEL })
}

/** 滑块 →「外部连接」→ 二级面板。 */
async function openPanel(): Promise<void> {
  await openToolsMenu()
  fireEvent.click(await screen.findByRole('menuitem', { name: LABEL }))
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
  test('flag off → 菜单里无「外部连接」项，且不打 /api/connector 请求', async () => {
    flagFetch.mockResolvedValue(false)
    renderUi()
    // 🔴 flag 查询本身也在 open 门后（composer_tools_menu.test.tsx 的计数闸钉这条），
    // 所以先开菜单再等它 —— 顺序反了会等一个永远不会发生的调用。
    await openToolsMenu()
    await waitFor(() => expect(flagFetch).toHaveBeenCalled())
    expect(screen.queryByRole('menuitem', { name: LABEL })).toBeNull()
    // 菜单本身恒在：附件项永远是它的第一项（connector 不可用 ≠ 「+」消失）。
    expect(screen.getByRole('menuitem', { name: 'chat.tools.skills' })).toBeTruthy()
    expect(connectorApi.list).not.toHaveBeenCalled()
  })

  test('flag 未知（fetch 永不 settle）→ 按 off 处理，同样零请求', async () => {
    flagFetch.mockImplementation(() => new Promise<boolean>(() => {}))
    renderUi()
    await openToolsMenu()
    await waitFor(() => expect(flagFetch).toHaveBeenCalled())
    expect(screen.queryByRole('menuitem', { name: LABEL })).toBeNull()
    expect(connectorApi.list).not.toHaveBeenCalled()
  })

  test('flag on 但零行 → 无该项（空面板的入口是纯噪音）', async () => {
    connectorApi.list.mockResolvedValue([])
    renderUi()
    await openToolsMenu()
    await waitFor(() => expect(connectorApi.list).toHaveBeenCalled())
    expect(screen.queryByRole('menuitem', { name: LABEL })).toBeNull()
  })

  test('flag on + 有行 → 菜单出该项，点进去是行与审批提示', async () => {
    renderUi()
    await openPanel()
    expect(screen.getByText('Notion')).toBeTruthy()
    expect(screen.getByText('chat.connectors.approvalHint')).toBeTruthy()
    // 二级面板顶上是返回钮：回一级仍在同一颗「+」上（不是关掉重开）。
    fireEvent.click(screen.getByRole('button', { name: 'chat.composer.back' }))
    expect(screen.getByRole('menu', { name: TOOLS_LABEL })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: LABEL })).toBeNull()
  })

  test('chip 变体同一套菜单（AgentComposer 落点）', async () => {
    renderUi('chip')
    await openPanel()
    expect(screen.getByText('Notion')).toBeTruthy()
  })

  // 🔴 check-WP6 修：从二级面板**用触发器**关掉再点开，必须回到一级菜单。原实现的触发器走裸
  // `setOpen(v => !v)`（只有 Escape / 点外 / 「管理」走会重置 view 的 close()），于是 view 卡在
  // 'connectors' —— 下一次点「+」直接弹外部连接面板，附件项凭空消失，「+」看起来时好时坏。
  test('从二级面板点触发器关掉后再点开 → 回一级菜单（view 不残留）', async () => {
    renderUi()
    await openPanel()

    const trigger = screen.getByRole('button', { name: TOOLS_LABEL })
    fireEvent.click(trigger)
    expect(screen.queryByRole('dialog', { name: LABEL })).toBeNull()

    fireEvent.click(trigger)
    expect(await screen.findByRole('menu', { name: TOOLS_LABEL })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: LABEL })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'chat.tools.skills' })).toBeTruthy()
  })
})

// 🔴 08-05 WP-03 时序闸（check 补）。上面那条「view 不残留」测的是**结果**（下次开必须是一级），
// 它在「复位写 close()」和「复位写 open 侧」两种实现下**都绿** —— 全局 setup 强制 reduced-motion，
// 关闭即同步卸载，中间那 120ms 根本不存在。接了退场动画之后，这两种写法不再等价：复位留在
// close() 会让二级面板在淡出途中当场变回一级菜单（宽度 268→196 抽一下）。故这里自己把
// matchMedia 换成「不 reduce」，把**退场期间的形态**钉住；两条断言各杀一种回退。
describe('ComposerToolsMenu — 二级面板退场期间不闪变（08-05 WP-03）', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({
          matches: false,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
          onchange: null
        }) as unknown as MediaQueryList
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  // 触发器与一级弹层同 aria-label，故一律带 role 限定选。
  const popoverOf = (role: string, label: string): Element | null =>
    document.querySelector(`[role="${role}"][aria-label="${label}"]`)

  test('Escape 关二级：退场那一拍仍是二级内容，播完才卸载，再开回一级', async () => {
    renderUi()
    await openPanel()

    fireEvent.keyDown(document, { key: 'Escape' })
    // ① 硬切实现（`{open && …}`）在这一行就已经是 null。
    expect(popoverOf('dialog', LABEL)).not.toBeNull()
    // ② 复位若留在 close()，这一拍已经变成一级菜单（本闸的第二种失败模式）。
    expect(popoverOf('menu', TOOLS_LABEL)).toBeNull()

    await waitFor(() => expect(popoverOf('dialog', LABEL)).toBeNull(), { timeout: 2000 })

    // ③ 复位挪到 open 侧后，「下次点「+」必须是一级」这条契约不能丢。
    fireEvent.click(screen.getByRole('button', { name: TOOLS_LABEL }))
    await waitFor(() => expect(popoverOf('menu', TOOLS_LABEL)).not.toBeNull(), { timeout: 2000 })
    expect(popoverOf('dialog', LABEL)).toBeNull()
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
  test('点「管理」跳 Connectors 配置台并收起整个弹层（一级菜单也不留）', async () => {
    // 08-06 — connector 唯一操作面迁到 /connectors（设置-AI 那个区只剩深链卡）。
    renderUi()
    await openPanel()

    fireEvent.click(screen.getByRole('button', { name: 'chat.connectors.manage' }))
    // 0812：配置台从独立 /connectors 撤回 Settings 的 connectors tab（深链带 item 透传）。
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/settings',
      search: { tab: 'connectors', item: 'external' }
    })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: LABEL })).toBeNull())
    expect(screen.queryByRole('menu', { name: TOOLS_LABEL })).toBeNull()
  })
})

// ── 08-06 owner dogfood ③：**connector 常驻强调点整个退役** ─────────────────────────
//
// 历史（留着是为了不再被"补回来"）：08-04 WP6 把「入口常驻强调色」降级成一颗角标小点，
// 08-05 WP-13 入口从「+」搬到滑块、点跟着搬，判据一直是「至少一个 connected 且 enabled 的
// connector」。08-06 owner 实机否掉了整个东西：
//   「快捷配置那里不要有 connector 就带固定右上角高亮点，会有误解，高亮点是用作提示的，
//     很容易导致用户频繁点开。」
// 病根是**语义借用** —— 本 app 的角标点一贯表示「有新东西值得看」（会话未读点、审批待办），
// 这里却拿去表达「有 connector 处于启用态」这个**常态**：连上就永远亮，把一个没有新信息的
// 入口训练成需要反复点开的东西。
//
// 下面两格守的是「删干净」+「信息没丢」：状态仍然可知，但都要**去看**才出现。
describe('ConnectorQuickPanel — 常驻强调点已退役（08-06 ③）', () => {
  test('🔴 有已连接且已启用的 connector（点最该亮的那一档）→ 滑块上没有任何常驻点', async () => {
    renderUi()
    await openToolsMenu()
    await waitFor(() => expect(connectorApi.list).toHaveBeenCalled())
    // 该项照常在（功能没动，只是不再自带高亮）。
    expect(await screen.findByRole('menuitem', { name: LABEL })).toBeTruthy()
    expect(screen.queryByTestId('tools-connector-dot')).toBeNull()
    // 🔴 连菜单行右边那颗同款点（判据同为 anyActive）也一起删 —— 整棵子树不许再有 coral 圆点，
    // 否则「换个位置画同一颗点」照样过测试。
    expect(document.querySelectorAll('[class*="bg-coral/100"]')).toHaveLength(0)
  })

  test('信息没丢：状态仍由「N/M」摘要 + hover 文案表达（要去看才出现，不抢注意力）', async () => {
    renderUi()
    await openToolsMenu()
    await waitFor(() => expect(connectorApi.list).toHaveBeenCalled())
    await screen.findByRole('menuitem', { name: LABEL })
    // `chat.tools.summary` 带 {enabled, total} 插值（t 恒返 key，参数查 mock.calls）。
    const summary = tMock.mock.calls.find(([key]) => key === 'chat.tools.summary')
    expect(summary?.[1]).toMatchObject({ enabled: 1, total: 1 })
    // hover 文案仍会说「已启用外部连接」。
    expect(tMock.mock.calls.some(([key]) => key === 'chat.connectors.activeHint')).toBe(true)
  })
})
