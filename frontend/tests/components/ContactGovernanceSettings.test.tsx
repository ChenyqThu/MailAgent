// @vitest-environment happy-dom
//
// P4a agent-config lane — 「通讯录治理」配置页。承接 ContactGovernanceConfigDrawer.test
// 随旧抽屉退役的全部保存语义，三条 🔴 纪律一条不漏：
//   ① 保存是两次串行调用（agent 行 + profile doc），任一失败如实报错、后一次不发；
//   ② 追加段 / 组织架构框架读失败时不回写 —— 框里是空草稿或半截草稿，写下去会盖掉
//      owner 已有的内容；
//   ③ `trigger_json` 整列覆写 `{fire_hour, use_kos}`：两个字段一起发，仍是字面字段
//      而不是 schedule envelope。
// 另钉：工具清单从零依赖叶子推导（不硬编码件数）· 提示词默认全文只读 + 追加段回显
// `content` 原样（不 || defaultContent）· 参考 KOS 缺字段默认开 · 页里不出「总闸」说明段。
//
// ⚠️ 旧文件「时刻越界 → 就地报错」那条**不迁**：每日时刻的输入控件从 number input 换成了
// DailyHourSchedule 的 0–23 `<select>`，UI 已产不出越界值（组件里那道 errFireHour 守卫
// 因此成了不可达分支，见报告）。造一个绕过控件的用例只会测到产品里到不了的路径。

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { CONTACT_TOOL_FACE_GROUPS } from '@shared/lib/contactToolFace'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = vi.fn(
      () => false
    ) as unknown as typeof Element.prototype.hasPointerCapture
  }
})

const { mockSave } = vi.hoisted(() => ({ mockSave: vi.fn() }))
vi.mock('../../src/shared/components/agents/hooks', () => ({
  useSetConfig: () => ({ save: mockSave, isSaving: false }),
  useReportConfig: () => ({ agents: [], isLoading: false }),
  useKosAvailable: () => false,
  useRunNow: () => ({ run: vi.fn(), isRunning: false })
}))

vi.mock('@shared/hooks/useLlmModels', () => ({
  fetchChatConfigModelsProbe: async () => ({ enabledModels: [], providerRegistryEnabled: false }),
  FALLBACK_MODELS: ['claude-sonnet-4-6'],
  resolveApiBaseUrl: () => 'http://127.0.0.1:0/api',
  useEnabledModels: () => ({ models: ['claude-sonnet-4-6'], rawEnabled: ['claude-sonnet-4-6'] }),
  useUpstreamModels: () => ({ models: [], isLoading: false, error: undefined, refresh: vi.fn() })
}))

// 头像编辑器拉 bot-avatar 那一整套（canvas / 动画），本闸不关心它 —— 换成瘦身桩。
vi.mock('@shared/components/agents/AgentAvatar', () => ({
  AgentIdentityHeader: () => <div data-testid="agent-identity-header" />,
  AgentAvatar: () => <div />
}))

const { promptDoc, savePrompt, orgFrameDoc, saveOrgFrame } = vi.hoisted(() => ({
  promptDoc: {
    value: {
      data: { content: '', defaultContent: '你是 MailAgent 的通讯录管理员。' } as
        | { content: string; defaultContent: string }
        | undefined,
      isPending: false,
      isError: false
    }
  },
  savePrompt: vi.fn(),
  // 组织架构框架：同机制的另一份 profile doc，只有 content（没有默认全文）。
  orgFrameDoc: {
    value: { data: '' as string | undefined, isPending: false, isError: false }
  },
  saveOrgFrame: vi.fn()
}))
vi.mock('@shared/components/contacts/hooks', () => ({
  useContactAgentPrompt: () => promptDoc.value,
  useSaveContactAgentPrompt: () => ({ mutateAsync: savePrompt, isPending: false }),
  useContactOrgFrame: () => orgFrameDoc.value,
  useSaveContactOrgFrame: () => ({ mutateAsync: saveOrgFrame, isPending: false })
}))

import i18n from '@shared/i18n'
import { ContactGovernanceSettings } from '../../src/shared/components/agents/settings/ContactGovernanceSettings'
import type { ReportAgentConfig } from '@shared/api/types'

await i18n.changeLanguage('zh-CN')

