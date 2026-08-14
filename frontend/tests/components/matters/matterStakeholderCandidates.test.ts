// 通讯录 WP3 —— S3 单页 picker 的纯判据：taken 置灰（人级 contact_id 判据 +
// 老行 email 兜底）/ onlyPeople 过滤（hidden / 自己的地址恒不出现）/ 库外邮箱
// 可建入条件。原三池组装（deriveStakeholderCandidates 等）已随改版退役。

import { describe, expect, test } from 'vitest'

import type { ContactRowDto } from '@shared/api/types/contact'
import type { MatterStakeholder } from '@shared/api/types/matter'
import {
  MATTER_STAKEHOLDER_EMAIL_RE,
  buildStakeholderTakenIndex,
  filterPickerRows,
  isPickerRowTaken,
  pickerManualEmail
} from '@shared/components/matters/matterStakeholderCandidates'

function row(overrides: Partial<ContactRowDto> & { id: number }): ContactRowDto {
  return {
    display_name: null,
    name_en: null,
    organization: null,
    department: null,
    role_title: null,
    function: null,
    seniority: null,
    kind: 'person',
    hidden_at: null,
    is_self: false,
    mail_count: 0,
    sent_to_count: 0,
    first_seen_at: null,
    last_seen_at: null,
    email_count: 1,
    primary_email: null,
    profile_summary: null,
    ...overrides
  }
}

function stakeholder(
  overrides: Partial<MatterStakeholder> & { id: number }
): MatterStakeholder {
  return {
    email_normalized: null,
    contact_id: null,
    deleted_at: null,
    ...overrides
  } as unknown as MatterStakeholder
}

describe('buildStakeholderTakenIndex / isPickerRowTaken', () => {
  test('contact_id 是人级判据：任一邮箱（含曾用）加过的人整个置灰', () => {
    const index = buildStakeholderTakenIndex([
      // 经曾用邮箱加入 —— email_normalized 是旧地址，但 contact_id 归一到同一个人
      stakeholder({ id: 1, contact_id: 7, email_normalized: 'alice@old.com' })
    ])
    const alice = row({ id: 7, primary_email: 'alice@new.com' })
    expect(isPickerRowTaken(alice, index)).toBe(true)
    expect(isPickerRowTaken(row({ id: 8, primary_email: 'bob@y.com' }), index)).toBe(false)
  })

  test('contact_id 为 null 的老行退化到 email 兜底（主邮箱判等，大小写不敏感）', () => {
    const index = buildStakeholderTakenIndex([
      stakeholder({ id: 1, contact_id: null, email_normalized: 'legacy@x.com' })
    ])
    expect(isPickerRowTaken(row({ id: 9, primary_email: 'Legacy@X.com' }), index)).toBe(true)
    expect(isPickerRowTaken(row({ id: 9, primary_email: 'other@x.com' }), index)).toBe(false)
  })

  test('软删的干系人行不算「已在事项中」', () => {
    const index = buildStakeholderTakenIndex([
      stakeholder({ id: 1, contact_id: 7, deleted_at: 123 })
    ])
    expect(index.contactIds.size).toBe(0)
  })
})

describe('filterPickerRows', () => {
  const pool = [
    row({ id: 1, kind: 'person', primary_email: 'a@x.com' }),
    row({ id: 2, kind: 'robot', primary_email: 'noreply@x.com' }),
    row({ id: 3, kind: 'list', primary_email: 'all@x.com' }),
    row({ id: 4, kind: 'person', primary_email: 'me@x.com', is_self: true }),
    row({ id: 5, kind: 'person', primary_email: 'hidden@x.com', hidden_at: 9 })
  ]

  test('onlyPeople（默认）只留 kind=person；hidden / 自己的地址恒不出现', () => {
    expect(filterPickerRows(pool, { onlyPeople: true }).map((r) => r.id)).toEqual([1])
  })

  test('「也显示邮件组 / 机器人」放进 robot/list，但 hidden / self 仍不出现', () => {
    expect(filterPickerRows(pool, { onlyPeople: false }).map((r) => r.id)).toEqual([1, 2, 3])
  })
})

describe('pickerManualEmail', () => {
  const pool = [row({ id: 1, primary_email: 'alice@x.com' })]

  test('输入库外邮箱 → 归一地址（虚线「以这个邮箱新建」行出现）', () => {
    expect(pickerManualEmail('  New.Person@X.com ', pool)).toBe('new.person@x.com')
  })

  test('与返回行主邮箱同址 → 不出现（那个人就在列表里）', () => {
    expect(pickerManualEmail('Alice@X.com', pool)).toBeNull()
  })

  test('不是邮箱形状 → 不出现', () => {
    expect(pickerManualEmail('alice', pool)).toBeNull()
    expect(pickerManualEmail('a@b', pool)).toBeNull()
    expect(MATTER_STAKEHOLDER_EMAIL_RE.test('a@b.com')).toBe(true)
  })
})
