// @vitest-environment happy-dom
//
// 0813 主 Agent 配置面：卡片（纯展示 + 点整卡开抽屉，与其余 agent 卡同范式）
// + MainAssistantDrawer（名字回显当前生效名 / 头像草稿 / 内联身份文档编辑器 / footer 显式保存）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { AssistantIdentity } from '@shared/api/types'
import { __resetAssistantIdentity } from '@shared/assistant/assistantIdentity'
import { MainAssistantCard } from '../../src/shared/components/agents/MainAssistantCard'
import { MainAssistantDrawer } from '../../src/shared/components/agents/drawers/MainAssistantDrawer'

await i18n.changeLanguage('zh-CN')

let identityOnServer: AssistantIdentity = { name: null, avatar: null }
const getAssistantIdentity = vi.fn(async () => identityOnServer)
const setAssistantIdentity = vi.fn(async (next: AssistantIdentity) => {
  identityOnServer = next
  return next
})

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ chat: { getAssistantIdentity, setAssistantIdentity } })
}))

// 抽屉内联的身份文档编辑器（Settings 的 StandingDocsSection 本体）—— 本测关心的是
// 「它确实被挂进抽屉」，不重测它自己的加载/编辑逻辑（已有 tests/shared/StandingDocsSection.test.tsx）。
vi.mock('@shared/components/settings/CustomAiSection', () => ({
  StandingDocsSection: (): React.ReactElement => <div data-testid="standing-docs-section" />
}))

function renderDrawer(open = true): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MainAssistantDrawer open={open} onClose={() => {}} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  identityOnServer = { name: null, avatar: null }
  getAssistantIdentity.mockClear()
  setAssistantIdentity.mockClear()
  __resetAssistantIdentity()
})

afterEach(cleanup)

describe('MainAssistantCard', () => {
  test('未配置：展示默认名（chat.title）+ 徽标；取数经 GET', async () => {
    render(<MainAssistantCard onConfig={() => {}} />)
    await waitFor(() => expect(getAssistantIdentity).toHaveBeenCalled())
    expect(screen.getByRole('heading', { name: 'AI 助手' })).toBeTruthy()
    expect(screen.getByText('默认助手')).toBeTruthy()
  })

  test('已配置名字：展示 Jarvis', async () => {
    identityOnServer = { name: 'Jarvis', avatar: null }
    render(<MainAssistantCard onConfig={() => {}} />)
    expect(await screen.findByRole('heading', { name: 'Jarvis' })).toBeTruthy()
  })

  test('不再有独立「配置」按钮；点整卡 / 回车都开抽屉', async () => {
    const onConfig = vi.fn()
    render(<MainAssistantCard onConfig={onConfig} />)
    await waitFor(() => expect(getAssistantIdentity).toHaveBeenCalled())
    expect(screen.queryByTestId('main-assistant-configure')).toBeNull()
    const card = screen.getByTestId('main-assistant-card')
    fireEvent.click(card)
    expect(onConfig).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(card, { key: 'Enter' })
    expect(onConfig).toHaveBeenCalledTimes(2)
  })
})

describe('MainAssistantDrawer', () => {
  test('未配置：名字输入框回显当前生效名（不是空串）', async () => {
    renderDrawer()
    await waitFor(() => expect(getAssistantIdentity).toHaveBeenCalled())
    const input = await screen.findByDisplayValue('AI 助手')
    expect((input as HTMLInputElement).value).toBe('AI 助手')
  })

  test('已配置名字：抽屉标题与输入框都显示它', async () => {
    identityOnServer = { name: 'Jarvis', avatar: null }
    renderDrawer()
    expect(await screen.findByRole('heading', { name: '主 Agent · Jarvis' })).toBeTruthy()
    expect(screen.getByDisplayValue('Jarvis')).toBeTruthy()
  })

  test('身份文档编辑器内联在抽屉里（复用 Settings 那一份）', async () => {
    renderDrawer()
    await waitFor(() => expect(getAssistantIdentity).toHaveBeenCalled())
    expect(screen.getByTestId('standing-docs-section')).toBeTruthy()
  })

  test('改名 → 保存：trim + 全量 PUT', async () => {
    renderDrawer()
    await waitFor(() => expect(getAssistantIdentity).toHaveBeenCalled())
    fireEvent.change(await screen.findByDisplayValue('AI 助手'), {
      target: { value: '  Jarvis  ' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(setAssistantIdentity).toHaveBeenCalledWith({ name: 'Jarvis', avatar: null })
    )
  })

  test('未改名直接保存：回显的默认名不落库（name 仍为 null）', async () => {
    renderDrawer()
    await waitFor(() => expect(getAssistantIdentity).toHaveBeenCalled())
    await screen.findByDisplayValue('AI 助手')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(setAssistantIdentity).toHaveBeenCalledWith({ name: null, avatar: null })
    )
  })

  test('头像编辑：展开「更换」→ 点形状 → 保存带既有名字', async () => {
    identityOnServer = { name: 'Jarvis', avatar: null }
    renderDrawer()
    await screen.findByDisplayValue('Jarvis')
    fireEvent.click(screen.getByRole('button', { name: '更换' }))
    // 未配置头像时编辑器喂官方形象（sphere/orange）——点 cube 应保存 cube/orange
    fireEvent.click(screen.getByTestId('avatar-shape-grid').querySelector('[aria-label="cube"]')!)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(setAssistantIdentity).toHaveBeenCalledWith({
        name: 'Jarvis',
        avatar: { type: 'bot', shape: 'cube', color: 'orange' }
      })
    )
  })
})
