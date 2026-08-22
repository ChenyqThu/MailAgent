// 通知 deep-link 解析器的行为测试（task 08-20-notification-center 步骤 7）。
//
// 为什么值得测：`payload` 是后端自由结构化载荷，解析器是它到路由跳转之间**唯一**的守门人。
// 松了 → 一条畸形/未来版本的 link 让条目点下去乱跳或抛异常；紧了 → 真实信源发的 link 点不
// 动。两侧都只在人工点击时才暴露，故这里对着 M1 三个信源真会发的形状逐条钉住。

import { describe, expect, it } from 'vitest'

import { resolveNotificationLink } from '@shared/components/notifications/navigation'

describe('resolveNotificationLink — 真实信源形状', () => {
  it('agent run 终态：session 型（run_worker.py 有 session_id 时）', () => {
    expect(resolveNotificationLink({ link: { type: 'session', sessionId: 42 } })).toEqual({
      type: 'session',
      sessionId: 42
    })
  })

  it('agent run 终态：无会话时的 route 退化型，search 原样带出', () => {
    expect(
      resolveNotificationLink({ link: { type: 'route', to: '/agents', search: { tab: 'agents' } } })
    ).toEqual({ type: 'route', to: '/agents', search: { tab: 'agents' } })
  })

  it('job / 告警 / watchdog：/admin/kanban，无 search', () => {
    expect(resolveNotificationLink({ link: { type: 'route', to: '/admin/kanban' } })).toEqual({
      type: 'route',
      to: '/admin/kanban',
      search: null
    })
  })
})

describe('resolveNotificationLink — 拒绝的形状（一律 null = 只标已读不跳转）', () => {
  it.each([
    ['payload 为 null', null],
    ['payload 为 undefined', undefined],
    ['没有 link 字段', { other: 1 }],
    ['link 不是对象', { link: 'session' }],
    ['link 是数组', { link: ['session'] }],
    ['未知 link 型（前向兼容：老前端遇新型不炸）', { link: { type: 'report', reportId: 7 } }],
    ['session 缺 sessionId', { link: { type: 'session' } }],
    ['sessionId 是字符串', { link: { type: 'session', sessionId: '42' } }],
    ['sessionId 为 0（后端拿不到会话时的哨兵）', { link: { type: 'session', sessionId: 0 } }],
    ['sessionId 为负', { link: { type: 'session', sessionId: -1 } }],
    ['sessionId 非整数', { link: { type: 'session', sessionId: 1.5 } }],
    ['route 缺 to', { link: { type: 'route' } }],
    ['route 目标不在白名单', { link: { type: 'route', to: '/settings' } }],
    ['route 目标是外链', { link: { type: 'route', to: 'https://example.test' } }]
  ])('%s → null', (_label, payload) => {
    expect(resolveNotificationLink(payload as Record<string, unknown> | null)).toBeNull()
  })

  it('route 的 search 不是对象时降级为 null，不整条丢弃', () => {
    expect(
      resolveNotificationLink({ link: { type: 'route', to: '/agents', search: 'tab' } })
    ).toEqual({ type: 'route', to: '/agents', search: null })
  })
})
