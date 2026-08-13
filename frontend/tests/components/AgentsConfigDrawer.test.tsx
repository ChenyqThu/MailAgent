// @vitest-environment happy-dom
//
// Bug2 回归 — 报告 Agent 配置 drawer 的调度控件：
//   • weekly  → 出现 weekday 单选（周一~周日），不出现「每月几日」
//   • monthly → 出现「每月几日」下拉（1~28 日）+ 1–28 限制 hint，不出现 weekday
//   • daily   → 两者都不出现（只时点）
// 断言用 getByRole('option') 精确匹配 <select> 选项，避免误中 aggWeekly 说明文字里
// 的「周一~周日」。注意：jsdom/happy-dom 不渲染真实 CSS 布局 —— 视觉（flexWrap /
// select 宽度）需打包后人工确认，这里只锁渲染逻辑。
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

// Radix Select (the model dropdown) needs these DOM primitives that happy-dom
// doesn't implement to open its listbox. Mirror the well-known shadcn/Radix
// test shim so we can drive the dropdown open and assert its <option> rows.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = vi.fn(
      () => false
    ) as unknown as typeof Element.prototype.hasPointerCapture
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture =
      vi.fn() as unknown as typeof Element.prototype.setPointerCapture
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture =
      vi.fn() as unknown as typeof Element.prototype.releasePointerCapture
  }
})

/** The model dropdown is a Radix Select (`<button role="combobox">`). 07-24 起抽屉里还有
 *  第二个 Radix Select（ScheduleBuilder 的时区），故必须按 aria-label 精确定位，
 *  不能再靠 "唯一的 BUTTON combobox" 这个假设。 */
function getModelTrigger(): HTMLElement {
  return screen.getByRole('combobox', { name: '模型' })
}

/** Open the model Radix Select (closed state only renders the selected value;
 *  the other options live in a detached fragment until the listbox opens). */
function openModelSelect(): HTMLElement {
  const trigger = getModelTrigger()
  act(() => {
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
    fireEvent.pointerUp(trigger)
  })
  return document.querySelector('[role="listbox"]') as HTMLElement
}

// 共享 save spy（vi.mock factory 被 hoist，须经 vi.hoisted 提前初始化）——
// context_docs 用例要断言保存 patch 的形状。
const { mockSave } = vi.hoisted(() => ({ mockSave: vi.fn() }))
mockSave.mockResolvedValue({})

vi.mock('../../src/shared/components/agents/hooks', () => ({
  useSetConfig: () => ({ save: mockSave, isSaving: false }),
  useKosAvailable: () => false,
  useReportConfig: () => ({ agents: [], isLoading: false }),
  useReportList: () => ({ reports: [], isLoading: false }),
  useRunNow: () => ({ run: vi.fn(), isRunning: false })
}))

// useExitAnimation 强制 shouldRender=true：覆盖「退场动画播放中、父组件已把 cfg 置 null」
// 这一真实渲染路径（regression: 此时若 header 读 cfg.title 会空指针崩）。open=true 的
// 既有用例同样 shouldRender=true，不受影响。
vi.mock('@shared/hooks/useExitAnimation', () => ({
  useExitAnimation: () => ({ shouldRender: true, scopeRef: { current: null } })
}))

// ConfigDrawer 调用 useEnabledModels()（useQuery）→ 需要 QueryClientProvider。
// 这里 mock 整个模块：测试 schedule 控件逻辑不依赖真实模型列表，且避免 jsdom
// 环境缺 serve-api 时 fetch 失败干扰。
const mockEnabledModels = vi.fn(() => ({
  models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5', 'gpt-5.5'],
  rawEnabled: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5', 'gpt-5.5']
}))

vi.mock('@shared/hooks/useLlmModels', () => ({
  fetchChatConfigModelsProbe: async () => ({ enabledModels: [], providerRegistryEnabled: false }),
  FALLBACK_MODELS: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5', 'gpt-5.5'],
  useEnabledModels: () => mockEnabledModels(),
  useUpstreamModels: () => ({ models: [], isLoading: false, error: undefined, refresh: vi.fn() })
}))

import i18n from '@shared/i18n'
import { ConfigDrawer } from '../../src/shared/components/agents/AgentsTab'
import type { ReportAgentConfig } from '@shared/api/types'

await i18n.changeLanguage('zh-CN')

function makeQcWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}

function renderDrawer(ui: React.ReactElement) {
  return render(ui, { wrapper: makeQcWrapper() })
}

function makeCfg(over: Partial<ReportAgentConfig>): ReportAgentConfig {
  return {
    id: 'daily',
    type: 'daily',
    enabled: true,
    title: '日报',
    schedule: { cadence: 'daily', hours: [9] },
    window_hours: 24,
    prompt: 'x',
    prompt_is_default: true,
    model: 'claude-opus-4-8',
    kos_enrich: false,
    trigger_mode: 'rolling_24h',
    timezone: '',
    body_full_priorities: [],
    updated_at: null,
    ...over
  } as ReportAgentConfig
}

afterEach(cleanup)

// 07-24 排程统一：CadencePill + 原生 weekday/dayOfMonth/hour select 换成共享
// ScheduleBuilder。Bug2 的原意（「weekly 才出周几、monthly 才出每月几日、daily 都不出」）
// 由构建器的条件渲染继承，断言改成驱动构建器控件；另加继承老配置数值的回归。
describe('ConfigDrawer schedule controls (Bug2 · ScheduleBuilder)', () => {
  afterEach(() => {
    mockSave.mockClear()
  })

  test('weekly：出现周几圆钮组（按老 weekday 预填），无「每月几号」下拉', () => {
    renderDrawer(
      <ConfigDrawer
        cfg={makeCfg({
          id: 'weekly',
          type: 'weekly',
          // 🔴 老值是 Python weekday 口径：2 = 周三
          schedule: { cadence: 'weekly', hours: [9], weekday: 2 }
        })}
        open
        onClose={() => {}}
      />
    )
    expect(screen.getByRole('button', { name: '周一' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '周三' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '周日' })).toBeTruthy()
    // 只有周三被选中 —— 锁死 Python 2(周三) → 契约 3(周三) 的编号转换
    expect(screen.getByRole('button', { name: '周三' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '周一' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByLabelText('每月几号')).toBeNull()
  })

  test('monthly：出现每月几号下拉（1~31 日，含月末策略）+ 无周几圆钮', () => {
    renderDrawer(
      <ConfigDrawer
        cfg={makeCfg({
          id: 'monthly',
          type: 'monthly',
          schedule: { cadence: 'monthly', hours: [9], day_of_month: 15 }
        })}
        open
        onClose={() => {}}
      />
    )
    const daySelect = screen.getByLabelText('每月几号') as HTMLSelectElement
    expect(daySelect.value).toBe('15')
    // 新求值器有 clamp/skip 月末策略 → 不再限 1–28（老 UI 因 worker 无月末回退才砍到 28）
    expect(within(daySelect).getByRole('option', { name: '31 号' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '周一' })).toBeNull()
  })

  test('daily：周几圆钮 / 每月几号 均不出现', () => {
    renderDrawer(<ConfigDrawer cfg={makeCfg({})} open onClose={() => {}} />)
    expect(screen.queryByRole('button', { name: '周一' })).toBeNull()
    expect(screen.queryByLabelText('每月几号')).toBeNull()
  })

  test('🔴 频率段锁死：报告种类（cadence）不能被排程编辑改掉', () => {
    renderDrawer(<ConfigDrawer cfg={makeCfg({})} open onClose={() => {}} />)
    // lockFreq → 「按天 / 按周 / 按月」分段控件不渲染（cadence 仍由 CadencePill 只读展示）
    expect(screen.queryByRole('button', { name: '按周' })).toBeNull()
    expect(screen.queryByRole('button', { name: '按月' })).toBeNull()
  })

  test('继承老配置数值：daily 9 点保存后 rule 是 9:00 + cadence 不变 + 时区写实非空', () => {
    renderDrawer(<ConfigDrawer cfg={makeCfg({})} open onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    const patch = mockSave.mock.calls.at(-1)?.[1]
    expect(patch.schedule.cadence).toBe('daily')
    expect(patch.schedule.kind).toBe('schedule')
    expect(patch.schedule.rule).toMatchObject({
      freq: 'daily',
      interval: 1,
      hour: 9,
      minute: 0
    })
    // 🔴 契约 §4：空时区必须写实成实际 IANA，留空会让统一逻辑退化成 UTC → 9:00 报告漂
    expect(patch.schedule.timezone).toBeTruthy()
    // legacy 镜像仍在（降级安全）
    expect(patch.schedule.hours).toEqual([9])
  })

  test('继承老配置数值：weekly 周一（Python 0）→ rule.weekdays=[1]（契约周一）', () => {
    renderDrawer(
      <ConfigDrawer
        cfg={makeCfg({
          id: 'weekly',
          type: 'weekly',
          schedule: { cadence: 'weekly', hours: [9], weekday: 0 }
        })}
        open
        onClose={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    const patch = mockSave.mock.calls.at(-1)?.[1]
    expect(patch.schedule.cadence).toBe('weekly')
    expect(patch.schedule.rule.weekdays).toEqual([1])
    expect(patch.schedule.rule.hour).toBe(9)
    // legacy 镜像写回 Python 口径
    expect(patch.schedule.weekday).toBe(0)
  })

  test('预览列出接下来 5 次运行（所见即将跑）', () => {
    renderDrawer(<ConfigDrawer cfg={makeCfg({})} open onClose={() => {}} />)
    const preview = screen.getByTestId('schedule-preview')
    expect(preview.querySelectorAll('li')).toHaveLength(5)
  })

  test('cfg=null 时 render body 不读 cfg（regression：header title / 头像身份都走 state）', () => {
    // 🔴 这条曾写成 `open={false}`，但 Drawer 现在是 AnimatePresence —— open=false 直接
    // 渲染空 DOM，body 一行都不跑，断言恒绿（焊死的闸）。真正要钉的不变量是「render 期
    // 一次都不 deref cfg」：退场动画播放中父组件已把 cfg 置 null，而 ConfigDrawer 常驻挂载、
    // 仍会被重渲染。故这里直接用 open + cfg=null 强制整个 body 求值。
    // 修复前 header 读 cfg.title → 空指针崩；现在 title / agentId / avatar 全在 state 里。
    expect(() => renderDrawer(<ConfigDrawer cfg={null} open onClose={() => {}} />)).not.toThrow()
    // 头像头部照常在场（按空 id 派生的中性默认脸），不是「整块没渲染所以没崩」。
    expect(screen.getByRole('button', { name: '更换' })).toBeTruthy()
  })
})

describe('ConfigDrawer identity docs (增量 2 — report 行级 context_docs)', () => {
  afterEach(() => {
    mockSave.mockClear()
  })

  test('渲染 4 个文档 chips，按 cfg.context_docs 预填选中态', () => {
    renderDrawer(
      <ConfigDrawer cfg={makeCfg({ context_docs: ['soul', 'user'] })} open onClose={() => {}} />
    )
    const pressed = (name: string) =>
      screen.getByRole('button', { name }).getAttribute('aria-pressed')
    expect(pressed('灵魂 / soul')).toBe('true')
    expect(pressed('用户偏好 / user')).toBe('true')
    expect(pressed('行为 / agent')).toBe('false')
    expect(pressed('规则 / rules')).toBe('false')
  })

  test('未动 chips 直接保存，patch 为显式默认 ["soul","user"] 而非 []（codex MED 坑）', () => {
    renderDrawer(
      <ConfigDrawer cfg={makeCfg({ context_docs: ['soul', 'user'] })} open onClose={() => {}} />
    )
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(mockSave).toHaveBeenCalledWith(
      'daily',
      expect.objectContaining({ context_docs: ['soul', 'user'] })
    )
  })

  test('toggle 后保存，patch 携带 context_docs（取消 soul → ["user"]）', () => {
    renderDrawer(
      <ConfigDrawer cfg={makeCfg({ context_docs: ['soul', 'user'] })} open onClose={() => {}} />
    )
    fireEvent.click(screen.getByRole('button', { name: '灵魂 / soul' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(mockSave).toHaveBeenCalledWith(
      'daily',
      expect.objectContaining({ context_docs: ['user'] })
    )
  })
})

// 0804 dogfood 3d —— 预设 agent（报告）也能改头像：后端 avatar_json 读写本就全类型通用，
// 缺的只是前端入口。头像编辑器默认折叠（3b），未触碰不进 patch（PATCH 缺席 = 不动列）。
describe('ConfigDrawer avatar identity (0804 dogfood 3d)', () => {
  afterEach(() => {
    mockSave.mockClear()
  })

  test('默认折叠：只见「更换」，形状/配色网格不渲染', () => {
    renderDrawer(<ConfigDrawer cfg={makeCfg({})} open onClose={() => {}} />)
    expect(screen.getByRole('button', { name: '更换' })).toBeTruthy()
    expect(screen.queryByTestId('avatar-shape-grid')).toBeNull()
    expect(screen.queryByTestId('avatar-color-grid')).toBeNull()
  })

  test('未触碰头像 → 保存 patch 不带 avatar 键（NULL 行保持 NULL）', () => {
    renderDrawer(<ConfigDrawer cfg={makeCfg({})} open onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(mockSave).toHaveBeenCalledTimes(1)
    expect(mockSave.mock.calls[0][1]).not.toHaveProperty('avatar')
  })

  test('展开 → 选形状 → 保存 patch 携带 avatar', () => {
    renderDrawer(<ConfigDrawer cfg={makeCfg({})} open onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '更换' }))
    // 形状网格按 bot shape id 挂 aria-label；wedge 是八形状之一。
    fireEvent.click(within(screen.getByTestId('avatar-shape-grid')).getByLabelText('wedge'))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(mockSave).toHaveBeenCalledTimes(1)
    expect(mockSave.mock.calls[0][1].avatar).toMatchObject({ type: 'bot', shape: 'wedge' })
  })
})

describe('ConfigDrawer model list (Phase 4 — dynamic models)', () => {
  // 模型选择改为 Radix Select 下拉单选（原 radio 列表）。收起态只渲染选中值，
  // 其余 option 在 detached fragment 里 —— 断言前必须 openModelSelect() 展开
  // 抽屉，再用 getByRole('option') 精确匹配下拉项。

  // Reset the mock to the default after each test so the persistent
  // mockReturnValue from one test doesn't bleed into the next.
  afterEach(() => {
    mockEnabledModels.mockReset()
    mockEnabledModels.mockReturnValue({
      models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5', 'gpt-5.5'],
      rawEnabled: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5', 'gpt-5.5']
    })
  })

  test('下拉展开后渲染启用列表中的所有模型选项', () => {
    mockEnabledModels.mockReturnValue({
      models: ['m1', 'm2'],
      rawEnabled: ['m1', 'm2']
    })
    renderDrawer(<ConfigDrawer cfg={makeCfg({ model: 'm1' })} open onClose={() => {}} />)
    const listbox = openModelSelect()
    expect(within(listbox).getByRole('option', { name: 'm1' })).toBeTruthy()
    expect(within(listbox).getByRole('option', { name: 'm2' })).toBeTruthy()
  })

  test('启用列表为空时 fallback 到四默认模型', () => {
    mockEnabledModels.mockReturnValue({
      models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5', 'gpt-5.5'],
      rawEnabled: []
    })
    renderDrawer(
      <ConfigDrawer cfg={makeCfg({ model: 'claude-sonnet-4-6' })} open onClose={() => {}} />
    )
    const listbox = openModelSelect()
    expect(within(listbox).getByRole('option', { name: 'claude-sonnet-4-6' })).toBeTruthy()
    expect(within(listbox).getByRole('option', { name: 'claude-opus-4-8' })).toBeTruthy()
    expect(within(listbox).getByRole('option', { name: 'claude-fable-5' })).toBeTruthy()
    expect(within(listbox).getByRole('option', { name: 'gpt-5.5' })).toBeTruthy()
  })

  test('当前模型不在启用列表时追加并显示「（未启用）」', () => {
    mockEnabledModels.mockReturnValue({
      models: ['claude-sonnet-4-6', 'claude-opus-4-8'],
      rawEnabled: ['claude-sonnet-4-6', 'claude-opus-4-8']
    })
    renderDrawer(
      <ConfigDrawer cfg={makeCfg({ model: 'orphan-model-x' })} open onClose={() => {}} />
    )
    // The orphan value shows in the COLLAPSED trigger (selected value), and the
    // dropdown lists it with the「（未启用）」annotation appended.
    expect(getModelTrigger().textContent).toContain('orphan-model-x')
    const listbox = openModelSelect()
    const orphanOpt = within(listbox).getByRole('option', { name: /orphan-model-x/ })
    expect(orphanOpt).toBeTruthy()
    expect(orphanOpt.textContent).toMatch(/未启用/)
  })
})
