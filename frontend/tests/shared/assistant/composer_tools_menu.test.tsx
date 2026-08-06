// @vitest-environment happy-dom
//
// ComposerToolsMenu — composer 的滑块菜单（task 08-05 WP-13）。
//
// 覆盖的契约（每条都是「改错了用户会中招」的那种）：
//   1. **未展开不打请求**：技能列表的 query 由菜单 open 门控 —— 一条常驻在工具条上的 hook
//      为了一个「N/M」数字在每个 chat 面首帧打一发请求，正是 ConnectorQuickPanel 当初写在案
//      的那条纪律（那边是 per-connector 的 tools 请求）。
//   2. **技能开关写穿后端**：`setSkillEnabled` + invalidate `qk.skills()`（与设置页同一个缓存
//      键 → 两处即时同步），且 toast 说清「约 15s 内生效」（gateway /chat/config 的 TTL）。
//      不可用的技能（KOS 凭证缺失等）开关灰掉 —— 打开一个注册不了工具的东西是纯误导。
//   3. **响应式二级形态（方案 C）**：量出来的可用宽度够 → 一二级**并排**（flyout），不够 →
//      替换式（收编前的行为，零回归）。判据是宽度**不是 variant**（chip 同时出现在 320px
//      侧栏与 704px agent 面，按 variant 分叉必然错一边）。
//      🔴 并排形态下**点二级不能把一级关掉** —— 计划书 §5 风险 10 记的第一个坑。本实现没有
//      portal（二级是同一子树里的绝对定位兄弟），所以单 ref `contains` 仍是对的判据；这条
//      测试就是钉住「将来若改 portal，必须同时换判据」。
//   4. **深链**「AI 设置…」跳设置-AI。
//
// connector 那一侧（显隐三态 / 开关写穿 / 常驻强调点 / 二级退场时序）在
// ConnectorQuickPanel.test.tsx 里测，那份文件的入口已随本包从「+」改成滑块。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

import type { ConnectorSummary, SkillSummary } from '../../../src/shared/api/types'

// t 恒返 key（断言按 key 走），插值参数查 mock.calls（ConnectorQuickPanel.test 同款手法）。
const { tMock } = vi.hoisted(() => ({
  tMock: vi.fn((key: string, _opts?: Record<string, unknown>) => key)
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: tMock }) }))

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))
vi.mock('@shared/state/toast', () => ({ toastError, toastSuccess }))

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
  useRouter: () => ({ navigate: navigateMock })
}))

const { flagFetch } = vi.hoisted(() => ({ flagFetch: vi.fn<() => Promise<boolean>>() }))
vi.mock('@shared/components/settings/custom-ai/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/components/settings/custom-ai/shared')>()),
  fetchConnectorToolsEnabled: flagFetch
}))

const { connectorApi, chatApi } = vi.hoisted(() => ({
  chatApi: {
    listSkills: vi.fn<() => Promise<SkillSummary[]>>(),
    setSkillEnabled: vi.fn<(name: string, enabled: boolean) => Promise<void>>()
  },
  connectorApi: { list: vi.fn<() => Promise<ConnectorSummary[]>>() }
}))
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ connector: connectorApi, chat: chatApi })
}))

import { ComposerToolsMenu } from '../../../src/shared/assistant/components/ComposerToolsMenu'
import {
  TOOLS_FLYOUT_LEFT,
  TOOLS_FLYOUT_MIN_ROOM,
  TOOLS_MENU_W,
  TOOLS_PANEL_W,
  toolsFlyoutFits
} from '../../../src/shared/assistant/components/composerToolsMenu.lib'

// ─── fixtures ───────────────────────────────────────────────────────────────

function skill(partial: Partial<SkillSummary> & { name: string }): SkillSummary {
  return {
    name: partial.name,
    title: partial.title ?? partial.name,
    description: partial.description ?? '',
    defaultEnabled: partial.defaultEnabled ?? false,
    enabled: partial.enabled ?? false,
    overridden: partial.overridden ?? false,
    sourceType: partial.sourceType ?? 'builtin',
    available: partial.available ?? true,
    unavailableReason: partial.unavailableReason ?? null,
    toolCount: partial.toolCount ?? 2,
    scopes: partial.scopes ?? []
  }
}

const SKILLS: SkillSummary[] = [
  skill({ name: 'email', title: 'Email', enabled: true }),
  skill({
    name: 'kos',
    title: 'KOS',
    enabled: false,
    available: false,
    unavailableReason: 'no creds'
  })
]

