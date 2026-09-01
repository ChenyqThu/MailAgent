// @vitest-environment happy-dom
//
// P4a agent-config lane — 主 Agent 配置页。承接 MainAssistantCard.test 里
// `MainAssistantDrawer` 那组随旧抽屉退役的身份保存语义：
//   🔴 名字 dirty-tracking：输入框回显的是**当前生效名**（未配置时回显默认名 chat.title），
//      但未编辑就保存时写回的仍是 identity.name（可能为 null = 跟随默认名）—— 把回显的
//      默认字面量落库，以后默认名改了这行就跟不上了。
//   • 改名走 trim + NAME_MAX 截断；头像与名字一次全量 PUT。
//   • 身份文档区是「同一份数据」的只读卡指路 + 内联 StandingDocsSection（单一可写面）。
//
// AgentSettingsView 的分发分支与「绝不发 report_agent patch」在
// AgentSettingsMainBranch.test.tsx，这里只测表单自身。
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

const { identity, mockSetIdentity, mockPrime } = vi.hoisted(() => ({
  identity: { value: { name: null as string | null, avatar: null as unknown } },
  mockSetIdentity: vi.fn(),
  mockPrime: vi.fn()
}))

vi.mock('@shared/assistant/assistantIdentity', () => ({
  useAssistantIdentity: () => identity.value,
  primeAssistantIdentity: mockPrime
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ chat: { setAssistantIdentity: mockSetIdentity } })
}))

// 身份文档编辑器是 设置 → AI 里那同一个组件（自带数据依赖）—— 打桩成可辨认的标记，
// 只验「它被内联进来了」，它自己的行为归 CustomAiSection 的测试。
vi.mock('@shared/components/settings/CustomAiSection', () => ({
  StandingDocsSection: () => <div data-testid="standing-docs-section" />
}))

import i18n from '@shared/i18n'
import { MainAssistantSettings } from '../../src/shared/components/agents/settings/MainAssistantSettings'

await i18n.changeLanguage('zh-CN')

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(createElement(MainAssistantSettings), {
    wrapper: ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children)
  })
}
function nameInput(): HTMLInputElement {
  return screen.getByPlaceholderText('AI 助手（比如 Jarvis）') as HTMLInputElement
}
function save(): void {
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
}

beforeEach(() => {
  identity.value = { name: null, avatar: null }
  mockSetIdentity.mockResolvedValue({ name: null, avatar: null })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('回显 — 当前生效名', () => {
  test('未配置：输入框回显默认名（不是空串）', () => {
    renderSettings()
    expect(nameInput().value).toBe('AI 助手')
  })

  test('已配置：页头标题与输入框都是它', () => {
    identity.value = { name: 'Jarvis', avatar: null }
    renderSettings()
    expect(nameInput().value).toBe('Jarvis')
    expect(screen.getByRole('heading', { name: 'Jarvis' })).toBeTruthy()
  })

  test('主 Agent 没有「停用」这回事 → 页头无启用开关', () => {
    renderSettings()
    expect(screen.queryByRole('switch')).toBeNull()
  })
})

describe('保存 — 名字 dirty-tracking', () => {
  test('🔴 未改名直接保存 → name 仍是 identity.name（null），回显的默认名不落库', async () => {
    renderSettings()
    expect(nameInput().value).toBe('AI 助手')
    save()
    await waitFor(() => expect(mockSetIdentity).toHaveBeenCalledTimes(1))
    expect(mockSetIdentity.mock.calls[0][0]).toEqual({ name: null, avatar: null })
  })

  test('改名 → trim 后全量 PUT（name + avatar 一起发）', async () => {
    identity.value = { name: 'Jarvis', avatar: null }
    renderSettings()
    fireEvent.change(nameInput(), { target: { value: '  小助  ' } })
    save()
    await waitFor(() => expect(mockSetIdentity).toHaveBeenCalledTimes(1))
    expect(mockSetIdentity.mock.calls[0][0]).toEqual({ name: '小助', avatar: null })
  })

  test('改成全空白 → name=null（回到跟随默认名，不是存一个空串）', async () => {
    identity.value = { name: 'Jarvis', avatar: null }
    renderSettings()
    fireEvent.change(nameInput(), { target: { value: '   ' } })
    save()
    await waitFor(() => expect(mockSetIdentity).toHaveBeenCalledTimes(1))
    expect(mockSetIdentity.mock.calls[0][0].name).toBeNull()
  })

  test('超长名字 → PUT 前本地切到 NAME_MAX=40（与后端同款截断）', async () => {
    renderSettings()
    fireEvent.change(nameInput(), { target: { value: 'x'.repeat(60) } })
    save()
    await waitFor(() => expect(mockSetIdentity).toHaveBeenCalledTimes(1))
    expect(mockSetIdentity.mock.calls[0][0].name).toBe('x'.repeat(40))
  })

  test('保存成功 → primeAssistantIdentity 拿服务端 canonical 回写 store', async () => {
    mockSetIdentity.mockResolvedValue({ name: '小助', avatar: null })
    renderSettings()
    fireEvent.change(nameInput(), { target: { value: '小助' } })
    save()
    await waitFor(() => expect(mockPrime).toHaveBeenCalledWith({ name: '小助', avatar: null }))
  })
})

describe('保存 — 头像', () => {
  test('展开「更换」→ 选形状 → 保存把头像与既有名字一起发', async () => {
    identity.value = { name: 'Jarvis', avatar: null }
    renderSettings()
    fireEvent.click(screen.getByRole('button', { name: '更换' }))
    fireEvent.click(within(screen.getByTestId('avatar-shape-grid')).getByLabelText('cloudee'))
    save()
    await waitFor(() => expect(mockSetIdentity).toHaveBeenCalledTimes(1))
    const next = mockSetIdentity.mock.calls[0][0]
    expect(next.name).toBe('Jarvis')
    expect(next.avatar).toMatchObject({ type: 'bot', shape: 'cloudee' })
  })

  test('没碰头像 → 原样回传 identity.avatar（未设置就是 null，不物化官方形象）', async () => {
    renderSettings()
    // 回显喂的是官方形象（预览要与 chat 里一致），但那只是 draft 的展示值。
    expect(screen.queryByTestId('avatar-shape-grid')).toBeNull()
    save()
    await waitFor(() => expect(mockSetIdentity).toHaveBeenCalledTimes(1))
    expect(mockSetIdentity.mock.calls[0][0].avatar).toBeNull()
  })
})

describe('指令 — 身份文档单一可写面', () => {
  test('只读卡说清与 设置 → AI → 身份文档 同源；编辑器本体内联在下面', () => {
    renderSettings()
    expect(screen.getByText('注入的身份文档')).toBeTruthy()
    expect(screen.getByText('与「设置 → AI → 身份文档」是同一份，改哪边都一样。')).toBeTruthy()
    expect(screen.getByTestId('standing-docs-section')).toBeTruthy()
  })

  test('只有身份 / 指令两区（主 Agent 没有模型 · 排程 · 删除）', () => {
    const { container } = renderSettings()
    const labels = Array.from(container.querySelectorAll('section')).map((el) =>
      el.getAttribute('aria-label')
    )
    expect(labels).toEqual(['身份', '指令'])
  })
})
