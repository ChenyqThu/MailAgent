// @vitest-environment happy-dom
//
// T2 check — 在场态的**接线**（纯函数的真值表在 groupTurnStage.test.ts，这里只钉「事实到不到得了
// 那个函数」）：
//   T1 lastEventAt 经 live 传到 GroupTranscript → 静默 15s 显示 stalled 文案（不是恒 connecting）；
//   T2 在场期间时钟自己走：不靠父层重渲，跨过 15s 门槛后当场降级
//      —— 父层的 `now` 是 60s 节拍，只有它就意味着 stalled 最坏晚 60s 才出现（AC3 要的是 15s）。
//
// 时钟用假时钟推：`usePresenceNow` 的 setInterval 与 Date.now() 都在 vi 的假时钟治下。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

import i18n from '@shared/i18n'
import { GroupTranscript } from '../../../src/shared/components/agents/groups/GroupTranscript'
import type { GroupMemberMeta } from '../../../src/shared/components/agents/groups/members'

await i18n.changeLanguage('zh-CN')

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const MEMBER_META = new Map<string, GroupMemberMeta>([['a1', { title: '调研员', avatar: null }]])

function renderTranscript(over: {
  now: number
  lastEventAt: number | null
  text?: string
  /** 收尾态：三元组全空 + 一条 failed 留痕（error 支）。 */
  failedAt?: number
}): ReturnType<typeof render> {
  const overlay = new Map(
    over.failedAt == null
      ? []
      : [['r1:1', { turnKey: 'r1:1', phase: 'failed' as const, agentId: 'a1', ts: over.failedAt }]]
  )
  return render(
    <GroupTranscript
      items={[]}
      tail={{
        inFlight:
          over.failedAt != null
            ? null
            : { agentId: 'a1', text: over.text ?? '半句', startedAt: over.now - 20_000 },
        preparing: null,
        queued: []
      }}
      memberIds={['a1']}
      memberMeta={MEMBER_META}
      members={[{ agentId: 'a1', title: '调研员' }]}
      now={over.now}
      loading={false}
      error={null}
      onRetryLoad={() => undefined}
      empty="orchestrated"
      retryStates={new Map()}
      onRetry={() => undefined}
      attachmentsById={new Map()}
      live={{ overlay, lastEventAt: over.lastEventAt }}
    />
  )
}

describe('GroupTranscript 在场态接线', () => {
  test('T1 lastEventAt 已静默 16s → stalled 文案（事实确实到得了 groupTurnStage）', () => {
    const now = Date.now()
    renderTranscript({ now, lastEventAt: now - 16_000 })
    expect(screen.getByText('仍在等待响应…')).toBeTruthy()
  })

  test('T2 在场期间时钟自己走：父层不重渲也会跨过 15s 门槛降级', () => {
    vi.useFakeTimers()
    const now = Date.now()
    // 起点：刚收到事件 → writing。父层的 now 此后一动不动（60s 节拍还没到）。
    renderTranscript({ now, lastEventAt: now })
    expect(screen.getByText('正在回复…')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(16_000)
    })
    expect(screen.getByText('仍在等待响应…')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(16_000)
    })
    expect(screen.getByText('仍在等待响应（可点停止中断）…')).toBeTruthy()
  })

  test('T3 收尾后的 error 行会自己走完新鲜期消失（失败留痕没有清理者，停表就是永动红字）', () => {
    vi.useFakeTimers()
    const now = Date.now()
    renderTranscript({ now, lastEventAt: now, failedAt: now })
    expect(screen.getByText('响应出错')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(16_000)
    })
    expect(screen.queryByTestId('turn-presence')).toBeNull()
  })
})
