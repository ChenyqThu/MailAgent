// Phase 4·#4 — attendees update 决策纯逻辑单测 (node 环境). 数据安全: 防 update
// 静默清空 Exchange 与会者 + 编辑事件 partstat 退化.

import { describe, expect, test } from 'vitest'

import { resolveAttendeesUpdate } from '../../src/shared/components/calendar/lib/attendees'

describe('resolveAttendeesUpdate (Phase 4·#4 attendees 三态)', () => {
  test('未 dirty → 空对象 (不传 attendees → 后端保留原与会者)', () => {
    expect(resolveAttendeesUpdate(false, [])).toEqual({})
  })

  test('未 dirty 即使有 chips → 仍空 (防 partstat 退化: 没碰就不回传)', () => {
    expect(
      resolveAttendeesUpdate(false, [{ email: 'a@x.com', name: 'Alice' }])
    ).toEqual({})
  })

  test('dirty + 非空 chips → { attendees } 替换', () => {
    const chips = [{ email: 'a@x.com', name: 'Alice' }, { email: 'b@x.com' }]
    expect(resolveAttendeesUpdate(true, chips)).toEqual({ attendees: chips })
  })

  test('dirty + 删光 (空 chips) → { clearAttendees: true } 显式清空', () => {
    expect(resolveAttendeesUpdate(true, [])).toEqual({ clearAttendees: true })
  })

  test('未 dirty 绝不返回 clearAttendees / attendees (数据安全, 绝不误清空)', () => {
    const r = resolveAttendeesUpdate(false, [])
    expect(r.clearAttendees).toBeUndefined()
    expect(r.attendees).toBeUndefined()
  })
})