const CFG = {
  id: 'contact_governance_agent',
  type: 'contact_governance',
  enabled: true,
  title: '通讯录治理',
  schedule: { cadence: 'daily' },
  window_hours: null,
  prompt: '',
  prompt_is_default: true,
  model: '',
  kos_enrich: false,
  trigger_mode: 'rolling_24h',
  timezone: '',
  body_full_priorities: [],
  mark_read_after_processing: true,
  trigger: { fire_hour: 4 },
  avatar: null,
  updated_at: null
} as unknown as ReportAgentConfig

function view(cfg: ReportAgentConfig = CFG, client?: QueryClient): React.ReactElement {
  const qc = client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <ContactGovernanceSettings cfg={cfg} />
    </QueryClientProvider>
  )
}
function renderSettings(cfg: ReportAgentConfig = CFG): void {
  render(view(cfg))
}
function save(): void {
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
}
function appendBox(): HTMLTextAreaElement {
  return screen.getByLabelText('提示词追加段') as HTMLTextAreaElement
}
function frameBox(): HTMLTextAreaElement {
  return screen.getByLabelText('组织架构框架') as HTMLTextAreaElement
}

beforeEach(() => {
  promptDoc.value = {
    data: { content: '', defaultContent: '你是 MailAgent 的通讯录管理员。' },
    isPending: false,
    isError: false
  }
  orgFrameDoc.value = { data: '', isPending: false, isError: false }
  mockSave.mockResolvedValue(CFG)
  savePrompt.mockResolvedValue(undefined)
  saveOrgFrame.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('能碰什么 — 工具清单', () => {
  test('列出真实 snake_case 工具名与三档权限（不照抄原型的点号写法）', () => {
    renderSettings()
    expect(screen.getByText('contact_search')).toBeTruthy()
    expect(screen.getByText('contact_propose_merge')).toBeTruthy()
    expect(screen.getByText('contact_refresh_profile')).toBeTruthy()
    expect(screen.queryByText('contacts.search')).toBeNull()
    // 计数从分组表推导而不是写死 —— 工具面扩编时这里跟着叶子走，幽灵 / 缺行由
    // contact_tool_face_leaf 三向闸负责，这里只管「每行都渲染了权限档」。
    const countOf = (permission: string): number =>
      CONTACT_TOOL_FACE_GROUPS.filter((group) => group.permission === permission).reduce(
        (n, group) => n + group.tools.length,
        0
      )
    expect(screen.getAllByText('读')).toHaveLength(countOf('read'))
    expect(screen.getAllByText('建议')).toHaveLength(countOf('propose'))
    expect(screen.getAllByText('写（轻）')).toHaveLength(countOf('write'))
    // 副标说「它读、它提议」，同屏列着写工具 —— 必须说清那一组治理扫描拿不到。
    expect(
      screen.getByText(
        '标「写（轻）」的那一组只在主对话里可用，每天那轮治理扫描一件写工具都拿不到。'
      )
    ).toBeTruthy()
    const totalTools = CONTACT_TOOL_FACE_GROUPS.reduce((n, group) => n + group.tools.length, 0)
    expect(screen.getByText(`注入的工具 · ${totalTools} 件`)).toBeTruthy()
  })
})

describe('指令 — 提示词（默认只读 + 追加段）', () => {
  test('默认全文默认折叠，点开才展示；追加段编辑框恒在', () => {
    renderSettings()
    expect(screen.queryByText('你是 MailAgent 的通讯录管理员。')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '查看默认提示词' }))
    expect(screen.getByText('你是 MailAgent 的通讯录管理员。')).toBeTruthy()
    expect(appendBox()).toBeTruthy()
  })

  test('🔴 追加段回显的是 content 原样，不是 content || defaultContent', () => {
    renderSettings()
    // 库里为空 = 没写过追加段 → 框是空的。把 defaultContent 灌进去，下次保存就会把默认
    // 物化成「用户自定义」，以后默认文案升级这行再也跟不上。
    expect(appendBox().value).toBe('')
    expect(screen.getByText('跟随默认')).toBeTruthy()
  })

  test('写过追加段 → 回显它 + pill 切「已自定义」', () => {
    promptDoc.value = {
      data: {
        content: '我们公司分三个事业部。',
        defaultContent: '你是 MailAgent 的通讯录管理员。'
      },
      isPending: false,
      isError: false
    }
    renderSettings()
    expect(appendBox().value).toBe('我们公司分三个事业部。')
    expect(screen.getByText('已自定义')).toBeTruthy()
  })
})

