// @vitest-environment happy-dom
//
// L4 群聊 g1 — 群设置对话框契约。
//
//   S1 改响应模式 → PUT 的 payload **只带改过的那个成员**（没动过的键不写：服务端整块覆写
//      group_config_json，把没动过的默认值原样回写等于把今天的默认冻结进这个群）；
//   S2 法官单选：选了一位之后，另一位仍是未选（结构上选不出两位）+ 出现「重新确认」提示；
//   S3 用量区渲染两指标（silentRunRate / turnsPerHumanMessage），未知渲染成「—」而不是 0。
//
// mock 面：groupSettings（serve-api 客户端）+ AgentAvatar（真组件拖 bot-avatar 渲染链）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

const mockGetGroupConfig = vi.fn()
const mockSetGroupConfig = vi.fn()
const mockGetGroupMetrics = vi.fn()
vi.mock('@shared/api/groupSettings', () => ({
  getGroupConfig: (...args: unknown[]) => mockGetGroupConfig(...args),
  setGroupConfig: (...args: unknown[]) => mockSetGroupConfig(...args),
  getGroupMetrics: (...args: unknown[]) => mockGetGroupMetrics(...args),
  getLabs: vi.fn(),
  setLabs: vi.fn()
}))

vi.mock('../../src/shared/components/agents/AgentAvatar', () => ({
  AgentAvatar: (props: { agentId: string; size?: number; title?: string }) => (
    <span data-avatar={props.agentId} data-size={props.size} title={props.title} />
  )
}))

import i18n from '@shared/i18n'
import { GroupSettingsDialog } from '../../src/shared/components/agents/groups/GroupSettingsDialog'
import type { GroupMemberMeta } from '../../src/shared/components/agents/groups/members'

await i18n.changeLanguage('zh-CN')

const MEMBER_IDS = ['a1', 'a2']
const MEMBER_META = new Map<string, GroupMemberMeta>([
  ['a1', { title: '调研员' }],
  ['a2', { title: '跟进官' }]
])

function renderDialog(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    createElement(
      QueryClientProvider,
      { client: qc },
      <GroupSettingsDialog
        open
        onOpenChange={vi.fn()}
        sessionId={300}
        memberIds={MEMBER_IDS}
        memberMeta={MEMBER_META}
      />
    )
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetGroupConfig.mockResolvedValue({ modes: {}, config: { v: 1 } })
  mockSetGroupConfig.mockResolvedValue({ modes: {}, config: { v: 1 } })
  mockGetGroupMetrics.mockResolvedValue({
    silentRunRate: null,
    turnsPerHumanMessage: null,
    last1h: { turns: 0, tokens: 0, costUsd: null },
    last24h: { turns: 0, tokens: 0, costUsd: null },
    lastStopReason: null
  })
})

afterEach(cleanup)

describe('GroupSettingsDialog', () => {
  test('S1 改一位成员的响应模式 → PUT 只带改过的键', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByLabelText('调研员 的响应模式')).toBeTruthy())
    // 缺行 = mention（服务端不给默认行），改 a1 为「实时」。
    const a1Track = screen.getByLabelText('调研员 的响应模式')
    const realtime = Array.from(a1Track.querySelectorAll('button')).find(
      (b) => b.textContent === '实时'
    ) as HTMLButtonElement
    fireEvent.click(realtime)
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(mockSetGroupConfig).toHaveBeenCalledTimes(1))
    // 🔴 只有 a1；a2 没动 → 不在 payload 里；四个数值项没动 → 一个都不写。
    expect(mockSetGroupConfig).toHaveBeenCalledWith(300, { modes: { a1: 'realtime' } })
  })

  test('S2 法官单选：选一位后另一位仍未选，并提示成员变动需重新确认', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByText('不设法官')).toBeTruthy())
    const radios = screen.getAllByRole('radio') as HTMLElement[]
    expect(radios).toHaveLength(3) // 不设法官 + 两位成员
    expect(screen.queryByText(/重新确认法官位/)).toBeNull()
    fireEvent.click(radios[1]) // 调研员
    await waitFor(() => expect(radios[1].getAttribute('aria-checked')).toBe('true'))
    expect(radios[2].getAttribute('aria-checked')).toBe('false')
    expect(radios[0].getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText(/重新确认法官位/)).toBeTruthy()

    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>
      expect(mockSetGroupConfig).toHaveBeenCalledWith(300, { judgeAgentId: 'a1' })
    )
  })

  test('S3 用量区两指标：已知按比例/次数渲染，未知渲染「—」', async () => {
    mockGetGroupMetrics.mockResolvedValue({
      silentRunRate: 0.263,
      turnsPerHumanMessage: 3.5,
      last1h: { turns: 7, tokens: 12_000, costUsd: null },
      last24h: { turns: 20, tokens: 40_000, costUsd: 0.4 },
      lastStopReason: 'chain_cap'
    })
    renderDialog()
    await waitFor(() => expect(screen.getByText('26.3%')).toBeTruthy())
    expect(screen.getByText('3.5')).toBeTruthy()
    // 整窗 cost 全 NULL = 未知（≠ $0.00）。
    expect(screen.getByText(/7 次 · 12000 token · —/)).toBeTruthy()
  })
})
