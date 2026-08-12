// @vitest-environment happy-dom
//
// Connectors 配置台 — 内置工具 lane（08-06 Lane B）。
//
// 接替已删除的 tests/shared/ToolApprovalSection.test.tsx：数据契约不变（GET /api/agent/
// tool-prefs 全量负载 + 写端点回全量负载），交互面从设置区块换成 master-detail 配置台。
// 钉住的契约：
//   1. 左栏按 wire 负载的 group 分组渲染（计数来自负载，不手抄工具名）。
//   2. 🔴 owner 拍板：右栏类别**默认折叠**，点组头单独展开（aria-expanded + grid-rows +
//      inert 三重断言 —— happy-dom 不做布局计算，折叠几何由这三个属性钉住）。
//   3. 三档切换落库（setToolPref）并用**返回的负载**重渲染。
//   4. dangerAuto → auto 单行红确认；🔴 组级批量 auto 且组里有 dangerAuto 可配行同样先过
//      红确认（复核抓过的真 bug：批量绕过单行确认）。
//   5. configurable=false 行禁用 + fixedAsk 药丸 + 行下说明（不能只是灰掉）。
//   6. flag off（connectorToolsEnabled ≠ true）→ 外部连接段不渲染、零 /api/connector 请求
//      （内置工具照常可用）。
//   7. `?item=` 深链落到对应功能域。
//   8. send 收件人白名单跟着 outbound 组走。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import type { ToolApprovalPrefsPayload } from '../../../src/shared/api/types'

// happy-dom（本仓版本）不带 window.localStorage —— 组件侧已 try/catch，测试补内存实现。
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

const { tMock } = vi.hoisted(() => ({
  tMock: vi.fn((key: string, opts?: Record<string, unknown>) =>
    opts && 'tool' in opts ? `${key}:${String(opts.tool)}` : key
  )
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tMock })
}))

vi.mock('@shared/state/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }))

// 路由：页面只消费 useSearch（深链）。navigate 不在页面里用。
const routerState = vi.hoisted(() => ({ search: {} as { item?: string } }))
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => routerState.search,
  useNavigate: () => vi.fn()
}))

// flag fetcher —— 部分 mock，保留其余真实实现（SkillsSection.test 同款手法）。
const { flagFetch } = vi.hoisted(() => ({ flagFetch: vi.fn<() => Promise<boolean>>() }))
vi.mock('@shared/components/settings/custom-ai/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/components/settings/custom-ai/shared')>()),
  fetchConnectorToolsEnabled: flagFetch
}))

// 🔴 useMailApi 必须回**稳定引用**（hoisted 单例）：页面的 loadPrefs 依赖 [api]，每次
// render 造新对象会让加载 effect 反复重跑、用 stale mock 覆盖掉刚 mutate 的状态（旧
// ToolApprovalSection.test 的 stableMailApi 就是为此）。
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
    catalog: vi.fn(),
    tools: vi.fn(),
    status: vi.fn()
  }
  return { stableMailApi: { chat: chatApi, connector: connectorApi }, chatApi, connectorApi }
})
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => stableMailApi
}))

import { ConnectorsConsolePage } from '../../../src/shared/components/connectors/ConnectorsConsolePage'

function payload(overrides?: Partial<ToolApprovalPrefsPayload>): ToolApprovalPrefsPayload {
  return {
    tools: [
      {
        toolName: 'email_draft_reply',
        group: 'draft',
        defaultTier: 'auto',
        tier: null,
        effectiveTier: 'auto',
        configurable: true,
        dangerAuto: false
      },
      {
        toolName: 'calendar_event_delete',
        group: 'calendar',
        defaultTier: 'ask',
        tier: null,
        effectiveTier: 'ask',
        configurable: true,
        dangerAuto: true
      },
      {
        toolName: 'email_prepare_send',
        group: 'outbound',
        defaultTier: 'ask',
        tier: null,
        effectiveTier: 'ask',
        configurable: false,
        dangerAuto: false
      }
    ],
    sendWhitelist: [],
    acceptEditsPreset: ['email_draft_reply'],
    ...overrides
  }
}

function renderUi() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    createElement(QueryClientProvider, { client: qc }, createElement(ConnectorsConsolePage))
  )
}

