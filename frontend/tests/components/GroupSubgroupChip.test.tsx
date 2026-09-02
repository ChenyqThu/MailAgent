// @vitest-environment happy-dom
//
// g3 lane U — 群列表里的子群标注（狼人杀的狼群 / 预言家群挂在主群下）。
//
//   C1 父群在同一屏 → chip 写「子群 · <父群标题>」；
//   C2 父群不在这一屏（删了 / 没翻到）→ 退回 `#id`，不吞掉标注也不多打一次读；
//   C3 顶级群没有 chip；
//   C4 chip 不占第二行：没有 last_message 的行仍旧是「N 名成员」（GroupChat.test W1 同口径）。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('../../src/shared/components/agents/AgentAvatar', () => ({
  AgentAvatar: (props: { agentId: string }) => <span data-avatar={props.agentId} />
}))

import i18n from '@shared/i18n'
import { GroupList } from '../../src/shared/components/agents/groups/GroupList'
import type { GroupRowItem } from '../../src/shared/components/agents/groups/GroupRow'
import type { GroupMemberMeta } from '../../src/shared/components/agents/groups/members'

await i18n.changeLanguage('zh-CN')

const MEMBER_META = new Map<string, GroupMemberMeta>([
  ['judge', { title: '法官' }],
  ['p1', { title: '玩家甲' }]
])

function row(over: Partial<GroupRowItem> = {}): GroupRowItem {
  return {
    id: 901,
    title: '狼人杀 #1',
    members_json: '["judge","p1"]',
    updated_at: 1_700_000_000_000,
    ...over
  }
}

function renderList(items: GroupRowItem[]): void {
  render(
    <GroupList
      items={items}
      memberMeta={MEMBER_META}
      activeId={null}
      liveBySession={new Map()}
      sendingSessionId={null}
      canCreate
      unreadOf={() => false}
      narrow={false}
      navHidden={false}
      onSelect={vi.fn()}
      onNew={vi.fn()}
      onRename={vi.fn()}
      onDelete={vi.fn()}
    />
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('群列表的子群标注', () => {
  test('C1 父群在同一屏 → chip 用父群标题', () => {
    renderList([row(), row({ id: 902, title: '狼人杀 #1 · 狼群', parent_session_id: 901 })])
    expect(screen.getByText('子群 · 狼人杀 #1')).toBeTruthy()
  })

  test('C2 父群不在这一屏 → chip 退回 #id', () => {
    renderList([row({ id: 902, title: '狼人杀 #1 · 狼群', parent_session_id: 901 })])
    expect(screen.getByText('子群 · #901')).toBeTruthy()
  })

  test('C3 顶级群没有 chip', () => {
    renderList([row()])
    expect(document.querySelector('[data-subgroup-of]')).toBeNull()
  })

  test('C4 chip 不挤掉第二行的「N 名成员」', () => {
    renderList([row(), row({ id: 902, title: '狼人杀 #1 · 狼群', parent_session_id: 901 })])
    // 两行都没有 last_message → 两行的第二行都是成员数文案。
    expect(screen.getAllByText('2 名成员')).toHaveLength(2)
  })
})
