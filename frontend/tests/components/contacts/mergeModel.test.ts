// 合并预览默认值（task 08-13 WP3 · PRD §3.7 🔒）。核心场景 = 换邮箱：历史多的
// 旧记录做保留方、新地址在被并方 —— 主邮箱默认必须是新地址、且**新地址不被标曾用**
// （默认值由 last_seen 推导，与保留方无关；「来源于被并方 ⇒ 曾用」是被否决的推断）。

import { describe, expect, test } from 'vitest'

import {
  MERGE_FORMER_GAP_MS,
  defaultKeepContactId,
  defaultMergeFormer,
  defaultMergePrimary,
  mergeMatterConflicts,
  mergeMatterUnion,
  mergeVariantUnion,
  type MergeEmailCandidate,
  type MergeMatterRef
} from '@shared/components/contacts/mergeModel'

const DAY = 86400 * 1000
const NOW = 1_800_000_000_000

function email(
  address: string,
  overrides: Partial<MergeEmailCandidate> = {}
): MergeEmailCandidate {
  return { address, mail_count: 0, last_seen_at: null, former_at: null, ...overrides }
}

describe('换邮箱主场景', () => {
  // 旧记录（保留方，历史多）：alice@old 往来 40 封、最近 90 天前；
  // 被并方（新地址）：alice@new 往来 2 封、最近 1 天前。
  const emails = [
    email('alice@old.com', { mail_count: 40, last_seen_at: NOW - 90 * DAY }),
    email('alice@new.com', { mail_count: 2, last_seen_at: NOW - 1 * DAY })
  ]

  test('主邮箱默认 = last_seen 最新者（新地址，哪怕它在被并方）', () => {
    expect(defaultMergePrimary(emails)).toBe('alice@new.com')
  })

  test('曾用默认 = 旧地址（比主邮箱早 60 天以上）；新地址绝不被标', () => {
    const former = defaultMergeFormer(emails, 'alice@new.com')
    expect(former).toEqual(['alice@old.com'])
    expect(former).not.toContain('alice@new.com')
  })

  test('保留方默认 = mail_count 大者（旧记录）—— 与主邮箱默认相互独立', () => {
    const keep = defaultKeepContactId(
      { id: 1, mail_count: 40, last_seen_at: NOW - 90 * DAY },
      { id: 2, mail_count: 2, last_seen_at: NOW - 1 * DAY }
    )
    expect(keep).toBe(1)
  })

  test('owner 手动把主邮箱改回旧地址 → 新地址仍不默认标曾用（它比主邮箱新）', () => {
    expect(defaultMergeFormer(emails, 'alice@old.com')).toEqual([])
  })
})

describe('defaultMergePrimary', () => {
  test('null last_seen 视为最旧；并列时往来多者胜、再并列取地址字典序', () => {
    expect(
      defaultMergePrimary([
        email('a@x.com'),
        email('b@x.com', { last_seen_at: 100 })
      ])
    ).toBe('b@x.com')
    expect(
      defaultMergePrimary([
        email('b@x.com', { last_seen_at: 100, mail_count: 1 }),
        email('a@x.com', { last_seen_at: 100, mail_count: 5 })
      ])
    ).toBe('a@x.com')
    expect(
      defaultMergePrimary([
        email('b@x.com', { last_seen_at: 100 }),
        email('a@x.com', { last_seen_at: 100 })
      ])
    ).toBe('a@x.com')
  })

  test('空集 → null', () => {
    expect(defaultMergePrimary([])).toBeNull()
  })
})

describe('defaultMergeFormer', () => {
  test('60 天条款是「早于主邮箱 60 天以上」不是「距今 60 天」', () => {
    const primaryLast = NOW - 10 * DAY
    const justInside = email('near@x.com', { last_seen_at: primaryLast - 59 * DAY })
    const justOutside = email('far@x.com', { last_seen_at: primaryLast - 61 * DAY })
    const primary = email('p@x.com', { last_seen_at: primaryLast })
    expect(defaultMergeFormer([primary, justInside, justOutside], 'p@x.com')).toEqual([
      'far@x.com'
    ])
    expect(MERGE_FORMER_GAP_MS).toBe(60 * DAY)
  })

  test('本来就是曾用的地址默认保持勾选（不勾会让界面与落库说两样话）', () => {
    const emails = [
      email('p@x.com', { last_seen_at: NOW }),
      email('old-former@x.com', { last_seen_at: NOW - 5 * DAY, former_at: NOW - 100 * DAY })
    ]
    expect(defaultMergeFormer(emails, 'p@x.com')).toEqual(['old-former@x.com'])
  })

  test('曾用地址被选为主邮箱 → 不进曾用集（守卫会顺带恢复在用）', () => {
    const emails = [email('p@x.com', { former_at: 1, last_seen_at: NOW })]
    expect(defaultMergeFormer(emails, 'p@x.com')).toEqual([])
  })

  test('无账本（last_seen null）不凭空标曾用', () => {
    const emails = [
      email('p@x.com', { last_seen_at: NOW }),
      email('ghost@x.com')
    ]
    expect(defaultMergeFormer(emails, 'p@x.com')).toEqual([])
  })
})

describe('defaultKeepContactId', () => {
  test('mail_count 平手取 last_seen 较新者；全平取 a', () => {
    expect(
      defaultKeepContactId(
        { id: 1, mail_count: 5, last_seen_at: 100 },
        { id: 2, mail_count: 5, last_seen_at: 200 }
      )
    ).toBe(2)
    expect(
      defaultKeepContactId(
        { id: 1, mail_count: 5, last_seen_at: 100 },
        { id: 2, mail_count: 5, last_seen_at: 100 }
      )
    ).toBe(1)
  })
})

describe('matter 交集 / 并集', () => {
  const m = (id: number, title: string): MergeMatterRef => ({
    matter_id: id,
    public_id: `MAT-${id}`,
    title,
    role: null
  })

  test('连带冲突 = 两侧交集（合并后角色会重复的那些事项）', () => {
    expect(mergeMatterConflicts([m(1, 'A'), m(2, 'B')], [m(2, 'B'), m(3, 'C')])).toEqual([
      m(2, 'B')
    ])
    expect(mergeMatterConflicts([m(1, 'A')], [m(3, 'C')])).toEqual([])
  })

  test('并集按 matter_id 去重、保序', () => {
    expect(
      mergeMatterUnion([m(1, 'A'), m(2, 'B')], [m(2, 'B'), m(3, 'C')]).map((x) => x.matter_id)
    ).toEqual([1, 2, 3])
  })

  test('变体并集去重保序', () => {
    expect(mergeVariantUnion(['Alice', '爱丽丝'], ['Alice Chen', 'Alice'])).toEqual([
      'Alice',
      '爱丽丝',
      'Alice Chen'
    ])
  })
})