/** 左栏内置工具行（accessible name = 组 label key）。 */
function masterRow(group: string): HTMLElement {
  const nav = screen.getByRole('navigation', { name: 'connectorsConsole.sectionBuiltin' })
  const btn = within(nav)
    .getAllByRole('button')
    .find((b) => b.textContent?.includes(`settings.ai.toolPrefs.group.${group}`))
  expect(btn).toBeTruthy()
  return btn as HTMLElement
}

/** 右栏类别组头（折叠开关按钮，按 aria-controls 定位）。 */
function groupToggle(container: HTMLElement, group: string): HTMLElement {
  const toggle = container.querySelector(`[aria-controls="console-builtin-${group}"]`)
  expect(toggle).not.toBeNull()
  return toggle as HTMLElement
}

function collapsibleRegion(container: HTMLElement, group: string): HTMLElement {
  const region = container.querySelector(`#console-builtin-${group}`)
  expect(region).not.toBeNull()
  return region as HTMLElement
}

beforeEach(() => {
  routerState.search = {}
  chatApi.getToolPrefs.mockResolvedValue(payload())
  flagFetch.mockResolvedValue(false)
  connectorApi.list.mockResolvedValue([])
  connectorApi.catalog.mockResolvedValue({
    composio: { configured: false, updated_at: null },
    entries: []
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.localStorage.clear()
})

describe('ConnectorsConsole — 内置工具左栏', () => {
  test('按 wire 负载分组渲染，默认选中第一组', async () => {
    renderUi()
    // 组 label key 会同时出现在左栏行 / 右栏标题 / 类别药丸 —— 一律 getAll。
    await waitFor(() =>
      expect(screen.getAllByText('settings.ai.toolPrefs.group.draft').length).toBeGreaterThan(0)
    )
    expect(screen.getAllByText('settings.ai.toolPrefs.group.calendar').length).toBeGreaterThan(0)
    expect(screen.getAllByText('settings.ai.toolPrefs.group.outbound').length).toBeGreaterThan(0)
    // 默认选中第一组（draft）→ 右栏出它的 detail 标题（h2）。
    expect(screen.getByRole('heading', { name: 'settings.ai.toolPrefs.group.draft' })).toBeTruthy()
    expect(masterRow('draft').getAttribute('aria-current')).toBe('true')
  })

  test('flag off → 外部连接段不渲染，且零 /api/connector 请求（内置照常）', async () => {
    renderUi()
    await waitFor(() => expect(flagFetch).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getAllByText('settings.ai.toolPrefs.group.draft').length).toBeGreaterThan(0)
    )
    expect(screen.queryByText('connectorsConsole.sectionExternal')).toBeNull()
    expect(connectorApi.list).not.toHaveBeenCalled()
    expect(connectorApi.catalog).not.toHaveBeenCalled()
  })

  test('`?item=builtin:outbound` 深链落到 outbound 功能域', async () => {
    routerState.search = { item: 'builtin:outbound' }
    renderUi()
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'settings.ai.toolPrefs.group.outbound' })
      ).toBeTruthy()
    )
    expect(masterRow('outbound').getAttribute('aria-current')).toBe('true')
  })
})

// 🔴 0812 owner 撤回 08-06 的「默认折叠」：内置工具详情**默认展开**（原话「内置工具的详情页
// 都默认展开」）。折叠能力保留，几何断言仍是三重的，只是初始方向反过来。
describe('ConnectorsConsole — 类别默认展开（0812 owner 拍板，撤回 08-06 的默认折叠）', () => {
  test('右栏类别默认展开（aria-expanded=true + 1fr + 非 inert），点组头可收起', async () => {
    const { container } = renderUi()
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'settings.ai.toolPrefs.group.draft' })
      ).toBeTruthy()
    )
    const toggle = groupToggle(container, 'draft')
    const region = collapsibleRegion(container, 'draft')
    // 展开几何三重断言：开关态 + grid 行高 1fr + 非 inert（键盘/AT 可达）。
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(region.className).toContain('grid-rows-[1fr]')
    expect(region.hasAttribute('inert')).toBe(false)
    // 默认就能看见行，不用先点一下。
    expect(within(region).getByText('email_draft_reply')).toBeTruthy()

    // 折叠能力没被删掉。
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(region.className).toContain('grid-rows-[0fr]')
    expect(region.hasAttribute('inert')).toBe(true)
  })

  test('切换功能域后折叠态归零（回到展开，不是记住上一组的收起）', async () => {
    const { container } = renderUi()
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'settings.ai.toolPrefs.group.draft' })
      ).toBeTruthy()
    )
    fireEvent.click(groupToggle(container, 'draft'))
    expect(groupToggle(container, 'draft').getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(masterRow('calendar'))
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'settings.ai.toolPrefs.group.calendar' })
      ).toBeTruthy()
    )
    // key={group} 重挂载 ⇒ 新组回到默认展开，而不是继承上一组被收起的状态。
    expect(groupToggle(container, 'calendar').getAttribute('aria-expanded')).toBe('true')
  })
})

