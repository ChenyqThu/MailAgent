// @vitest-environment happy-dom
//
// IntegrationsTab「Web 搜索」Section 测试 — Tavily API key 字段（07-07 web_search Tavily provider）。
//
// 覆盖：
//   1. section 渲染（标题 + 字段 label）。
//   2. Tavily 字段是 masked（type=password，不回显明文）。
//   3. 配置态投影：值 '***'（已配置）→ secretSet placeholder；'' / 缺失（未配置）→ secretUnset。
//
// EnvSecretField（CLI key）用 useMailApi —— render 期不触发 IPC，mock 成空 stub 即可。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    settings: { setSecret: vi.fn().mockResolvedValue(undefined) }
  })
}))

import i18n from '@shared/i18n'
import { IntegrationsTab } from '../../src/shared/components/settings/tabs/IntegrationsTab'
import { useEnvStore } from '@shared/state/env'

await i18n.changeLanguage('zh-CN')

function setEnv(tavilyValue: string | undefined): void {
  const values: Record<string, string> = {}
  if (tavilyValue !== undefined) values.TAVILY_API_KEY = tavilyValue
  useEnvStore.setState({
    state: {
      status: 'ready',
      snapshot: {
        path: '/tmp/.env',
        exists: true,
        values,
        managedKeys: ['TAVILY_API_KEY'],
        secretKeys: ['TAVILY_API_KEY']
      }
    }
  })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useEnvStore.setState({ state: { status: 'idle' } })
})

describe('IntegrationsTab — Web 搜索 Section (Tavily key)', () => {
  test('section + Tavily 字段渲染，输入为 masked(password)', () => {
    setEnv('') // 未配置
    render(<IntegrationsTab />)
    expect(screen.getByText('Web 搜索')).toBeTruthy()
    const input = screen.getByLabelText('Tavily API Key') as HTMLInputElement
    expect(input).toBeTruthy()
    // masked：默认 type=password（不回显明文）。
    expect(input.getAttribute('type')).toBe('password')
  })

  test('已配置（值 ***）→ secretSet placeholder（已设置态，不回显明文）', () => {
    setEnv('***')
    render(<IntegrationsTab />)
    const input = screen.getByLabelText('Tavily API Key') as HTMLInputElement
    // 配置态：placeholder 显示「已设置」文案；value 恒空（renderer 从不持明文）。
    expect(input.getAttribute('placeholder')).toBe(i18n.t('settings.envField.secretSet'))
    expect(input.value).toBe('')
  })

  test('未配置（值空/缺失）→ secretUnset placeholder（未设置态）', () => {
    setEnv(undefined) // 快照里无该 key
    render(<IntegrationsTab />)
    const input = screen.getByLabelText('Tavily API Key') as HTMLInputElement
    expect(input.getAttribute('placeholder')).toBe(i18n.t('settings.envField.secretUnset'))
  })
})