describe('保存 — 两次串行 + trigger 整列覆写', () => {
  test('agent 行 + profile doc 各发一次；trigger 发全套 {fire_hour, use_kos}', async () => {
    renderSettings()
    fireEvent.change(screen.getByLabelText('每日运行时刻'), { target: { value: '7' } })
    fireEvent.change(appendBox(), { target: { value: '我们公司分三个事业部。' } })
    save()

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    // 🔴 `use_kos` 没被碰过也要一起发：整列覆写下漏发就把它抹回缺省。
    expect(mockSave).toHaveBeenCalledWith('contact_governance_agent', {
      enabled: true,
      trigger: { fire_hour: 7, use_kos: true }
    })
    await waitFor(() => expect(savePrompt).toHaveBeenCalledWith('我们公司分三个事业部。'))
  })

  test('没碰排程 / 没碰追加段 → 不发 trigger，也不发提示词那次', async () => {
    renderSettings()
    save()
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave).toHaveBeenCalledWith('contact_governance_agent', { enabled: true })
    expect(savePrompt).not.toHaveBeenCalled()
  })

  test('一开始就读失败 → 追加段框禁用（连打字的机会都不给）', async () => {
    promptDoc.value = { data: undefined, isPending: false, isError: true }
    renderSettings()
    await waitFor(() =>
      expect(
        screen.getByText('提示词读取失败 · 先别保存，那会用一份空草稿覆盖已有内容')
      ).toBeTruthy()
    )
    expect(appendBox().disabled).toBe(true)
  })

  // 🔴 编辑到一半那条查询才失败（刷新 / 重连的真实路径）：框里是一份**半截草稿**，此时
  // 保存必须只写 agent 行、跳过提示词那次 —— 否则半截草稿会盖掉 owner 已有的追加段。
  // 「一开始就失败」那条测不到这个守卫（框是 disabled，appendDirty 永远为 false）。
  test('🔴 编辑后才读失败 → 保存只写行，不拿半截草稿覆盖提示词', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // 🔴 每次都现造一份新的 element：把同一个 element 对象再交给 rerender，React 认出引用
    // 相同会直接 bail out，mock 换了值也不会重渲染（实测过，断言会找不到失败行）。
    const { rerender } = render(view(CFG, client))
    fireEvent.change(appendBox(), { target: { value: '半截草稿' } })

    promptDoc.value = { data: undefined, isPending: false, isError: true }
    rerender(view(CFG, client))
    await waitFor(() =>
      expect(
        screen.getByText('提示词读取失败 · 先别保存，那会用一份空草稿覆盖已有内容')
      ).toBeTruthy()
    )

    save()
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(savePrompt).not.toHaveBeenCalled()
  })

  test('行保存失败 → 错误如实显示，提示词那次不发（串行不吞）', async () => {
    mockSave.mockRejectedValue(new Error('E_INVALID_ARG: bad row'))
    renderSettings()
    fireEvent.change(appendBox(), { target: { value: '追加一段' } })
    save()

    await waitFor(() => expect(screen.getByText(/E_INVALID_ARG: bad row/)).toBeTruthy())
    expect(savePrompt).not.toHaveBeenCalled()
  })

  test('提示词那次失败 → 同样如实报错（第二段的失败不许被吞成「已保存」）', async () => {
    savePrompt.mockRejectedValue(new Error('E_IO: doc write failed'))
    renderSettings()
    fireEvent.change(appendBox(), { target: { value: '追加一段' } })
    save()

    await waitFor(() => expect(screen.getByText(/E_IO: doc write failed/)).toBeTruthy())
    expect(mockSave).toHaveBeenCalledTimes(1)
  })
})

