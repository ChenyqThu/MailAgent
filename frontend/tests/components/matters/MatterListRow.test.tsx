// @vitest-environment happy-dom
//
// G-04 清单行信息密度：设计 `list.jsx::MatterRow` 的三行结构。这道测试盯的是**信息在不在**
// （状态 / 优先级 / 编号 / 下一步 / 到期 / 更新时间 / 头像组 / 待审阅 / 关注信号 / 标签），
// 不盯像素 —— 改动前这一行只有健康色点 + 标题 + 优先级 + 下一步 + 标签 + 编号。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { Matter, MatterAttentionSignal, MatterUpdateSummary } from '@shared/api/types/matter'
import i18n from '@shared/i18n'
import { DEFAULT_MATTER_LIST_QUERY } from '@shared/components/matters/matterListQuery'

const { MatterList } = await import('@shared/components/matters/MatterList')

await i18n.changeLanguage('zh-CN')

const NOW = new Date(2026, 7, 12, 10, 0).getTime()
const DAY = 86_400_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('MatterList row', () => {
  test('renders the three-row density: identity, next step + people, signals + type', () => {
    renderList(
      matter({
        due_at: NOW + 2 * DAY,
        updated_at: NOW - 3 * 60 * 60 * 1000,
        matter_type: '客户交付',
        items: [
          {
            id: 1,
            kind: 'action',
            title: '给客户回签署版本',
            status: 'open',
            deleted_at: null
          } as never
        ],
        stakeholder_summary: [
          { display_name: '张三', email_normalized: 'z@example.com', is_waiting_on: true },
          { display_name: '李四', email_normalized: 'l@example.com', is_waiting_on: false }
        ],
        stakeholder_count: 5
      }),
      {
        signals: [{ id: 7, kind: 'deadline_near', state: 'open', severity: 'warn' }],
        pending: [update(1)]
      }
    )

    // 行 1 —— 身份与状态
    expect(screen.getByText('Vendor launch')).toBeTruthy()
    expect(screen.getByText('MAT-0042')).toBeTruthy()
    expect(screen.getByText('P1')).toBeTruthy()
    expect(screen.getByText('进行中')).toBeTruthy()
    expect(screen.getByText('待审阅')).toBeTruthy()

    // 行 2 —— 下一步（走 i18n 键，不是硬编码串）、到期、更新时间、头像组
    expect(screen.getByText('给客户回签署版本')).toBeTruthy()
    expect(screen.getByText(/到期$/)).toBeTruthy()
    expect(screen.getByTitle('张三')).toBeTruthy()
    expect(screen.getByText('+3')).toBeTruthy()

    // 行 3 —— 关注信号 + 事项类型（E16 dogfood 轮 2：标签列表换成单一类型徽标）
    expect(screen.getByText('临近截止')).toBeTruthy()
    expect(screen.getByText('客户交付')).toBeTruthy()
  })

  test('falls back to the localized missing-next-step copy and omits the avatar stack', () => {
    renderList(matter({ items: [], stakeholder_summary: [], stakeholder_count: 0 }))

    expect(screen.getByText(/缺少下一步/)).toBeTruthy()
    expect(screen.queryByText(/^\+/)).toBeNull()
  })

  test('search placeholder and empty state follow the current scope', () => {
    renderList(matter(), { scope: 'archived', matters: [] })

    expect(screen.getByPlaceholderText('在已归档中搜索…')).toBeTruthy()
    expect(screen.getByText('归档区为空')).toBeTruthy()
  })
})

// task 08-14 —— 默认范围改 all 后，筛选条 chip 的显隐基线要跟着从 'open' 换成 'all'，
// 否则默认态会常驻一枚多余的「范围」chip，且点「移除」会把范围退回已废弃的默认值 'open'
// （PRD 改动清单第五条：MatterList.tsx 三处硬编码 `scope !== 'open'`）。
describe('scope chip baseline follows the default scope (task 08-14)', () => {
  test('默认 all 范围下不出现范围 chip', () => {
    renderList(matter())
    expect(screen.queryByTitle('移除该筛选')).toBeNull()
  })

  test('切到非 all 的范围出现 chip，点击移除复位到 all（不是旧默认值 open）', () => {
    const onQueryChange = vi.fn()
    render(
      <MatterList
        matters={[matter()]}
        query={{ ...DEFAULT_MATTER_LIST_QUERY, scope: 'done' }}
        onQueryChange={onQueryChange}
        scopeTotal={1}
        tags={[]}
        selectedId={null}
        search=""
        onSearchChange={vi.fn()}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onManageTags={vi.fn()}
      />
    )

    const chip = screen.getByRole('button', { name: '已完成' })
    fireEvent.click(chip)
    expect(onQueryChange).toHaveBeenCalledWith(expect.objectContaining({ scope: 'all' }))
  })
})

function renderList(
  value: Matter,
  options: {
    signals?: MatterAttentionSignal[]
    pending?: MatterUpdateSummary[]
    scope?: 'open' | 'archived'
    matters?: Matter[]
  } = {}
): ReturnType<typeof render> {
  const matters = options.matters ?? [value]
  return render(
    <MatterList
      matters={matters}
      // 不传 scope 时走查询模型自己的默认值（task 08-14 起是 'all'），不要在这里另手抄一份
      // 「默认 scope」的假设 —— 之前手抄的 'open' 与真实默认值分道扬镳后，默认态多出一枚
      // 「范围」筛选 chip，把这条本来测「三行密度」的用例带崩（与 scope 无关的假红）。
      query={{
        ...DEFAULT_MATTER_LIST_QUERY,
        scope: options.scope ?? DEFAULT_MATTER_LIST_QUERY.scope
      }}
      onQueryChange={vi.fn()}
      scopeTotal={matters.length}
      tags={[]}
      selectedId={null}
      attention={new Map(options.signals ? [[value.public_id, options.signals]] : [])}
      updates={new Map(options.pending ? [[value.public_id, options.pending]] : [])}
      search=""
      onSearchChange={vi.fn()}
      onSelect={vi.fn()}
      onCreate={vi.fn()}
      onManageTags={vi.fn()}
    />
  )
}

function update(id: number): MatterUpdateSummary {
  return {
    id,
    review_status: 'pending',
    summary: null,
    created_at: NOW,
    change_count: 2,
    is_stale: false,
    agent_run_id: 9,
    confidence: null,
    anchored_matter_version: 3,
    created_by_kind: 'agent'
  }
}

function matter(overrides: Partial<Matter> = {}): Matter {
  return {
    id: 42,
    public_id: 'MAT-0042',
    title: 'Vendor launch',
    description: '',
    matter_type: null,
    tags: [],
    status: 'active',
    health: 'on_track',
    priority: 'p1',
    owner_id: null,
    source: 'desktop_ui',
    due_at: null,
    waiting_context: null,
    next_attention_at: null,
    attention_reason: null,
    last_activity_at: null,
    latest_accepted_update_id: null,
    current_summary: null,
    summary_at: null,
    summary_by_kind: null,
    summary_by_id: null,
    version: 3,
    archived_at: null,
    archived_by_kind: null,
    archived_by_id: null,
    deleted_at: null,
    deleted_by_kind: null,
    deleted_by_id: null,
    purge_after: null,
    created_at: NOW - 30 * DAY,
    updated_at: NOW - DAY,
    ...overrides
  }
}
