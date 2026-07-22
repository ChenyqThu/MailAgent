// @vitest-environment happy-dom
//
// IntegrationsTab 回归 — task 07-07 R4d：Tavily key 的「Web 搜索」Section 已从 IntegrationsTab
// 移除，迁到 AI tab → 系统能力区「联网」卡（SystemCapabilitiesSection 的 WebCapabilityRow）。
// 此处断言：IntegrationsTab 不再渲染「Web 搜索」Section / Tavily 字段，但其余集成区照常渲染。
//
// issue #54 起 KOS 区新增「连接检查」（api.chat.kosDoctor 分步 ok/fail）+ 激活 gate 被动
// 显因（useKosGate：开关开但凭据未齐 → 警告行）。useMailApi / useKosGate 均 mock；
// 组件用 useQueryClient（doctor 后失效刷新 gate 探针）→ render 须包 QueryClientProvider。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const kosDoctorMock = vi.fn<() => Promise<unknown>>()
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    settings: { setSecret: vi.fn().mockResolvedValue(undefined) },
    chat: { kosDoctor: kosDoctorMock }
  })
}))

const kosGateMock = vi.fn(() => ({ consumerEnabled: false, configured: false, isLoading: false }))
vi.mock('@shared/hooks/useLlmModels', () => ({
  useKosGate: () => kosGateMock()
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

function renderTab(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <IntegrationsTab />
    </QueryClientProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useEnvStore.setState({ state: { status: 'idle' } })
})

describe('IntegrationsTab — Web 搜索 Section 已迁出（R4d）', () => {
  test('不再渲染「Web 搜索」Section / Tavily 字段', () => {
    setReadyEnv()
    renderTab()
    // 迁到系统能力区「联网」卡后，IntegrationsTab 不应再出现 Web 搜索 section 或 Tavily 字段。
    expect(screen.queryByText('Web 搜索')).toBeNull()
    expect(screen.queryByLabelText('Tavily API Key')).toBeNull()
  })

  test('其余集成区照常渲染（KOS section 在场，证明只删了 Web 搜索）', () => {
    setReadyEnv()
    renderTab()
    expect(screen.getByText('知识大脑 (KOS)')).toBeTruthy()
  })
})

describe('IntegrationsTab — KOS 连接检查（issue #54）', () => {
  test('「连接检查」Row 在场，点击后渲染分步 ok/fail 结果', async () => {
    kosDoctorMock.mockResolvedValue([
      { status: 'ok', check: '凭据配置', detail: 'KOS_MCP_BASE / CLIENT_ID / CLIENT_SECRET 齐全' },
      { status: 'fail', check: '服务可达 (GET /health)', detail: 'E_KOS_HEALTH: connect refused' }
    ])
    setReadyEnv()
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: '检查' }))
    expect(kosDoctorMock).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('凭据配置')).toBeTruthy()
    expect(screen.getByText(/E_KOS_HEALTH/)).toBeTruthy()
  })

  test('gate 显因：开关开但凭据未齐 → 渲染警告行', () => {
    kosGateMock.mockReturnValue({ consumerEnabled: true, configured: false, isLoading: false })
    setReadyEnv()
    renderTab()
    expect(screen.getByText(/凭据未配齐/)).toBeTruthy()
  })

  test('gate 显因：已配齐（或开关关）→ 不渲染警告行', () => {
    kosGateMock.mockReturnValue({ consumerEnabled: true, configured: true, isLoading: false })
    setReadyEnv()
    renderTab()
    expect(screen.queryByText(/凭据未配齐/)).toBeNull()
  })
})
