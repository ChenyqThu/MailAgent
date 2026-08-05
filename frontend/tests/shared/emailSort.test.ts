// @vitest-environment happy-dom
//
// 排序词表单源（@shared/lib/emailSort）+ 主进程 DAO 的 ORDER BY 白名单。
//
// happy-dom：`ALL_PRIORITIES` 来自 email-filter，其 zustand store 在 module init
// 读 localStorage（node env 没有稳定的 localStorage 全局）。

import { describe, expect, test } from 'vitest'

import {
  buildEnrichedOrderBy,
  DEFAULT_SORT_DIR,
  DEFAULT_SORT_KEY,
  EMAIL_SORT_DIRS,
  EMAIL_SORT_KEYS,
  normalizeSortDir,
  normalizeSortKey,
  PRIORITY_RANK,
  PRIORITY_RANK_UNKNOWN,
  priorityRank
} from '@shared/lib/emailSort'
import { ALL_PRIORITIES } from '@shared/state/email-filter'

describe('emailSort 词表', () => {
  test('默认 = 历史行为 date DESC', () => {
    expect(DEFAULT_SORT_KEY).toBe('date')
    expect(DEFAULT_SORT_DIR).toBe('desc')
  })

  test('normalize* 把词表外的任何输入按回默认（不抛、不透传）', () => {
    for (const k of EMAIL_SORT_KEYS) expect(normalizeSortKey(k)).toBe(k)
    for (const d of EMAIL_SORT_DIRS) expect(normalizeSortDir(d)).toBe(d)
    for (const bad of ['size', 'DATE', '', null, undefined, 1, {}]) {
      expect(normalizeSortKey(bad)).toBe(DEFAULT_SORT_KEY)
      expect(normalizeSortDir(bad)).toBe(DEFAULT_SORT_DIR)
    }
  })

  test('🔴 PRIORITY_RANK 的键集 == AIPriority 全集（它是零依赖叶子，编译期管不到）', () => {
    expect(Object.keys(PRIORITY_RANK).sort()).toEqual([...ALL_PRIORITIES].sort())
  })

  test('名次单调：critical 最高、low 最低、未分类 0', () => {
    const ranks = ALL_PRIORITIES.map((p) => priorityRank(p))
    // ALL_PRIORITIES 本身就是 critical→low 的降序枚举。
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a))
    expect(priorityRank(null)).toBe(PRIORITY_RANK_UNKNOWN)
    expect(priorityRank('沒這個檔')).toBe(PRIORITY_RANK_UNKNOWN)
  })
})

describe('buildEnrichedOrderBy — SQL 白名单', () => {
  test('每个排序键都恒带 internal_id 作稳定第二键', () => {
    for (const k of EMAIL_SORT_KEYS) {
      for (const d of EMAIL_SORT_DIRS) {
        expect(buildEnrichedOrderBy(k, d)).toContain('m.internal_id')
      }
    }
  })

  test('date 的两个方向 = 旧行为的 DESC + 对称的 ASC，NULL 恒最末', () => {
    expect(buildEnrichedOrderBy('date', 'desc')).toBe(
      'm.date_received DESC NULLS LAST, m.internal_id DESC'
    )
    expect(buildEnrichedOrderBy('date', 'asc')).toBe(
      'm.date_received ASC NULLS LAST, m.internal_id ASC'
    )
  })

  test('缺省参数 = date DESC（调用方不传时逐字节维持历史 ORDER BY）', () => {
    expect(buildEnrichedOrderBy()).toBe('m.date_received DESC NULLS LAST, m.internal_id DESC')
  })

  test('sender 走 COALESCE(NULLIF(sender_name), sender) + COLLATE NOCASE', () => {
    const sql = buildEnrichedOrderBy('sender', 'asc')
    expect(sql).toContain("COALESCE(NULLIF(m.sender_name, ''), m.sender) COLLATE NOCASE ASC")
  })

  test('subject 走 COLLATE NOCASE', () => {
    expect(buildEnrichedOrderBy('subject', 'desc')).toContain('m.subject COLLATE NOCASE DESC')
  })

  test('🔴 importance 的首列是与方向无关的 null-guard（未分类恒沉底）', () => {
    for (const d of EMAIL_SORT_DIRS) {
      const sql = buildEnrichedOrderBy('importance', d)
      expect(sql.startsWith(`(CASE WHEN (`)).toBe(true)
      // guard 列恒 ASC —— 若它跟着方向翻，「由低到高」会把没跑过 AI 的邮件顶到最前。
      expect(sql).toContain(`THEN 1 ELSE 0 END) ASC,`)
    }
  })

  test('🔴 非法输入不进 SQL —— 按回默认，绝不拼接', () => {
    // @ts-expect-error 故意传词表外的值，模拟未来某处漏了 normalize。
    expect(buildEnrichedOrderBy('size; DROP TABLE email_metadata', 'desc')).toBe(
      'm.date_received DESC NULLS LAST, m.internal_id DESC'
    )
    // @ts-expect-error 同上（方向）。
    expect(buildEnrichedOrderBy('date', 'ASC; DELETE FROM email_metadata')).toBe(
      'm.date_received DESC NULLS LAST, m.internal_id DESC'
    )
  })

  test('{dir} 占位符全部被替换掉（漏一个就是 SQL 语法错）', () => {
    for (const k of EMAIL_SORT_KEYS) {
      for (const d of EMAIL_SORT_DIRS) {
        expect(buildEnrichedOrderBy(k, d)).not.toContain('{dir}')
      }
    }
  })
})