describe('ConnectorsConsole — 三档切换与危险确认', () => {
  async function openGroup(container: HTMLElement, group: string): Promise<void> {
    fireEvent.click(masterRow(group))
    await waitFor(() => expect(groupToggle(container, group)).toBeTruthy())
    fireEvent.click(groupToggle(container, group))
  }

  test('三档切换落 setToolPref，并用返回负载重渲染（clearOverride 出现）', async () => {
    const updated = payload()
    updated.tools[0] = { ...updated.tools[0], tier: 'ask', effectiveTier: 'ask' }
    chatApi.setToolPref.mockResolvedValue(updated)
    const { container } = renderUi()
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'settings.ai.toolPrefs.group.draft' })
      ).toBeTruthy()
    )
    fireEvent.click(groupToggle(container, 'draft'))
    const seg = screen.getByRole('group', {
      name: 'settings.ai.toolPrefs.tier.label · email_draft_reply'
    })
    fireEvent.click(within(seg).getByRole('button', { name: 'settings.ai.toolPrefs.tier.ask' }))
    await waitFor(() =>
      expect(chatApi.setToolPref).toHaveBeenCalledWith('email_draft_reply', 'ask')
    )
    await waitFor(() =>
      expect(screen.getByText('settings.ai.toolPrefs.clearOverride')).toBeTruthy()
    )
  })

  test('dangerAuto 行设 auto → 一次性红确认；确认前不落库，取消不落库', async () => {
    chatApi.setToolPref.mockResolvedValue(payload())
    const { container } = renderUi()
    await waitFor(() =>
      expect(screen.getByText('settings.ai.toolPrefs.group.calendar')).toBeTruthy()
    )
    await openGroup(container, 'calendar')
    const seg = screen.getByRole('group', {
      name: 'settings.ai.toolPrefs.tier.label · calendar_event_delete'
    })
    fireEvent.click(within(seg).getByRole('button', { name: 'settings.ai.toolPrefs.tier.auto' }))
    expect(chatApi.setToolPref).not.toHaveBeenCalled()
    expect(
      screen.getByText('settings.ai.toolPrefs.dangerConfirmTitle:calendar_event_delete')
    ).toBeTruthy()
    // 取消 → 不落库。
    fireEvent.click(screen.getByText('settings.ai.toolPrefs.cancel'))
    expect(chatApi.setToolPref).not.toHaveBeenCalled()
    // 再来一次并确认 → 落库。
    fireEvent.click(within(seg).getByRole('button', { name: 'settings.ai.toolPrefs.tier.auto' }))
    fireEvent.click(screen.getByText('settings.ai.toolPrefs.confirm'))
    await waitFor(() =>
      expect(chatApi.setToolPref).toHaveBeenCalledWith('calendar_event_delete', 'auto')
    )
  })

  test('🔴 组级批量 auto 且组里有 dangerAuto 可配行 → 同样先过红确认', async () => {
    chatApi.bulkSetToolPrefs.mockResolvedValue(payload())
    const { container } = renderUi()
    await waitFor(() =>
      expect(screen.getByText('settings.ai.toolPrefs.group.calendar')).toBeTruthy()
    )
    fireEvent.click(masterRow('calendar'))
    const bulkTrigger = await screen.findByLabelText(
      'settings.ai.toolPrefs.bulk.label · settings.ai.toolPrefs.group.calendar'
    )
    fireEvent.click(bulkTrigger)
    fireEvent.click(await screen.findByText('settings.ai.toolPrefs.bulk.auto'))
    // 没确认前不发批量请求。
    expect(chatApi.bulkSetToolPrefs).not.toHaveBeenCalled()
    expect(
      screen.getByText('settings.ai.toolPrefs.dangerConfirmTitle:calendar_event_delete')
    ).toBeTruthy()
    fireEvent.click(screen.getByText('settings.ai.toolPrefs.confirm'))
    await waitFor(() =>
      expect(chatApi.bulkSetToolPrefs).toHaveBeenCalledWith({ tier: 'auto', group: 'calendar' })
    )
    // 同组批量 ask 不需要确认（危险只挡 auto 方向）。
    chatApi.bulkSetToolPrefs.mockClear()
    fireEvent.click(bulkTrigger)
    fireEvent.click(await screen.findByText('settings.ai.toolPrefs.bulk.ask'))
    await waitFor(() =>
      expect(chatApi.bulkSetToolPrefs).toHaveBeenCalledWith({ tier: 'ask', group: 'calendar' })
    )
    // container 引用保持存活（openGroup 之外的用法），防 lint 未使用告警。
    expect(container).toBeTruthy()
  })

  test('不可配置行（send）禁用 + fixedAsk 药丸 + 行下说明如实呈现', async () => {
    const { container } = renderUi()
    await waitFor(() =>
      expect(screen.getByText('settings.ai.toolPrefs.group.outbound')).toBeTruthy()
    )
    await openGroup(container, 'outbound')
    const seg = screen.getByRole('group', {
      name: 'settings.ai.toolPrefs.tier.label · email_prepare_send'
    })
    for (const btn of Array.from(seg.querySelectorAll('button'))) {
      expect((btn as HTMLButtonElement).disabled).toBe(true)
    }
    // 药丸 + 展开的行下说明（title tip 与正文说明各一处）。
    expect(screen.getByText('settings.ai.toolPrefs.fixedAsk')).toBeTruthy()
    expect(screen.getAllByText('settings.ai.toolPrefs.fixedAskTip').length).toBeGreaterThan(0)
    fireEvent.click(within(seg).getByRole('button', { name: 'settings.ai.toolPrefs.tier.auto' }))
    expect(chatApi.setToolPref).not.toHaveBeenCalled()
  })

  test('send 收件人白名单跟着 outbound 组走并保存', async () => {
    chatApi.setSendWhitelist.mockResolvedValue(['a@corp.test', '@corp.test'])
    routerState.search = { item: 'builtin:outbound' }
    renderUi()
    const textarea = (await screen.findByPlaceholderText(
      'settings.ai.toolPrefs.sendWhitelist.placeholder'
    )) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'a@corp.test, @corp.test\n' } })
    fireEvent.click(screen.getByText('settings.ai.toolPrefs.sendWhitelist.save'))
    await waitFor(() =>
      expect(chatApi.setSendWhitelist).toHaveBeenCalledWith(['a@corp.test', '@corp.test'])
    )
    // 非 outbound 组不渲染白名单（它是 send 的免卡形状，不是全局区块）。
    cleanup()
    routerState.search = { item: 'builtin:draft' }
    renderUi()
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'settings.ai.toolPrefs.group.draft' })
      ).toBeTruthy()
    )
    expect(
      screen.queryByPlaceholderText('settings.ai.toolPrefs.sendWhitelist.placeholder')
    ).toBeNull()
  })

  test('编辑放行预设 + 全部重置命中各自端点', async () => {
    chatApi.applyToolPrefsPreset.mockResolvedValue({ ...payload(), updated: 15 })
    chatApi.resetToolPrefs.mockResolvedValue({ ...payload(), removed: 3 })
    renderUi()
    await waitFor(() => expect(screen.getByText('settings.ai.toolPrefs.preset')).toBeTruthy())
    fireEvent.click(screen.getByText('settings.ai.toolPrefs.preset'))
    await waitFor(() => expect(chatApi.applyToolPrefsPreset).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByText('settings.ai.toolPrefs.reset'))
    await waitFor(() => expect(chatApi.resetToolPrefs).toHaveBeenCalledTimes(1))
  })
})
