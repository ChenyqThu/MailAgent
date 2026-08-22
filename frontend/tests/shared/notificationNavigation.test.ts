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

  it('KOS dead：/settings 带 integrations tab（ingest_log.py 的真实 link 形状）', () => {
    expect(
      resolveNotificationLink({
        link: { type: 'route', to: '/settings', search: { tab: 'integrations' } }
      })
    ).toEqual({ type: 'route', to: '/settings', search: { tab: 'integrations' } })
  })

  // M2 批 B5 的四型（design §6.4 表）——每一型都对应一个真实落地动作，解析错了就是
  // 「点了没反应」或「跳到别处」。
  it('报告完成：report 型带不透明 id', () => {
    expect(
      resolveNotificationLink({ link: { type: 'report', reportId: 'daily-2026-08-21' } })
    ).toEqual({ type: 'report', reportId: 'daily-2026-08-21' })
  })

  it('通讯录治理建议：contact_queue 无参数型', () => {
    expect(resolveNotificationLink({ link: { type: 'contact_queue' } })).toEqual({
      type: 'contact_queue'
    })
  })

  it('无参数型对载荷里多出来的字段宽容（后端加字段不该让链接失效）', () => {
    expect(resolveNotificationLink({ link: { type: 'contact_queue', pending: 4 } })).toEqual({
      type: 'contact_queue'
    })
    expect(
      resolveNotificationLink({ link: { type: 'updater_restart', version: '2.18.0' } })
    ).toEqual({ type: 'updater_restart' })
  })

  it('事项提案：matter 型带 publicId', () => {
    expect(resolveNotificationLink({ link: { type: 'matter', publicId: 'm_7fa3' } })).toEqual({
      type: 'matter',
      publicId: 'm_7fa3'
    })
  })

  it('应用更新就绪：updater_restart 无参数型', () => {
    expect(resolveNotificationLink({ link: { type: 'updater_restart' } })).toEqual({
      type: 'updater_restart'
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
    ['未知 link 型（前向兼容：老前端遇新型不炸）', { link: { type: 'email', internalId: 7 } }],
    ['session 缺 sessionId', { link: { type: 'session' } }],
    ['sessionId 是字符串', { link: { type: 'session', sessionId: '42' } }],
    ['sessionId 为 0（后端拿不到会话时的哨兵）', { link: { type: 'session', sessionId: 0 } }],
    ['sessionId 为负', { link: { type: 'session', sessionId: -1 } }],
    ['sessionId 非整数', { link: { type: 'session', sessionId: 1.5 } }],
    ['route 缺 to', { link: { type: 'route' } }],
    ['route 目标不在白名单', { link: { type: 'route', to: '/matters' } }],
    ['route 目标是外链', { link: { type: 'route', to: 'https://example.test' } }],
    ['report 缺 reportId', { link: { type: 'report' } }],
    [
      'reportId 是数字（后端 id 是字符串，形状不对就不跳）',
      { link: { type: 'report', reportId: 7 } }
    ],
    ['reportId 是空串', { link: { type: 'report', reportId: '' } }],
    ['matter 缺 publicId', { link: { type: 'matter' } }],
    ['matter 的 publicId 是空串', { link: { type: 'matter', publicId: '' } }]
  ])('%s → null', (_label, payload) => {
    expect(resolveNotificationLink(payload as Record<string, unknown> | null)).toBeNull()
  })

  it('route 的 search 不是对象时降级为 null，不整条丢弃', () => {
    expect(
      resolveNotificationLink({ link: { type: 'route', to: '/agents', search: 'tab' } })
    ).toEqual({ type: 'route', to: '/agents', search: null })
  })
})
