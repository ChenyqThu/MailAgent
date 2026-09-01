// @vitest-environment happy-dom
//
// task 08-27 P5「拖出成独立窗口」形态 B —— 轻窗壳的内容分派。
//
// 验的是壳自己的三件事，两个内容组件都 mock 成哨兵（它们各有自己的测试）：
//   · 按 target.kind 分派到邮件详情 / 报告详情；
//   · 邮件分支把目标 id 灌进本进程的 active-email store（独立 renderer 是新实例）；
//   · 🔴 整个挂载过程一个字节都不落 `mailagent.tabs.v1` —— 轻窗与主窗共用同一个
//     localStorage 键且 tab-workspace 有意不挂 storage 监听，写一次就覆盖主窗的标签集。

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

const memoryStore: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: (k: string) => (k in memoryStore ? memoryStore[k] : null),
  setItem: (k: string, v: string) => {
    memoryStore[k] = v
  },
  removeItem: (k: string) => {
    delete memoryStore[k]
  },
  clear: () => {
    for (const k of Object.keys(memoryStore)) delete memoryStore[k]
  }
})

vi.mock('@shared/components/email/EmailDetail', () => ({
  EmailDetail: ({ internalId }: { internalId: number | null }): React.ReactElement => (
    <div data-testid="email-detail">{String(internalId)}</div>
  )
}))
vi.mock('@shared/components/agents/ReportsPage', () => ({
  ReportDetailView: ({ item }: { item: { id: string } }): React.ReactElement => (
    <div data-testid="report-detail">{item.id}</div>
  )
}))
vi.mock('@shared/components/agents/EmailSourcePanel', () => ({
  EmailSourcePanel: (): null => null
}))
vi.mock('@shared/components/agents/hooks', () => ({
  useReport: (reportId: string | null) => ({
    report: reportId === 'missing' ? null : { id: reportId, agent_id: 'daily', cadence: 'daily' },
    isLoading: false
  }),
  useRunNow: () => ({ run: vi.fn(), isRunning: false })
}))

const { DetachedShell } = await import('../../src/shared/components/DetachedShell')
const { useDetachedMode } = await import('../../src/shared/state/detached-mode')
const { useActiveEmail } = await import('../../src/shared/state/active-email')

beforeEach(() => {
  cleanup()
  for (const k of Object.keys(memoryStore)) delete memoryStore[k]
  useDetachedMode.setState({ isDetached: false, target: null })
  useActiveEmail.setState({ activeInternalId: null })
})

describe('DetachedShell 内容分派', () => {
  test('email 目标 → 挂邮件详情，并把 id 灌进 active-email', () => {
    useDetachedMode.setState({ isDetached: true, target: { kind: 'email', emailId: 53675 } })
    render(<DetachedShell />)
    expect(screen.getByTestId('email-detail').textContent).toBe('53675')
    expect(screen.queryByTestId('report-detail')).toBeNull()
    expect(useActiveEmail.getState().activeInternalId).toBe(53675)
  })

  test('report 目标 → 挂报告详情，item 直接来自 report.get()（不必先拉分页列表）', () => {
    useDetachedMode.setState({
      isDetached: true,
      target: { kind: 'report', reportId: 'daily-2026-08-30' }
    })
    render(<DetachedShell />)
    expect(screen.getByTestId('report-detail').textContent).toBe('daily-2026-08-30')
    expect(screen.queryByTestId('email-detail')).toBeNull()
  })

  test('报告不存在 → 空态而不是崩', () => {
    useDetachedMode.setState({ isDetached: true, target: { kind: 'report', reportId: 'missing' } })
    render(<DetachedShell />)
    expect(screen.queryByTestId('report-detail')).toBeNull()
  })

  // titleBarStyle:'hiddenInset' 下窗口内容铺满整窗：没有这条标题条，OS 红绿灯会压在
  // 下面的工具栏上。⚠️ 它的 `-webkit-app-region: drag`（窗口能不能拖）**测不到** ——
  // happy-dom 直接把这条未知属性丢掉，连 style 属性都不落，只能装机手验。
  test('顶部有给红绿灯让位的标题条（pl-[78px]）', () => {
    useDetachedMode.setState({ isDetached: true, target: { kind: 'email', emailId: 1 } })
    const { container } = render(<DetachedShell />)
    expect(container.querySelector('.pl-\\[78px\\]')).not.toBeNull()
  })

  test('挂载轻窗不写 mailagent.tabs.v1', () => {
    useDetachedMode.setState({ isDetached: true, target: { kind: 'email', emailId: 1 } })
    render(<DetachedShell />)
    expect(memoryStore['mailagent.tabs.v1']).toBeUndefined()
  })
})
