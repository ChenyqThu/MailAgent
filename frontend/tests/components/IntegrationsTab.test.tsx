// @vitest-environment happy-dom
//
// IntegrationsTab 回归 — task 07-07 R4d：Tavily key 的「Web 搜索」Section 已从 IntegrationsTab
// 移除，迁到 AI tab → 系统能力区「联网」卡（SystemCapabilitiesSection 的 WebCapabilityRow）。
// 此处断言：IntegrationsTab 不再渲染「Web 搜索」Section / Tavily 字段，但其余集成区照常渲染。
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

function setReadyEnv(): void {
  useEnvStore.setState({
    state: {
      status: 'ready',
      snapshot: {
        path: '/tmp/.env',
        exists: true,
        values: {},
        managedKeys: [],
        secretKeys: []
      }
    }
  })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useEnvStore.setState({ state: { status: 'idle' } })
})

describe('IntegrationsTab — Web 搜索 Section 已迁出（R4d）', () => {
  test('不再渲染「Web 搜索」Section / Tavily 字段', () => {
    setReadyEnv()
    render(<IntegrationsTab />)
    // 迁到系统能力区「联网」卡后，IntegrationsTab 不应再出现 Web 搜索 section 或 Tavily 字段。
    expect(screen.queryByText('Web 搜索')).toBeNull()
    expect(screen.queryByLabelText('Tavily API Key')).toBeNull()
  })

  test('其余集成区照常渲染（KOS section 在场，证明只删了 Web 搜索）', () => {
    setReadyEnv()
    render(<IntegrationsTab />)
    expect(screen.getByText('知识大脑 (KOS)')).toBeTruthy()
  })
})
