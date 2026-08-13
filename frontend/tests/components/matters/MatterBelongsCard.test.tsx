// @vitest-environment happy-dom
//
// G-25 —— 邮件正文顶部归属 info 卡：两态文案按**实际订阅态**（设计 mock 恒写已订阅），
// 点击 = 打开事项并跳 /matters。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { LinkedMatterSummary } from '@shared/components/matters/matterResource'
import { useMatterNavigation } from '@shared/components/matters/navigation'

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

const { MatterBelongsCard } = await import('@shared/components/matters/MatterBelongsCard')

await i18n.changeLanguage('zh-CN')

beforeEach(() => {
  vi.clearAllMocks()
  useMatterNavigation.setState({ targetPublicId: null })
})

afterEach(cleanup)

function entry(overrides: Partial<LinkedMatterSummary> = {}): LinkedMatterSummary {
  return {
    publicId: 'MAT-0042',
    title: 'Vendor launch',
    status: 'active',
    health: 'on_track',
    priority: 'p1',
    archivedAt: null,
    links: [],
    subscription: null,
    ...overrides
  }
}

const activeSub = {
  public_id: 'MAT-0042',
  title: 'Vendor launch',
  status: 'active',
  health: 'on_track',
  priority: 'p1',
  link_id: 1,
  resource_id: 9,
  pinned: false,
  sub_state: 'active',
  archived_at: null
} as const

describe('MatterBelongsCard', () => {
  test('已订阅线程 → 「整条会话已订阅」；点击打开事项并跳 /matters', () => {
    render(<MatterBelongsCard entries={[entry({ subscription: { ...activeSub } })]} />)
    expect(screen.getByText(/这封邮件属于事项/)).toBeTruthy()
    expect(screen.getByText('Vendor launch')).toBeTruthy()
    expect(screen.getByText(/整条会话已订阅/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button'))
    expect(useMatterNavigation.getState().targetPublicId).toBe('MAT-0042')
    expect(navigate).toHaveBeenCalledWith({ to: '/matters' })
  })

  test('无订阅（仅单封关联）→ 如实说「仅关联了这封邮件」，不谎报订阅', () => {
    render(<MatterBelongsCard entries={[entry()]} />)
    expect(screen.getByText(/仅关联了这封邮件/)).toBeTruthy()
    expect(screen.queryByText(/整条会话已订阅/)).toBeNull()
  })

  test('挂在多件事上 → 首件标题 + `+N` 计数', () => {
    render(
      <MatterBelongsCard
        entries={[entry(), entry({ publicId: 'MAT-0043', title: 'Renewal pricing' })]}
      />
    )
    expect(screen.getByText('Vendor launch')).toBeTruthy()
    expect(screen.getByText('+1')).toBeTruthy()
  })
})
