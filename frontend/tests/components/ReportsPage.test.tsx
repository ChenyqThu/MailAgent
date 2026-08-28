// @vitest-environment happy-dom
//
// 报告页（08-27 P3：`/agents?tab=reports` → 一级域 `/reports`）。三条断言：
//
//   · 清单头的条数是**全量** total（后端 meta.total），不是已加载的首页长度 ——
//     codex MEDIUM-2 的原始关切，随 tab 徽标退役搬到这里（52 条的库、首页 50 行，
//     显示的必须是 52）。
//   · 点清单行 → `navigateToReport`（`/reports/$reportId`），不是组件内 state。
//   · URL 上的 `$reportId` 决定选中哪一份（面包屑第二段是选中项的派生值）。
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { ReportListItem } from '@shared/api/types'

const hoisted = vi.hoisted(() => ({
  navigate: vi.fn(),
  params: {} as { reportId?: string },
  narrow: false
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => hoisted.navigate,
  // `useParams({ strict:false, select })` —— mock 要把 select 也跑一遍，否则页面拿到的
  // 是整个 params 对象而不是 reportId 字符串。
  useParams: (opts?: { select?: (p: Record<string, unknown>) => unknown }) =>
    opts?.select ? opts.select(hoisted.params) : hoisted.params
}))

const ITEMS: ReportListItem[] = [
  {
    id: 'daily-2026-08-27',
    agent_id: 'daily',
    cadence: 'daily',
    report_date: '2026-08-27',
    status: 'ready',
    headline: '今天 12 封需要回',
    counts: { total: 12 }
  },
  {
    id: 'daily-2026-08-26',
    agent_id: 'daily',
    cadence: 'daily',
    report_date: '2026-08-26',
    status: 'ready',
    headline: '昨天 8 封需要回',
    counts: { total: 8 }
  }
] as unknown as ReportListItem[]

vi.mock('../../src/shared/components/agents/hooks', () => ({
  // items（首页 2 行）≠ total（52）—— 清单头显示的必须是后者。
  useReportList: () => ({
    items: ITEMS,
    total: 52,
    isLoading: false,
    hasMore: true,
    isFetchingMore: false,
    fetchMore: vi.fn()
  }),
  useReportConfig: () => ({ agents: [], isLoading: false }),
  useReport: () => ({ report: null, isLoading: false }),
  useNarrow: () => hoisted.narrow,
  useRunNow: () => ({ run: vi.fn(), isRunning: false }),
  useDeleteReport: () => ({ remove: vi.fn() })
}))

import i18n from '@shared/i18n'
import { useTabWorkspace } from '@shared/state/tab-workspace'
import { ReportsPage } from '../../src/shared/components/agents/ReportsPage'

await i18n.changeLanguage('zh-CN')

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.params = {}
  hoisted.narrow = false
  // 面包屑只在主标签落在报告承载时才写（useMainBreadcrumb 的守卫）。
  useTabWorkspace.getState().setMainPage('reports')
})

afterEach(() => cleanup())

describe('ReportsPage — 清单头计数', () => {
  test('显示全量 total（52），不是已加载的首页长度（2）', () => {
    render(<ReportsPage />)
    expect(screen.getByText('52')).toBeTruthy()
    expect(screen.queryByText('2')).toBeNull()
  })
})

describe('ReportsPage — 选中项由 URL 决定', () => {
  test('点清单行 → 落 /reports/$reportId（不是组件内 state）', () => {
    render(<ReportsPage />)
    fireEvent.click(screen.getByText('昨天 8 封需要回'))
    expect(hoisted.navigate).toHaveBeenCalledWith({
      to: '/reports/$reportId',
      params: { reportId: 'daily-2026-08-26' }
    })
  })

  test('深链带 $reportId：选中那一份（面包屑第二段跟着变）', () => {
    hoisted.params = { reportId: 'daily-2026-08-26' }
    render(<ReportsPage />)
    expect(useTabWorkspace.getState().mainBreadcrumb).toBe('日报 08/26')
  })

  test('无 $reportId / 点名的那份不在列表里：回落第一份，不弹空详情', () => {
    hoisted.params = { reportId: 'daily-1999-01-01' }
    render(<ReportsPage />)
    expect(useTabWorkspace.getState().mainBreadcrumb).toBe('日报 08/27')
  })
})

// 窄屏单栏（<780，只有 web 构件够得着）：切换判据也是 URL。原来的 `mobileDetail`
// state 在深链直接落详情路由时恒 false —— 那会停在清单上，看着像深链没生效。
describe('ReportsPage — 窄屏单栏跟着 URL 走', () => {
  test('带 $reportId 直接进来 → 显示详情（不是清单）', () => {
    hoisted.narrow = true
    hoisted.params = { reportId: 'daily-2026-08-26' }
    render(<ReportsPage />)
    expect(screen.getByText('返回列表')).toBeTruthy()
    expect(screen.queryByText('昨天 8 封需要回')).toBeNull()
  })

  test('无 $reportId → 显示清单；「返回列表」落回 /reports', () => {
    hoisted.narrow = true
    render(<ReportsPage />)
    expect(screen.queryByText('返回列表')).toBeNull()
    expect(screen.getByText('昨天 8 封需要回')).toBeTruthy()

    cleanup()
    hoisted.params = { reportId: 'daily-2026-08-26' }
    render(<ReportsPage />)
    fireEvent.click(screen.getByText('返回列表'))
    expect(hoisted.navigate).toHaveBeenCalledWith({ to: '/reports' })
  })
})