const NOTION: ConnectorSummary = {
  connector_id: 'notion',
  display_name: 'Notion',
  status: 'connected',
  enabled: true,
  preprocess_enabled: false,
  scopes: null,
  last_error: null,
  last_synced_at: null,
  credential: null,
  flow: null,
  server_url: 'https://mcp.notion.test/mcp',
  transport: 'http'
}

const TOOLS_LABEL = 'chat.tools.label'
const SKILLS_ITEM = 'chat.tools.skills'
const CONNECTORS_ITEM = 'chat.connectors.label'

/** 走 flyout 的门槛 = 208(一级) + 6(间隙) + 268(二级) + 12(边距) = 494（composerToolsMenu.lib）。 */
function stubWidth(room: number): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    right: room,
    top: 0,
    bottom: 0,
    width: room,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({})
  } as DOMRect)
}

/** 🔴 必须包一层 `<form>`：组件量的是 composer 容器（两个 composer 的 ComposerPrimitive.Root
 *  都是 form）到弹层左锚点之间还剩多少宽度。 */
function renderMenu(variant: 'icon' | 'chip' = 'icon') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement('form', null, createElement(ComposerToolsMenu, { variant }))
    )
  )
}

async function openMenu(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: TOOLS_LABEL }))
  await screen.findByRole('menu', { name: TOOLS_LABEL })
}

beforeEach(() => {
  flagFetch.mockResolvedValue(true)
  connectorApi.list.mockResolvedValue([NOTION])
  chatApi.listSkills.mockResolvedValue(SKILLS)
  chatApi.setSkillEnabled.mockResolvedValue(undefined)
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('toolsFlyoutFits — 门槛算式', () => {
  test('量不到（0）→ 替换式；刚好够 → flyout', () => {
    expect(TOOLS_FLYOUT_MIN_ROOM).toBe(494)
    expect(toolsFlyoutFits(0)).toBe(false)
    expect(toolsFlyoutFits(TOOLS_FLYOUT_MIN_ROOM - 1)).toBe(false)
    expect(toolsFlyoutFits(TOOLS_FLYOUT_MIN_ROOM)).toBe(true)
    // 真实场地：320/400/448 三档窄面走替换式，704（agent 面 thread max-width）走 flyout。
    expect([320, 400, 448].map(toolsFlyoutFits)).toEqual([false, false, false])
    expect(toolsFlyoutFits(704)).toBe(true)
  })
})

describe('ComposerToolsMenu — 未展开不打请求', () => {
  test('菜单没开 → 一次 listSkills 都不发；开了才发，并渲染 N/M 摘要', async () => {
    renderMenu()
    // 「+」旁边这颗钮是常驻的：它一挂载就打请求 = 每个 chat 面首帧多一发。
    await waitFor(() => expect(flagFetch).toHaveBeenCalled())
    expect(chatApi.listSkills).not.toHaveBeenCalled()

    await openMenu()
    await waitFor(() => expect(chatApi.listSkills).toHaveBeenCalledTimes(1))
    // 摘要 = 已启用且可用 / 总数（SKILLS 里 email 开着可用、kos 关着且不可用）。
    await waitFor(() =>
      expect(tMock).toHaveBeenCalledWith('chat.tools.summary', { enabled: 1, total: 2 })
    )
  })
})

describe('ComposerToolsMenu — 技能二级', () => {
  test('点「技能」→ 行 + 开关；toggle 写穿 setSkillEnabled 并说清 15s TTL', async () => {
    renderMenu()
    await openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: SKILLS_ITEM }))
    const sw = await screen.findByRole('switch', { name: 'settings.skills.enabled · Email' })
    fireEvent.click(sw)
    await waitFor(() => expect(chatApi.setSkillEnabled).toHaveBeenCalledWith('email', false))
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        'chat.tools.skillSaved',
        'chat.tools.skillSavedDetail'
      )
    )
    // invalidate 生效 = 列表被重新拉了一次（与设置页同一个 queryKey）。
    await waitFor(() => expect(chatApi.listSkills).toHaveBeenCalledTimes(2))
  })

  test('不可用的技能 → 开关禁用（开了也注册不了工具）', async () => {
    renderMenu()
    await openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: SKILLS_ITEM }))
    const sw = (await screen.findByRole('switch', {
      name: 'settings.skills.enabled · KOS'
    })) as HTMLButtonElement
    expect(sw.disabled).toBe(true)
  })

  test('保存失败 → toastError，不谎报成功', async () => {
    chatApi.setSkillEnabled.mockRejectedValue(new Error('boom'))
    renderMenu()
    await openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: SKILLS_ITEM }))
    fireEvent.click(await screen.findByRole('switch', { name: 'settings.skills.enabled · Email' }))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastSuccess).not.toHaveBeenCalled()
  })
})

