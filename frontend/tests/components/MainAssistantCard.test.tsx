// @vitest-environment happy-dom
//
// 0813 主 Agent 配置卡：身份取数（模块级 store）→ 展示名 / 配置展开 / 名字保存
// （trim + PUT + primeAssistantIdentity 即时广播）/ 头像编辑回写。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { AssistantIdentity } from '@shared/api/types'
import { __resetAssistantIdentity } from '@shared/assistant/assistantIdentity'
import { MainAssistantCard } from '../../src/shared/components/agents/MainAssistantCard'

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

beforeEach(() => {
  identityOnServer = { name: null, avatar: null }
  getAssistantIdentity.mockClear()
  setAssistantIdentity.mockClear()
  __resetAssistantIdentity()
})

afterEach(cleanup)

describe('MainAssistantCard', () => {
  test('未配置：展示默认名（chat.title）+ 徽标；取数经 GET', async () => {
    render(<MainAssistantCard />)
    await waitFor(() => expect(getAssistantIdentity).toHaveBeenCalled())
    expect(screen.getByRole('heading', { name: 'AI 助手' })).toBeTruthy()
    expect(screen.getByText('默认助手')).toBeTruthy()
  })

  test('已配置名字：展示 Jarvis', async () => {
    identityOnServer = { name: 'Jarvis', avatar: null }
    render(<MainAssistantCard />)
    expect(await screen.findByRole('heading', { name: 'Jarvis' })).toBeTruthy()
  })

  test('配置展开 → 名字输入 blur 保存（trim + 全量 PUT）→ 展示即时收敛', async () => {
    render(<MainAssistantCard />)
    await waitFor(() => expect(getAssistantIdentity).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('main-assistant-configure'))
    const input = screen.getByTestId('main-assistant-name')
    fireEvent.change(input, { target: { value: '  Jarvis  ' } })
    fireEvent.blur(input)
    await waitFor(() =>
      expect(setAssistantIdentity).toHaveBeenCalledWith({ name: 'Jarvis', avatar: null })
    )
    // primeAssistantIdentity 即时广播 → 卡片标题收敛为新名字
    expect(await screen.findByRole('heading', { name: 'Jarvis' })).toBeTruthy()
  })

  test('名字未变化 blur 不发 PUT', async () => {
    identityOnServer = { name: 'Jarvis', avatar: null }
    render(<MainAssistantCard />)
    await screen.findByRole('heading', { name: 'Jarvis' })
    fireEvent.click(screen.getByTestId('main-assistant-configure'))
    const input = screen.getByTestId('main-assistant-name')
    fireEvent.blur(input)
    expect(setAssistantIdentity).not.toHaveBeenCalled()
  })

  test('头像编辑：点形状 → 全量 PUT（带既有名字）', async () => {
    identityOnServer = { name: 'Jarvis', avatar: null }
    render(<MainAssistantCard />)
    await screen.findByRole('heading', { name: 'Jarvis' })
    fireEvent.click(screen.getByTestId('main-assistant-configure'))
    // 未配置头像时编辑器喂官方形象（sphere/orange）——点 cube 应保存 cube/orange
    fireEvent.click(screen.getByTestId('avatar-shape-grid').querySelector('[aria-label="cube"]')!)
    await waitFor(() =>
      expect(setAssistantIdentity).toHaveBeenCalledWith({
        name: 'Jarvis',
        avatar: { type: 'bot', shape: 'cube', color: 'orange' }
      })
    )
  })
})
