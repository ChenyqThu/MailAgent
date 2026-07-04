// @vitest-environment happy-dom
//
// S6 W2（P5 红点链）— TitleBar 全局待审批徽标 + per-agent 计数徽标。
//   - flag off（customAgentsEnabled=false）→ TitleBar 徽标不渲染，且 useAgentPendingCount 以 enabled=false
//     调用（→ hook 内不轮询）。
//   - flag on + total>0 → 徽标计数；点击弹 popover 列 pending run；行点击 → requestOpenAgentSession + 导航。
//   - AgentPendingCountBadge：count<=0 不渲染；count>0 渲染「待审批 N」（i18n key 存在）。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { AgentRunHistoryItem, AgentRunPendingCount, ReportAgentConfig } from '@shared/api/types'

const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate
}))

const mockRequestOpen = vi.fn()
vi.mock('@shared/state/ai-chat-panel', () => ({
  requestOpenAgentSession: (id: number) => mockRequestOpen(id)
}))

const mockCustomEnabled = vi.fn<() => boolean>()
const mockPendingCount = vi.fn<(enabled: boolean) => AgentRunPendingCount>()
const mockPendingRuns = vi.fn<(enabled: boolean) => { runs: AgentRunHistoryItem[]; isLoading: boolean }>()
const mockReportConfig = vi.fn<() => { agents: ReportAgentConfig[]; isLoading: boolean }>()
vi.mock('@shared/components/agents/hooks', () => ({
  useCustomAgentsEnabled: () => mockCustomEnabled(),
  useAgentPendingCount: (enabled: boolean) => mockPendingCount(enabled),
  usePendingRuns: (enabled: boolean) => mockPendingRuns(enabled),
  useReportConfig: () => mockReportConfig()
}))

import i18n from '@shared/i18n'
import {
  AgentPendingCountBadge,
  TitleBarAgentPendingBadge
} from '@shared/components/agents/AgentPendingBadge'

await i18n.changeLanguage('zh-CN')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function pendingRun(over: Partial<AgentRunHistoryItem> = {}): AgentRunHistoryItem {
  return {
    jobId: 7,
    agentId: 'dms',
    state: 'paused_pending',
    sessionId: 55,
    createdAt: Date.now() - 3 * 60 * 1000,
    ...over
  }
}

describe('TitleBarAgentPendingBadge — flag gating', () => {
  test('customAgentsEnabled=false → renders nothing AND calls the count hook with enabled=false (no poll)', () => {
    mockCustomEnabled.mockReturnValue(false)
    mockPendingCount.mockReturnValue({ total: 0, byAgent: {} })
    mockPendingRuns.mockReturnValue({ runs: [], isLoading: false })
    mockReportConfig.mockReturnValue({ agents: [], isLoading: false })
    render(<TitleBarAgentPendingBadge />)
    expect(screen.queryByRole('button')).toBeNull()
    // 红线：flag off → hook 收到 enabled=false → 不轮询
    expect(mockPendingCount).toHaveBeenCalledWith(false)
  })

  test('flag on but total=0 → renders nothing', () => {
    mockCustomEnabled.mockReturnValue(true)
    mockPendingCount.mockReturnValue({ total: 0, byAgent: {} })
    mockPendingRuns.mockReturnValue({ runs: [], isLoading: false })
    mockReportConfig.mockReturnValue({ agents: [], isLoading: false })
    render(<TitleBarAgentPendingBadge />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('TitleBarAgentPendingBadge — flag on with pending', () => {
  test('renders count; opens popover; a row opens that run record', async () => {
    mockCustomEnabled.mockReturnValue(true)
    mockPendingCount.mockReturnValue({ total: 2, byAgent: { dms: 2 } })
    mockPendingRuns.mockReturnValue({ runs: [pendingRun()], isLoading: false })
    mockReportConfig.mockReturnValue({
      agents: [{ id: 'dms', title: '每日摘要' } as ReportAgentConfig],
      isLoading: false
    })
    render(<TitleBarAgentPendingBadge />)

    const trigger = await screen.findByRole('button', { name: /agent 执行待审批/ })
    expect(trigger.textContent).toContain('2')

    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog')
    // 名字映射自 report config
    expect(screen.getByText('每日摘要')).toBeTruthy()

    // 行点击 → 打开该 run 记录（park sessionId + 导航 /sessions）
    fireEvent.click(screen.getByText('每日摘要'))
    expect(mockRequestOpen).toHaveBeenCalledWith(55)
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/sessions' })
    // dialog reference kept live for the assertion above
    expect(dialog).toBeTruthy()
  })
})

describe('AgentPendingCountBadge', () => {
  test('count<=0 → renders nothing', () => {
    const { container } = render(<AgentPendingCountBadge count={0} />)
    expect(container.firstChild).toBeNull()
  })

  test('count>0 → renders the localized 「待审批 N」 label (i18n key exists)', () => {
    render(<AgentPendingCountBadge count={3} />)
    expect(screen.getByText('待审批 3')).toBeTruthy()
  })
})