describe('ComposerToolsMenu — 响应式二级形态（方案 C）', () => {
  test('窄面（可用宽 < 494）→ 替换式：一级被换掉，顶上有返回钮', async () => {
    stubWidth(320)
    renderMenu()
    await openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: SKILLS_ITEM }))
    // 同一个壳换内容：一级的菜单项没了，壳变成 dialog。
    await waitFor(() => expect(screen.queryByRole('menu', { name: TOOLS_LABEL })).toBeNull())
    expect(screen.getByRole('dialog', { name: SKILLS_ITEM })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'chat.composer.back' })).toBeTruthy()
    // 返回回一级（仍在同一颗触发器上，不是关掉重开）。
    fireEvent.click(screen.getByRole('button', { name: 'chat.composer.back' }))
    expect(screen.getByRole('menu', { name: TOOLS_LABEL })).toBeTruthy()
  })

  test('宽面（可用宽 ≥ 494）→ flyout：一二级并排，且没有返回钮', async () => {
    stubWidth(800)
    renderMenu()
    await openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: SKILLS_ITEM }))
    const flyout = await screen.findByRole('dialog', { name: SKILLS_ITEM })
    // 一级仍在屏幕上（这就是「并排」的可观测签名）。
    const root = screen.getByRole('menu', { name: TOOLS_LABEL })
    expect(screen.queryByRole('button', { name: 'chat.composer.back' })).toBeNull()
    // 🔴 几何一致性闸：类字面量必须与 composerToolsMenu.lib 的算式对得上。
    // （**必须是类不是内联 style** —— useExitAnimation 的 reduced-motion 分支
    //  `clearProps:'all'` 会把内联 style 清空，二级会当场叠到一级上面。实测踩过。）
    expect(root.className).toContain(`w-[${TOOLS_MENU_W}px]`)
    expect(flyout.className).toContain(`left-[${TOOLS_FLYOUT_LEFT}px]`)
    expect(flyout.className).toContain(`w-[${TOOLS_PANEL_W}px]`)
    expect((flyout as HTMLElement).style.left).toBe('')
  })

  test('🔴 flyout 形态下点二级内部不会把菜单关掉（风险 10 的第一个坑）', async () => {
    stubWidth(800)
    renderMenu()
    await openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: SKILLS_ITEM }))
    const flyout = await screen.findByRole('dialog', { name: SKILLS_ITEM })
    // 单 ref `contains` 判据若失效（例如改成 portal 后没换判据），这一下 mousedown 会被判成
    // 「点外」→ 整个弹层当场关掉。
    fireEvent.mouseDown(flyout)
    expect(screen.getByRole('menu', { name: TOOLS_LABEL })).toBeTruthy()
    expect(screen.getByRole('dialog', { name: SKILLS_ITEM })).toBeTruthy()
    // 真的点外面才关。
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(screen.queryByRole('menu', { name: TOOLS_LABEL })).toBeNull())
  })

  test('flyout 下切另一项：二级换成外部连接，一级仍在', async () => {
    stubWidth(800)
    renderMenu()
    await openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: SKILLS_ITEM }))
    await screen.findByRole('dialog', { name: SKILLS_ITEM })
    fireEvent.click(screen.getByRole('menuitem', { name: CONNECTORS_ITEM }))
    await screen.findByRole('dialog', { name: CONNECTORS_ITEM })
    expect(screen.queryByRole('dialog', { name: SKILLS_ITEM })).toBeNull()
    expect(screen.getByRole('menu', { name: TOOLS_LABEL })).toBeTruthy()
  })
})

describe('ComposerToolsMenu — 深链', () => {
  test('「AI 设置…」跳设置-AI 并收起菜单', async () => {
    renderMenu()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'chat.tools.settingsLink' }))
    expect(navigateMock).toHaveBeenCalledWith({ to: '/settings', search: { tab: 'ai' } })
    await waitFor(() => expect(screen.queryByRole('menu', { name: TOOLS_LABEL })).toBeNull())
  })
})
