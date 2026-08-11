// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

import i18n from '@shared/i18n'
import { LabsTab } from '../../src/shared/components/settings/tabs/LabsTab'
import { useEnvStore } from '@shared/state/env'

await i18n.changeLanguage('zh-CN')

function renderTab(overrides: Record<string, string> = {}): void {
  useEnvStore.setState({
    state: {
      status: 'ready',
      snapshot: {
        path: '/tmp/.env',
        exists: true,
        values: {
          MAILAGENT_MCP_CONNECTORS: 'true',
          MAILAGENT_SKILL_CATALOG_PROMPT: 'false',
          MAILAGENT_MEMORY_LAYERS: 'false',
          MAILAGENT_AG_UI_MIRROR: 'false',
          MAILAGENT_MATTERS_ENABLED: 'false',
          MAILAGENT_MATTER_AGENT_ENABLED: 'false',
          ...overrides
        },
        managedKeys: [
          'MAILAGENT_MCP_CONNECTORS',
          'MAILAGENT_SKILL_CATALOG_PROMPT',
          'MAILAGENT_MEMORY_LAYERS',
          'MAILAGENT_AG_UI_MIRROR',
          'MAILAGENT_MATTERS_ENABLED',
          'MAILAGENT_MATTER_AGENT_ENABLED'
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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useEnvStore.setState({ state: { status: 'idle' } })
})

function switchFor(envKey: string): HTMLElement {
  return screen.getByRole('switch', { name: envKey })
}

describe('LabsTab', () => {
  test('渲染 warn 条、六个实验开关与页尾高级折叠区', () => {
    renderTab()

    expect(screen.getByText(/实验性功能可能不稳定/)).toBeTruthy()
    expect(screen.getByText('等待重启生效')).toBeTruthy()
    expect(screen.getByText('外部服务连接器')).toBeTruthy()
    expect(screen.getByText('技能目录提示')).toBeTruthy()
    expect(screen.getByText('五层记忆整理')).toBeTruthy()
    expect(screen.getByText('AG-UI 协议镜像')).toBeTruthy()
    expect(screen.getByText('事项')).toBeTruthy()

    expect(screen.getAllByRole('switch')).toHaveLength(6)
    const disclosure = screen.getByRole('button', { name: /高级实验/ })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(disclosure)
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('switch')).toHaveLength(6)
  })

  // 跟进 Agent 依赖「事项」：两者的后端 gate 是 AND，所以关着事项时它开了也毫无作用。
  test('事项关闭时跟进 Agent 开关不可点，开启后才放开', () => {
    renderTab()
    expect(switchFor('MAILAGENT_MATTER_AGENT_ENABLED').getAttribute('disabled')).not.toBeNull()

    cleanup()
    renderTab({ MAILAGENT_MATTERS_ENABLED: 'true' })
    expect(switchFor('MAILAGENT_MATTERS_ENABLED').getAttribute('aria-checked')).toBe('true')
    expect(switchFor('MAILAGENT_MATTER_AGENT_ENABLED').getAttribute('disabled')).toBeNull()
  })
})
