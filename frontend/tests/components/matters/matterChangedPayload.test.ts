import { describe, expect, it } from 'vitest'

import { matterChangedPublicId } from '@shared/components/matters/hooks'

/**
 * S1 — `matter.changed` SSE 的 payload 判定。
 *
 * 事件桥收到畸形 payload 时必须**静默不刷**，而不是抛、也不是退化成全量失效：
 * 这条总线是 lossy 的，漏刷一次的代价远小于一条坏事件把全部事项缓存刷一遍。
 */
describe('matterChangedPublicId', () => {
  it('取出合法 public_id', () => {
    expect(matterChangedPublicId({ public_id: 'MAT-0012' })).toBe('MAT-0012')
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['字符串而非对象', 'MAT-0012'],
    ['数组', ['MAT-0012']],
    ['缺字段', { other: 1 }],
    ['空串', { public_id: '' }],
    ['内部数字主键（旧 matter.attention 的形状）', { public_id: 12 }],
    ['null 值', { public_id: null }]
  ])('%s → null', (_label, input) => {
    expect(matterChangedPublicId(input)).toBeNull()
  })
})
