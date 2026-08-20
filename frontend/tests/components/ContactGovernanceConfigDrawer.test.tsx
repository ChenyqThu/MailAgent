// @vitest-environment happy-dom
//
// /agents「通讯录治理」配置抽屉（v2 新增）。四件事：
//   ① 工具清单从工作台抽屉搬到这里，内容一字未改（真实 snake_case 名 + 三档权限 + 两句脚注）；
//   ② 提示词是「默认全文只读 + 追加段编辑」，**不是**全文替换 —— 回显的是 `content` 原样，
//      把 defaultContent 灌进编辑框会在下一次保存时把默认物化成用户自定义；
//   ③ 保存是两次串行调用（agent 行 + profile doc），trigger_json **整列覆写**只发 {fire_hour}；
//   ④ 提示词读失败时那个框是空草稿 —— 保存**不许**拿它覆盖 owner 已有的内容。
//
// 🔴 抽屉里没有任何「总闸未开 / 已开」说明段（owner 08-19 拍板）：下面有一条否定断言钉住它，
// 免得后来谁「照画像抽屉补齐」又把它加回来。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { save, isSaving } = vi.hoisted(() => ({ save: vi.fn(), isSaving: false }))
vi.mock('@shared/components/agents/hooks', () => ({
  useSetConfig: () => ({ save, isSaving })
}))

// 只替换取模型表那一个 hook（模块另有 `resolveApiBaseUrl` 等导出被其他模块引着，
// 整体替换会把它们打掉 —— 实测报 "No fetchChatConfigModelsProbe export is defined"）。
vi.mock('@shared/hooks/useLlmModels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/hooks/useLlmModels')>()
  return { ...actual, useEnabledModels: () => ({ models: [] }) }
})

// 头像编辑器拉 bot-avatar 那一整套（canvas / 动画），本闸不关心它 —— 换成瘦身桩。
vi.mock('@shared/components/agents/AgentAvatar', () => ({
  AgentIdentityHeader: () => <div data-testid="agent-identity-header" />,
  AgentAvatar: () => <div />
}))

const { promptDoc, savePrompt } = vi.hoisted(() => ({
  promptDoc: {
    value: {
      data: { content: '', defaultContent: '你是 MailAgent 的通讯录管理员。' } as
        | { content: string; defaultContent: string }
        | undefined,
      isPending: false,
      isError: false
    }
  },
  savePrompt: vi.fn()
}))
vi.mock('@shared/components/contacts/hooks', () => ({
  useContactAgentPrompt: () => promptDoc.value,
  useSaveContactAgentPrompt: () => ({ mutateAsync: savePrompt, isPending: false })
}))

import i18n from '@shared/i18n'
import { ContactGovernanceConfigDrawer } from '@shared/components/agents/drawers/ContactGovernanceConfigDrawer'
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

function renderDrawer(cfg: ReportAgentConfig | null = CFG): { onClose: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ContactGovernanceConfigDrawer cfg={cfg} open onClose={onClose} />
    </QueryClientProvider>
  )
  return { onClose }
}

beforeEach(() => {
  promptDoc.value = {
    data: { content: '', defaultContent: '你是 MailAgent 的通讯录管理员。' },
    isPending: false,
    isError: false
  }
  save.mockResolvedValue(CFG)
  savePrompt.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ContactGovernanceConfigDrawer · 工具清单（迁自工作台抽屉）', () => {
  test('列出真实 snake_case 工具名与三档权限（不照抄原型的点号写法）', async () => {
    renderDrawer()
    await waitFor(() => expect(screen.getByText('contact_search')).toBeTruthy())

    expect(screen.getByText('contact_propose_merge')).toBeTruthy()
    expect(screen.getByText('contact_refresh_profile')).toBeTruthy()
    expect(screen.queryByText('contacts.search')).toBeNull()
    expect(screen.getAllByText('读')).toHaveLength(3)
    expect(screen.getAllByText('建议')).toHaveLength(3)
    expect(screen.getAllByText('写（轻）')).toHaveLength(3)
    // 副标说「它读、它提议」，同屏列着写工具 —— 必须说清那三件治理扫描拿不到。
    expect(
      screen.getByText(
        '标「写（轻）」的三件只在主对话里可用，每天那轮治理扫描一件写工具都拿不到。'
      )
    ).toBeTruthy()
    // Field label 已经报了件数，件数来自零依赖叶子而不是硬编码。
    expect(screen.getByText('注入的工具 · 9 件')).toBeTruthy()
  })
})

describe('ContactGovernanceConfigDrawer · 提示词（默认只读 + 追加段）', () => {
  test('默认全文默认折叠，点开才展示；追加段编辑框恒在', () => {
    renderDrawer()
    expect(screen.queryByText('你是 MailAgent 的通讯录管理员。')).toBeNull()

    fireEvent.click(screen.getByText('查看默认提示词'))
    expect(screen.getByText('你是 MailAgent 的通讯录管理员。')).toBeTruthy()
    expect(screen.getByLabelText('提示词追加段')).toBeTruthy()
  })

  test('🔴 追加段回显的是 content 原样，不是 content || defaultContent', () => {
    renderDrawer()
    // 库里为空 = 没写过追加段 → 框是空的。把 defaultContent 灌进去，下次保存就会把默认
    // 物化成「用户自定义」，以后默认文案升级这行再也跟不上。
    expect((screen.getByLabelText('提示词追加段') as HTMLTextAreaElement).value).toBe('')
    expect(screen.getByText('跟随默认')).toBeTruthy()
  })

  test('写过追加段 → 回显它 + pill 切「已自定义」', () => {
    promptDoc.value = {
      data: { content: '我们公司分三个事业部。', defaultContent: '你是 MailAgent 的通讯录管理员。' },
      isPending: false,
      isError: false
    }
    renderDrawer()

    expect((screen.getByLabelText('提示词追加段') as HTMLTextAreaElement).value).toBe(
      '我们公司分三个事业部。'
    )
    expect(screen.getByText('已自定义')).toBeTruthy()
  })
})