// 组织架构框架 = 同机制的另一份 profile doc（`contact_org_frame`）。它与提示词追加段共用
// 同一条「读失败不回写」纪律 —— 这份文档没有默认，空内容就是把 owner 的整份组织架构清掉。
describe('指令 — 组织架构框架', () => {
  test('回显库里的内容；placeholder 给出 ` / ` 分层的格式示例', () => {
    orgFrameDoc.value = {
      data: '# 部门框架\nEBG / ENBU / 产品部',
      isPending: false,
      isError: false
    }
    renderSettings()
    expect(frameBox().value).toBe('# 部门框架\nEBG / ENBU / 产品部')
    // 空库时才看得到 placeholder，但属性恒在 —— 直接读属性，不依赖渲染态。
    expect(frameBox().getAttribute('placeholder')).toContain('EBG / ENBU / 产品部')
    expect(frameBox().getAttribute('placeholder')).toContain('# 公司')
  })

  test('改了才发；没碰过不发（避免把没动的文档重写一遍）', async () => {
    renderSettings()
    save()
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(saveOrgFrame).not.toHaveBeenCalled()

    cleanup()
    vi.clearAllMocks()
    mockSave.mockResolvedValue(CFG)
    saveOrgFrame.mockResolvedValue(undefined)
    renderSettings()
    fireEvent.change(frameBox(), { target: { value: 'EBG / 财务' } })
    save()
    await waitFor(() => expect(saveOrgFrame).toHaveBeenCalledWith('EBG / 财务'))
  })

  test('清空 = 不约束：空串照发（不是「没改」，也不是恢复默认）', async () => {
    orgFrameDoc.value = { data: 'EBG / ENBU', isPending: false, isError: false }
    renderSettings()
    fireEvent.change(frameBox(), { target: { value: '' } })
    save()
    await waitFor(() => expect(saveOrgFrame).toHaveBeenCalledWith(''))
  })

  test('🔴 编辑后才读失败 → 保存只写行，不拿半截草稿覆盖框架', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // 🔴 每次现造新 element（同上：引用相同 React 会 bail out，mock 换值也不重渲染）。
    const { rerender } = render(view(CFG, client))
    fireEvent.change(frameBox(), { target: { value: '半截草稿' } })

    orgFrameDoc.value = { data: undefined, isPending: false, isError: true }
    rerender(view(CFG, client))
    await waitFor(() => expect(frameBox().disabled).toBe(true))

    save()
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(saveOrgFrame).not.toHaveBeenCalled()
  })
})

// 「参考 KOS」= 同一列 trigger_json 的第二个字面字段（后端行级开关）。同画像页那条纪律：
// 缺字段默认**开**（老行没有这个键，读成关会让一个从没被关过的开关显示成「关着」），
// 且只动这个开关时 fire_hour 必须原样写回。
describe('它自己的设置 — 参考 KOS', () => {
  function kosSwitch(): HTMLElement {
    return screen.getByRole('switch', { name: '参考 KOS 资料' })
  }

  test('🔴 trigger 里没有 use_kos（老行）→ 开关显示「开」', () => {
    renderSettings()
    expect(kosSwitch().getAttribute('aria-checked')).toBe('true')
  })

  test('存过 false → 如实回显「关」（证明上一条不是恒真）', () => {
    renderSettings({
      ...CFG,
      trigger: { fire_hour: 4, use_kos: false }
    } as unknown as ReportAgentConfig)
    expect(kosSwitch().getAttribute('aria-checked')).toBe('false')
  })

  test('野值（不是 boolean）→ 回落到开', () => {
    renderSettings({
      ...CFG,
      trigger: { fire_hour: 4, use_kos: 'no' }
    } as unknown as ReportAgentConfig)
    expect(kosSwitch().getAttribute('aria-checked')).toBe('true')
  })

  test('🔴 只关 KOS 开关，保存时把同列的时刻原样一起发', async () => {
    renderSettings({
      ...CFG,
      trigger: { fire_hour: 6, use_kos: true }
    } as unknown as ReportAgentConfig)

    fireEvent.click(kosSwitch())
    save()

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave).toHaveBeenCalledWith('contact_governance_agent', {
      enabled: true,
      trigger: { fire_hour: 6, use_kos: false }
    })
  })
})

describe('不出 flag 状态提示', () => {
  test('页里没有「总闸未开 / 已开」这类说明段（owner 08-19 拍板）', () => {
    renderSettings()
    expect(screen.queryByText(/总开关/)).toBeNull()
    expect(screen.queryByText(/总闸/)).toBeNull()
    expect(screen.queryByText(/MAILAGENT_CONTACT_AGENT_ENABLED/)).toBeNull()
    // canary：页确实渲染出来了，上面三条否定断言不是因为整个组件是空的。
    expect(screen.getByRole('switch', { name: '启用此 Agent' })).toBeTruthy()
  })
})
