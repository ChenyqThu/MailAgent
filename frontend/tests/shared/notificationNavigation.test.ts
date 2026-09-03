// 通知 deep-link 解析器的行为测试（task 08-20-notification-center 步骤 7）。
//
// 为什么值得测：`payload` 是后端自由结构化载荷，解析器是它到路由跳转之间**唯一**的守门人。
// 松了 → 一条畸形/未来版本的 link 让条目点下去乱跳或抛异常；紧了 → 真实信源发的 link 点不
// 动。两侧都只在人工点击时才暴露，故这里对着 M1 三个信源真会发的形状逐条钉住。

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatSession } from '@shared/api/types'
import { navigateToGroupThread } from '@shared/components/agents/groups/navigation'
import { useAgentsNavigation } from '@shared/components/agents/navigation'
import {
  navigateNotificationRoute,
  openNotificationSession,
  resolveNotificationLink
} from '@shared/components/notifications/navigation'
import { useAIChatPanel } from '@shared/state/ai-chat-panel'
import { useGroupsView } from '@shared/state/groups-view'

describe('resolveNotificationLink — 真实信源形状', () => {
  it('agent run 终态：session 型（run_worker.py 有 session_id 时）', () => {
    expect(resolveNotificationLink({ link: { type: 'session', sessionId: 42 } })).toEqual({
      type: 'session',
      sessionId: 42
    })
  })

  // 09-02 通知深链修正：`agent_run` / `contact_governance` 两类 job 的 session 型 link
  // 追加 agentId（matter 系 job 有意不带）。老前端忽略未知字段 = 前向兼容；这里钉住新前端
  // 把它收窄出来，且**只在非空字符串时**带出 —— 带一个空 id 上路会跳到团队页却什么都不选中。
  it('agent run 终态：session 型带 agentId（09-02 起）', () => {
    expect(
      resolveNotificationLink({
        link: { type: 'session', sessionId: 263, agentId: 'contact_governance_agent' }
      })
    ).toEqual({ type: 'session', sessionId: 263, agentId: 'contact_governance_agent' })
  })

  it('agentId 是空串 / 非字符串 → 当作没有（落地时回查会话）', () => {
    expect(
      resolveNotificationLink({ link: { type: 'session', sessionId: 263, agentId: '' } })
    ).toEqual({ type: 'session', sessionId: 263 })
    expect(
      resolveNotificationLink({ link: { type: 'session', sessionId: 263, agentId: 7 } })
    ).toEqual({ type: 'session', sessionId: 263 })
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

// route 型的落地 switch（task 08-24-l4-nav-shell Step B 收敛单源 + 补 `/settings` case）。
// 此前两份手抄 switch 都漏 `/settings`：kos 死信通知过白名单却落不了地，点了只标已读。
describe('navigateNotificationRoute — route 型落地', () => {
  type NavigateArg = { to: string; search?: Record<string, unknown> }
  function run(link: ReturnType<typeof resolveNotificationLink>): NavigateArg | undefined {
    const navigate = vi.fn()
    if (!link || link.type !== 'route') throw new Error('expected route link')
    navigateNotificationRoute(navigate as never, link)
    return navigate.mock.calls.at(-1)?.[0] as NavigateArg | undefined
  }

  it('KOS dead：/settings 带 integrations tab → 落 settings 页对应 tab', () => {
    expect(
      run(
        resolveNotificationLink({
          link: { type: 'route', to: '/settings', search: { tab: 'integrations' } }
        })
      )
    ).toEqual({ to: '/settings', search: { tab: 'integrations' } })
  })

  it('/settings 的非法 tab clamp 到 general（与路由 validateSearch 同口径）', () => {
    expect(
      run(
        resolveNotificationLink({
          link: { type: 'route', to: '/settings', search: { tab: 'rogue' } }
        })
      )
    ).toEqual({ to: '/settings', search: { tab: 'general' } })
  })

  // 08-27 P3：`/agents` 的三 tab 拆成三个一级域，路由不再有搜索参数 —— 老载荷里
  // 带的 `search.tab`（`run_worker.py` 曾发 `{"tab":"agents"}`）落地时整个忽略。
  it('/agents 忽略载荷里的 tab；/admin/kanban 无 search', () => {
    expect(
      run(
        resolveNotificationLink({
          link: { type: 'route', to: '/agents', search: { tab: 'rogue' } }
        })
      )
    ).toEqual({ to: '/agents' })
    expect(run(resolveNotificationLink({ link: { type: 'route', to: '/admin/kanban' } }))).toEqual({
      to: '/admin/kanban'
    })
  })
})

// session 型的落地（09-02 通知深链修正）。owner dogfood 反馈的原症状：点通知落到对话域
// AI 分段，而那一段按 origin 过滤根本不列 origin='agent' 的行 ⇒ 详情与左侧历史对不上。
// 归宿改成团队页那位成员的记录档，判据分三支 —— 每一支错一次都是「点了跳错地方」。
describe('openNotificationSession — 三分支落地', () => {
  function sessionLink(payload: Record<string, unknown>) {
    const link = resolveNotificationLink(payload)
    if (!link || link.type !== 'session') throw new Error('expected session link')
    return link
  }

  /** 回查返回的会话行：只有 origin / agent_id 参与判定，其余字段与判据无关。 */
  function row(over: Partial<ChatSession>): ChatSession {
    return { id: 263, ...over } as ChatSession
  }

  async function land(
    payload: Record<string, unknown>,
    getSession: (id: number) => Promise<ChatSession | null>
  ): Promise<{ navigate: ReturnType<typeof vi.fn>; getSession: typeof getSession }> {
    const navigate = vi.fn()
    await openNotificationSession(navigate as never, sessionLink(payload), { getSession })
    return { navigate, getSession }
  }

  beforeEach(() => {
    useAgentsNavigation.getState().clear()
    useAIChatPanel.getState().consumeOpenAgentSession()
  })

  it('带 agentId → 团队页记录直达，且不回查会话（后端已给出归属）', async () => {
    const getSession = vi.fn()
    const { navigate } = await land(
      { link: { type: 'session', sessionId: 263, agentId: 'contact_governance_agent' } },
      getSession
    )
    expect(getSession).not.toHaveBeenCalled()
    expect(useAgentsNavigation.getState().targetAgentId).toBe('contact_governance_agent')
    expect(useAgentsNavigation.getState().targetRecordSessionId).toBe(263)
    expect(navigate).toHaveBeenCalledWith({ to: '/agents' })
    expect(useAIChatPanel.getState().pendingAgentSessionId).toBeNull()
  })

  // 生产库里的 6 条老行（run_worker 还没带 agentId 时发的）只能回查会话本身。
  it.each([['agent'], ['team']])(
    '无 agentId + 回查到 origin=%s 的 agent 会话 → 同样直达团队页',
    async (origin) => {
      const getSession = vi.fn().mockResolvedValue(row({ origin, agent_id: 'dms_helper' }))
      const { navigate } = await land({ link: { type: 'session', sessionId: 263 } }, getSession)
      expect(getSession).toHaveBeenCalledWith(263)
      expect(useAgentsNavigation.getState().targetAgentId).toBe('dms_helper')
      expect(useAgentsNavigation.getState().targetRecordSessionId).toBe(263)
      expect(navigate).toHaveBeenCalledWith({ to: '/agents' })
    }
  )

  it('回查到普通交互会话 → 维持现状（AI 分段），不进团队页', async () => {
    const getSession = vi.fn().mockResolvedValue(row({ origin: null, agent_id: null }))
    const { navigate } = await land({ link: { type: 'session', sessionId: 263 } }, getSession)
    expect(useAIChatPanel.getState().pendingAgentSessionId).toBe(263)
    expect(navigate).toHaveBeenCalledWith({ to: '/sessions' })
    expect(useAgentsNavigation.getState().targetAgentId).toBeNull()
  })

  // 事项域命名空间的会话归事项页 —— 团队页没有对应成员，跳过去是一屏什么都没选中。
  it.each([['matter:m_7fa3'], ['matter_item:m_7fa3']])(
    'agent_id=%s（事项域）→ 维持现状，不进团队页',
    async (agentId) => {
      const getSession = vi.fn().mockResolvedValue(row({ origin: 'agent', agent_id: agentId }))
      const { navigate } = await land({ link: { type: 'session', sessionId: 263 } }, getSession)
      expect(useAgentsNavigation.getState().targetAgentId).toBeNull()
      expect(useAIChatPanel.getState().pendingAgentSessionId).toBe(263)
      expect(navigate).toHaveBeenCalledWith({ to: '/sessions' })
    }
  )

  it('origin=agent 但 agent_id 缺失（老库行）→ 维持现状', async () => {
    const getSession = vi.fn().mockResolvedValue(row({ origin: 'agent', agent_id: null }))
    const { navigate } = await land({ link: { type: 'session', sessionId: 263 } }, getSession)
    expect(useAgentsNavigation.getState().targetAgentId).toBeNull()
    expect(navigate).toHaveBeenCalledWith({ to: '/sessions' })
  })

  // 🔴 回查失败不能吞成「点了没反应」：退回原来的 AI 分段分支，至少还打得开那个会话。
  it('getSession 抛错 / 返回 null → 退回现状分支', async () => {
    const thrown = await land({ link: { type: 'session', sessionId: 263 } }, () =>
      Promise.reject(new Error('network down'))
    )
    expect(useAIChatPanel.getState().pendingAgentSessionId).toBe(263)
    expect(thrown.navigate).toHaveBeenCalledWith({ to: '/sessions' })

    useAIChatPanel.getState().consumeOpenAgentSession()
    const missing = await land({ link: { type: 'session', sessionId: 263 } }, () =>
      Promise.resolve(null)
    )
    expect(useAIChatPanel.getState().pendingAgentSessionId).toBe(263)
    expect(missing.navigate).toHaveBeenCalledWith({ to: '/sessions' })
  })
})

describe('resolveNotificationLink — group 型（L4 群聊 UX 批）', () => {
  it('L1 {type:group, sessionId:7} → group 链接；sessionId 非正整数 → null', () => {
    expect(resolveNotificationLink({ link: { type: 'group', sessionId: 7 } })).toEqual({
      type: 'group',
      sessionId: 7
    })
    expect(resolveNotificationLink({ link: { type: 'group', sessionId: 0 } })).toBeNull()
    expect(resolveNotificationLink({ link: { type: 'group', sessionId: 1.5 } })).toBeNull()
    expect(resolveNotificationLink({ link: { type: 'group', sessionId: '7' } })).toBeNull()
    expect(resolveNotificationLink({ link: { type: 'group' } })).toBeNull()
  })
})

// T3 话题：thread 型两个 id 都是会话 id，缺一个就不跳（只有群 id 会落到主时间线，而话题回复
// 不在主时间线上 —— 跳过去等于什么都没看到）。
describe('resolveNotificationLink — thread 型（T3）', () => {
  it('T1 {type:thread, groupId, threadId} → thread 链接', () => {
    expect(resolveNotificationLink({ link: { type: 'thread', groupId: 7, threadId: 9 } })).toEqual({
      type: 'thread',
      groupId: 7,
      threadId: 9
    })
  })

  it.each([
    ['缺 threadId', { link: { type: 'thread', groupId: 7 } }],
    ['缺 groupId', { link: { type: 'thread', threadId: 9 } }],
    ['groupId 为 0', { link: { type: 'thread', groupId: 0, threadId: 9 } }],
    ['threadId 为 0', { link: { type: 'thread', groupId: 7, threadId: 0 } }],
    ['threadId 非整数', { link: { type: 'thread', groupId: 7, threadId: 1.5 } }],
    ['groupId 是字符串', { link: { type: 'thread', groupId: '7', threadId: 9 } }],
    ['threadId 为负', { link: { type: 'thread', groupId: 7, threadId: -1 } }]
  ])('T2 %s → null', (_label, payload) => {
    expect(resolveNotificationLink(payload as Record<string, unknown>)).toBeNull()
  })
})

// thread 型落地单源（groups/navigation）：点名话题 + 点名群 + 进 /groups，三件缺一件都是
// 「跳过去看不见那条回复」（面板内点击与系统通知点击共用这一处）。
describe('navigateToGroupThread — thread 型落地', () => {
  beforeEach(() => {
    useGroupsView.setState({ activeGroupSessionId: null, activeThreadBySession: {} })
  })

  it('点名群 + 点名话题 + navigate(/groups)', () => {
    const navigate = vi.fn()
    navigateToGroupThread(navigate as never, 7, 9)
    expect(useGroupsView.getState().activeGroupSessionId).toBe(7)
    expect(useGroupsView.getState().activeThreadBySession[7]).toBe(9)
    expect(navigate).toHaveBeenCalledWith({ to: '/groups' })
  })

  it('换到另一个群的话题：旧群的话题键不动（按群记忆），新群被点名', () => {
    useGroupsView.setState({ activeGroupSessionId: 7, activeThreadBySession: { 7: 9 } })
    navigateToGroupThread(vi.fn() as never, 8, 10)
    expect(useGroupsView.getState().activeGroupSessionId).toBe(8)
    expect(useGroupsView.getState().activeThreadBySession).toEqual({ 7: 9, 8: 10 })
  })
})
