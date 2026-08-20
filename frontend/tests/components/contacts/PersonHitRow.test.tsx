// @vitest-environment happy-dom
//
// 通讯录 WP4 —— ⌘K「人」组行组件（镜像 MatterHitRow.test.tsx 的形状）：
// Monogram + 姓名（命中词 <mark> 高亮）+ org/primary_email 副文案 + 点击激活。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { ContactRowDto } from '@shared/api/types/contact'
import { PersonHitRow } from '@shared/components/command/PersonHitRow'

await i18n.changeLanguage('zh-CN')

afterEach(cleanup)

function row(overrides: Partial<ContactRowDto> = {}): ContactRowDto {
  return {
    id: 3,
    display_name: 'Alice Chen',
    formal_name: 'Alice',
    organization: 'ACME',
    department: null,
    role_title: null,
    function: null,
    seniority: null,
    gender: null,
    kind: 'person',
    hidden_at: null,
    is_self: false,
    mail_count: 12,
    sent_to_count: 4,
    first_seen_at: null,
    last_seen_at: null,
    email_count: 1,
    primary_email: 'alice@x.com',
    manager_contact_id: null,
    manager_display_name: null,
    profile_summary: null,
    profile_min: 50,
    profile_eligible: false,
    ...overrides
  }
}

function renderRow(contact: ContactRowDto, queryTerms: string[] = []): { onActivate: () => void } {
  const onActivate = vi.fn()
  render(
    <ul>
      <PersonHitRow
        contact={contact}
        flatIdx={5}
        selected={false}
        setHighlight={() => {}}
        queryTerms={queryTerms}
        onActivate={onActivate}
      />
    </ul>
  )
  return { onActivate }
}

describe('PersonHitRow', () => {
  test('renders name + org · primary_email secondary line', () => {
    renderRow(row())
    expect(screen.getByText('Alice Chen')).toBeTruthy()
    expect(screen.getByText('ACME · alice@x.com')).toBeTruthy()
  })

  test('highlights query terms in the name via <mark>', () => {
    renderRow(row(), ['Alice'])
    const option = screen.getByRole('option')
    expect(option.querySelector('mark')?.textContent).toBe('Alice')
  })

  test('bare-email contact: name falls back to primary_email, secondary drops the duplicate', () => {
    renderRow(row({ display_name: null, formal_name: null, organization: null }))
    // 名字位 = 主邮箱兜底；副行没有内容时不再重复画同一个地址。
    expect(screen.getByText('alice@x.com')).toBeTruthy()
    expect(screen.queryByText('ACME · alice@x.com')).toBeNull()
  })

  test('click activates the row', () => {
    const { onActivate } = renderRow(row())
    fireEvent.click(screen.getByRole('option'))
    expect(onActivate).toHaveBeenCalledTimes(1)
  })
})
