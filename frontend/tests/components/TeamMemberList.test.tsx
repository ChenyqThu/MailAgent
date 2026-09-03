// @vitest-environment happy-dom
//
// task 09-02 misc08 — 团队页内置/自定义分组可折叠 + localStorage 记忆
// （`mailagent.team.groupsCollapsed`，先例 `group-collapse.ts` 的 EmailList 日期分组）。
//
// 变异验证目标：把 `TeamMemberList.tsx` 的 `group()` 改回裸 `<div>` 标题（去掉
// button/aria-expanded/CollapsibleRegion），下面「toggle 持久化」与「折叠不丢选中」
// 两条用例必红。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import i18n from '@shared/i18n'
import { TeamMemberList } from '@shared/components/agents/team/TeamMemberList'
import { mainMember, type TeamMember } from '@shared/components/agents/team/teamMembers'
import { memberRefKey } from '@shared/components/agents/shared'
import { useTeamGroupCollapse } from '@shared/state/team-group-collapse'

// 同 TeamWorkspace.test.tsx 的做法：整体换掉 useMailApi，chat 上不带
// getAssistantIdentity → useAssistantIdentity 静默跳过取名（不发请求）。
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    report: { listRuns: vi.fn().mockResolvedValue({ items: [], total: 0 }) },
    chat: {}
  })
}))

await i18n.changeLanguage('zh-CN')

const CUSTOM_REF = { kind: 'agent' as const, agentId: 'agent-1' }
const CUSTOM_KEY = memberRefKey(CUSTOM_REF)

function customMember(): TeamMember {
  return {
    ref: CUSTOM_REF,
    key: CUSTOM_KEY,
    group: 'custom',
    cfg: null,
    canChat: true,
    tabs: ['record', 'settings'],
    recordSource: 'runs',
    hasLiveRunState: false
  }
}

function renderList(selectedKey: string | null): ReturnType<typeof render> {
  const client = new QueryClient()
  const members: TeamMember[] = [mainMember(), customMember()]
  return render(
    <QueryClientProvider client={client}>
      <TeamMemberList
        members={members}
        selectedKey={selectedKey}
        onSelect={vi.fn()}
        isLoading={false}
      />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  window.localStorage.clear()
  useTeamGroupCollapse.setState({ collapsed: {} })
})

afterEach(() => {
  cleanup()
})

describe('TeamMemberList group collapse (task 09-02 misc08)', () => {
  test('groups default expanded; toggling persists collapsed state to localStorage', () => {
    renderList(null)

    const builtinHeader = screen.getByRole('button', { name: /内置/ })
    expect(builtinHeader.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(builtinHeader)
    expect(builtinHeader.getAttribute('aria-expanded')).toBe('false')

    const persisted = JSON.parse(
      window.localStorage.getItem('mailagent.team.groupsCollapsed') ?? '{}'
    ) as Record<string, boolean>
    expect(persisted.builtin).toBe(true)

    // 再点一次翻回展开，且落盘同步更新（不是只在折叠方向落盘）。
    fireEvent.click(builtinHeader)
    expect(builtinHeader.getAttribute('aria-expanded')).toBe('true')
    const persisted2 = JSON.parse(
      window.localStorage.getItem('mailagent.team.groupsCollapsed') ?? '{}'
    ) as Record<string, boolean>
    expect(persisted2.builtin).toBe(false)
  })

  test('persisted collapsed state seeds initial render', () => {
    window.localStorage.setItem('mailagent.team.groupsCollapsed', JSON.stringify({ custom: true }))
    useTeamGroupCollapse.setState({ collapsed: { custom: true } })

    renderList(null)

    const customHeader = screen.getByRole('button', { name: /自定义/ })
    expect(customHeader.getAttribute('aria-expanded')).toBe('false')
  })

  test('collapsing a group keeps its selected member selected', () => {
    renderList(CUSTOM_KEY)

    const selectedRowBefore = document.querySelector(`[data-team-member="${CUSTOM_KEY}"]`)
    expect(selectedRowBefore?.className).toContain('border-[var(--hairline-strong)]')

    const customHeader = screen.getByRole('button', { name: /自定义/ })
    fireEvent.click(customHeader)
    expect(customHeader.getAttribute('aria-expanded')).toBe('false')

    // 折叠后该成员行仍在 DOM 且仍带选中态类名（CollapsibleRegion 恒挂载，只是
    // height:0 + inert —— 选中态活在父层 selectedKey，不随折叠丢失）。
    const selectedRowAfter = document.querySelector(`[data-team-member="${CUSTOM_KEY}"]`)
    expect(selectedRowAfter?.className).toContain('border-[var(--hairline-strong)]')
  })
})
