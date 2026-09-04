// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    services: {
      restart: vi.fn().mockResolvedValue({
        ok: true,
        target: 'mail-sync',
        exitCode: 0,
        stdout: '',
        stderr: ''
      })
    }
  })
}))

vi.mock('@shared/components/agents/hooks', () => ({
  useOpennessFlags: () => ({ connectorToolsEnabled: false })
}))

// g1 — owner_settings 型实验行（群聊多 agent）的 serve-api 客户端。
const mockGetLabs = vi.fn()
const mockSetLabs = vi.fn()
vi.mock('@shared/api/groupSettings', () => ({
  getLabs: (...args: unknown[]) => mockGetLabs(...args),
  setLabs: (...args: unknown[]) => mockSetLabs(...args),
  getGroupConfig: vi.fn(),
  setGroupConfig: vi.fn(),
  getGroupMetrics: vi.fn()
}))

import i18n from '@shared/i18n'
import { LabsTab } from '../../src/shared/components/settings/tabs/LabsTab'
import { useEnvStore } from '@shared/state/env'

await i18n.changeLanguage('zh-CN')

function renderTab(overrides: Record<string, string | undefined> = {}): void {
  const values: Record<string, string> = {
    MAILAGENT_MCP_CONNECTORS: 'true',
    MAILAGENT_SKILL_CATALOG_PROMPT: 'false',
    MAILAGENT_MEMORY_LAYERS: 'false',
    MAILAGENT_AG_UI_MIRROR: 'false'
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete values[key]
    else values[key] = value
  }
  useEnvStore.setState({
    state: {
      status: 'ready',
      snapshot: {
        path: '/tmp/.env',
        exists: true,
        values,
        managedKeys: [
          'MAILAGENT_MCP_CONNECTORS',
          'MAILAGENT_SKILL_CATALOG_PROMPT',
          'MAILAGENT_MEMORY_LAYERS',
          'MAILAGENT_AG_UI_MIRROR'
        ],
        secretKeys: []
      }
    }
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <LabsTab />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  mockGetLabs.mockResolvedValue({ groupAgents: 'off' })
  mockSetLabs.mockResolvedValue({ groupAgents: 'on' })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useEnvStore.setState({ state: { status: 'idle' } })
})

function switchFor(envKey: string): HTMLElement {
  return screen.getByRole('switch', { name: envKey })
}

describe('LabsTab', () => {
  test('渲染 warn 条、五个实验开关与页尾高级折叠区', () => {
    renderTab()

    expect(screen.getByText(/实验性功能可能不稳定/)).toBeTruthy()
    expect(screen.getByText('等待重启生效')).toBeTruthy()
    expect(screen.getAllByText('群聊多 agent（实验）').length).toBeGreaterThan(0)
    expect(screen.getByText('外部服务连接器')).toBeTruthy()
    expect(screen.getByText('技能目录提示')).toBeTruthy()
    expect(screen.getByText('五层记忆整理')).toBeTruthy()
    expect(screen.getByText('AG-UI 协议镜像')).toBeTruthy()
    expect(screen.queryByText('事项')).toBeNull()
    expect(screen.queryByText('通讯录')).toBeNull()
    // 四个 env 型 + 一个 owner_settings 型。
    expect(screen.getAllByRole('switch')).toHaveLength(5)
    const disclosure = screen.getByRole('button', { name: /高级实验/ })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(disclosure)
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('switch')).toHaveLength(5)
  })

  test('群聊多 agent 是 owner_settings 型：切换调 setLabs，且这一行不谈重启', async () => {
    renderTab()
    const row = screen.getByRole('switch', { name: '群聊多 agent（实验）' })
    // 读回来之前开关是禁用的（不知道当前值就不让点）；读到 off 之后才可点。
    await waitFor(() => expect((row as HTMLButtonElement).disabled).toBe(false))
    expect(row.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(row)
    await waitFor(() => expect(mockSetLabs).toHaveBeenCalledWith({ groupAgents: 'on' }))
    // 🔴 热读生效 → 这一行没有 restartHint、也没有「重启后端」按钮（那是 env 型的形态）。
    const helper = screen.getByText(/关掉就退回原来的/)
    expect(helper.textContent).toMatch(/不需要重启/)
    expect(helper.textContent).not.toMatch(/需重启|退出重开/)
    // env 型的重启按钮只属于 mcpConnectors / memoryLayers 两行，没有随新行多出来。
    expect(screen.getAllByRole('button', { name: /重启后端/ })).toHaveLength(2)
  })
})