describe('ContactGovernanceConfigDrawer · 保存', () => {
  test('两次串行调用：agent 行 + profile doc；trigger 整列覆写只发 fire_hour', async () => {
    renderDrawer()
    fireEvent.change(screen.getByLabelText('每日运行时刻（0–23 点）'), { target: { value: '7' } })
    fireEvent.change(screen.getByLabelText('提示词追加段'), {
      target: { value: '我们公司分三个事业部。' }
    })

    fireEvent.click(screen.getByText('保存'))

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save).toHaveBeenCalledWith('contact_governance_agent', {
      enabled: true,
      trigger: { fire_hour: 7 }
    })
    await waitFor(() => expect(savePrompt).toHaveBeenCalledWith('我们公司分三个事业部。'))
  })

  test('没碰排程 → 不发 trigger（整列覆写下多发一次会把没改的字段也重写一遍）', async () => {
    renderDrawer()
    fireEvent.click(screen.getByText('保存'))

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save).toHaveBeenCalledWith('contact_governance_agent', { enabled: true })
    // 追加段也没碰 → 那条调用一次都不发。
    expect(savePrompt).not.toHaveBeenCalled()
  })

  test('时刻越界 → 就地报错，一个请求都不发', async () => {
    renderDrawer()
    fireEvent.change(screen.getByLabelText('每日运行时刻（0–23 点）'), { target: { value: '25' } })
    fireEvent.click(screen.getByText('保存'))

    await waitFor(() =>
      expect(screen.getByText('每日运行时刻要是 0 到 23 之间的整数')).toBeTruthy()
    )
    expect(save).not.toHaveBeenCalled()
    expect(savePrompt).not.toHaveBeenCalled()
  })

  test('一开始就读失败 → 追加段框禁用（连打字的机会都不给）', async () => {
    promptDoc.value = { data: undefined, isPending: false, isError: true }
    renderDrawer()
    await waitFor(() =>
      expect(
        screen.getByText('提示词读取失败 · 先别保存，那会用一份空草稿覆盖已有内容')
      ).toBeTruthy()
    )
    expect((screen.getByLabelText('提示词追加段') as HTMLTextAreaElement).disabled).toBe(true)
  })

  // 🔴 编辑到一半那条查询才失败（刷新 / 重连的真实路径）：框里是一份**半截草稿**，此时
  // 保存必须只写 agent 行、跳过提示词那次 —— 否则半截草稿会盖掉 owner 已有的追加段。
  // 「一开始就失败」那条测不到这个守卫（框是 disabled，appendDirty 永远为 false）。
  test('🔴 编辑后才读失败 → 保存只写行，不拿半截草稿覆盖提示词', async () => {
    const onClose = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // 🔴 每次都现造一份新的 element：把同一个 element 对象再交给 rerender，React 认出引用
    // 相同会直接 bail out，mock 换了值也不会重渲染（实测过，断言会找不到失败行）。
    const view = (): React.ReactElement => (
      <QueryClientProvider client={client}>
        <ContactGovernanceConfigDrawer cfg={CFG} open onClose={onClose} />
      </QueryClientProvider>
    )
    const { rerender } = render(view())
    fireEvent.change(screen.getByLabelText('提示词追加段'), { target: { value: '半截草稿' } })

    promptDoc.value = { data: undefined, isPending: false, isError: true }
    rerender(view())
    await waitFor(() =>
      expect(
        screen.getByText('提示词读取失败 · 先别保存，那会用一份空草稿覆盖已有内容')
      ).toBeTruthy()
    )

    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(savePrompt).not.toHaveBeenCalled()
  })

  test('行保存失败 → 抽屉不关、错误如实显示、提示词那次不发（串行不吞）', async () => {
    save.mockRejectedValue(new Error('E_INVALID_ARG: bad row'))
    const { onClose } = renderDrawer()
    fireEvent.change(screen.getByLabelText('提示词追加段'), { target: { value: '追加一段' } })
    fireEvent.click(screen.getByText('保存'))

    await waitFor(() => expect(screen.getByText(/E_INVALID_ARG: bad row/)).toBeTruthy())
    expect(savePrompt).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('ContactGovernanceConfigDrawer · 不出 flag 状态提示', () => {
  test('抽屉里没有「总闸未开 / 已开」这类说明段', () => {
    renderDrawer()
    expect(screen.queryByText(/总开关/)).toBeNull()
    expect(screen.queryByText(/总闸/)).toBeNull()
    expect(screen.queryByText(/MAILAGENT_CONTACT_AGENT_ENABLED/)).toBeNull()
    // canary：抽屉确实渲染出来了，上面三条否定断言不是因为整个组件是空的。
    expect(screen.getByText('启用治理 Agent')).toBeTruthy()
  })
})
