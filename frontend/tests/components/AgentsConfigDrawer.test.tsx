// @vitest-environment happy-dom
//
// Bug2 回归 — 报告 Agent 配置 drawer 的调度控件：
//   • weekly  → 出现 weekday 单选（周一~周日），不出现「每月几日」
//   • monthly → 出现「每月几日」下拉（1~28 日）+ 1–28 限制 hint，不出现 weekday
//   • daily   → 两者都不出现（只时点）
// 断言用 getByRole('option') 精确匹配 <select> 选项，避免误中 aggWeekly 说明文字里
// 的「周一~周日」。注意：jsdom/happy-dom 不渲染真实 CSS 布局 —— 视觉（flexWrap /
// select 宽度）需打包后人工确认，这里只锁渲染逻辑。
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('../../src/shared/components/agents/hooks', () => ({
  useSetConfig: () => ({ save: vi.fn().mockResolvedValue({}), isSaving: false }),
  useKosAvailable: () => false,
  useReportConfig: () => ({ agents: [], isLoading: false }),
  useReportList: () => ({ reports: [], isLoading: false }),
  useRunNow: () => ({ run: vi.fn(), isRunning: false })
}))

// useExitAnimation 强制 shouldRender=true：覆盖「退场动画播放中、父组件已把 cfg 置 null」
// 这一真实渲染路径（regression: 此时若 header 读 cfg.title 会空指针崩）。open=true 的
// 既有用例同样 shouldRender=true，不受影响。
vi.mock('@shared/hooks/useExitAnimation', () => ({
  useExitAnimation: () => ({ shouldRender: true, scopeRef: { current: null } })
}))

import i18n from '@shared/i18n'
import { ConfigDrawer } from '../../src/shared/components/agents/AgentsTab'
import type { ReportAgentConfig } from '@shared/api/types'

await i18n.changeLanguage('zh-CN')

function makeCfg(over: Partial<ReportAgentConfig>): ReportAgentConfig {
  return {
    id: 'daily',
    type: 'daily',
    enabled: true,
    title: '日报',
    schedule: { cadence: 'daily', hours: [9] },
    window_hours: 24,
    prompt: 'x',
    prompt_is_default: true,
    model: 'claude-opus-4-8',
    kos_enrich: false,
    trigger_mode: 'rolling_24h',
    timezone: '',
    body_full_priorities: [],
    updated_at: null,
    ...over
  } as ReportAgentConfig
}

afterEach(cleanup)

describe('ConfigDrawer schedule controls (Bug2)', () => {
  test('weekly：出现 weekday 单选（周一~周日），无「每月几日」', () => {
    render(
      <ConfigDrawer
        cfg={makeCfg({
          id: 'weekly',
          type: 'weekly',
          schedule: { cadence: 'weekly', hours: [9], weekday: 2 }
        })}
        open
        onClose={() => {}}
      />
    )
    expect(screen.getByRole('option', { name: '周一' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '周三' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '周日' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: '1 日' })).toBeNull()
  })

  test('monthly：出现每月几日下拉（1~28 日）+ hint，无 weekday', () => {
    render(
      <ConfigDrawer
        cfg={makeCfg({
          id: 'monthly',
          type: 'monthly',
          schedule: { cadence: 'monthly', hours: [9], day_of_month: 15 }
        })}
        open
        onClose={() => {}}
      />
    )
    expect(screen.getByRole('option', { name: '1 日' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '15 日' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '28 日' })).toBeTruthy()
    expect(screen.getByText(/每月都能触发/)).toBeTruthy()
    expect(screen.queryByRole('option', { name: '周一' })).toBeNull()
  })

  test('daily：weekday / 每月几日 均不出现', () => {
    render(<ConfigDrawer cfg={makeCfg({})} open onClose={() => {}} />)
    expect(screen.queryByRole('option', { name: '周一' })).toBeNull()
    expect(screen.queryByRole('option', { name: '1 日' })).toBeNull()
  })

  test('退场期 cfg=null 不崩（regression：header title 改用 state，不读 cfg.title）', () => {
    // shouldRender 被 mock 成恒 true，模拟退场动画播放中、父组件已把 cfg 置 null。
    // 修复前 header 读 cfg.title → null.title 空指针崩；修复后读 title state（中性默认）→ 安全。
    expect(() => render(<ConfigDrawer cfg={null} open={false} onClose={() => {}} />)).not.toThrow()
  })
})
