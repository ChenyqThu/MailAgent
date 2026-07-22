// @vitest-environment happy-dom
//
// codex MEDIUM-2 (part 1) — the /agents 「报告」tab badge shows the FULL report count (hook.total),
// not the loaded first page (items.length). A 52-report库 whose first page holds 50 rows must badge
// "52", never "50". The child tabs are stubbed to isolate the AgentsPage tab bar.
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useSearch: () => ({}) // default → 'agents' tab active; the reports TabButton still renders its badge
}))
vi.mock('../../src/shared/components/agents/AgentsTab', () => ({ AgentsTab: () => null }))
vi.mock('../../src/shared/components/agents/ReportsTab', () => ({ ReportsTab: () => null }))
vi.mock('../../src/shared/components/agents/ChatsTab', () => ({ ChatsTab: () => null }))

// The badge reads useReportList().total — pin items (first page, 50) ≠ total (52).
vi.mock('../../src/shared/components/agents/hooks', () => ({
  useReportList: () => ({
    items: new Array(50).fill({}),
    total: 52,
    isLoading: false,
    hasMore: true,
    isFetchingMore: false,
    fetchMore: vi.fn()
  })
}))

import i18n from '@shared/i18n'
import { AgentsPage } from '../../src/shared/components/agents/AgentsPage'

await i18n.changeLanguage('zh-CN')

afterEach(() => cleanup())

describe('AgentsPage — reports tab badge (codex MEDIUM-2)', () => {
  test('badge shows the full total (52), not the first-page length (50)', () => {
    render(<AgentsPage />)
    expect(screen.getByText('52')).toBeTruthy()
    expect(screen.queryByText('50')).toBeNull()
  })
})
