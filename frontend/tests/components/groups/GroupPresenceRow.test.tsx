// @vitest-environment happy-dom
//
// T2 lane P — 群在场行：写者半边换成 AI Chat 那条 TurnPresenceRow，排队半边原样保留。
//
//   R1 writing → 成员头像 + 「正在回复…」shimmer（文案单源 chat.runStatus.*，群侧不另立一套）；
//   R2 connecting / stalled 两档 / error 各自的文案与表情；error 不挂秒表；
//   R3 motion allowed → 秒表在走（reduced-motion 下整条秒表不出现，是既有契约）；
//   R4 排队半边文案不变（groupChat.queuedOne / queuedMany），两半同时在场时分两行
//      —— shimmer 与脉冲点不同行（prd「motion 纪律」）；
//   R5 两半都空 → 整行不渲染（在场态只来自事件 / 探针，不自己编）；
//   R6 成员头像取成员自己的配置：上传图渲染 img，bot 配置渲染 BotAvatar。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

import i18n from '@shared/i18n'
import {
  GroupPresenceRow,
  type GroupPresenceWriter
} from '../../../src/shared/components/agents/groups/GroupPresenceRow'

await i18n.changeLanguage('zh-CN')

afterEach(() => {
  cleanup()
})

/** 退出套件默认的 reduced-motion（先例：TurnPresence.test.tsx）。调用方负责 unstubAllGlobals。 */
function allowMotion(): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
        onchange: null
      }) as unknown as MediaQueryList
  )
}

function writer(over: Partial<GroupPresenceWriter> = {}): GroupPresenceWriter {
  return { agentId: 'a1', name: '调研员', stage: 'writing', stallLevel: 0, ...over }
}

const CLOCK = '本回合已运行'

describe('GroupPresenceRow — 写者半边', () => {
  test('R1 writing → 头像 writing 表情 + 「正在回复…」', () => {
    render(<GroupPresenceRow writer={writer()} queuedNames={[]} />)
    expect(screen.getByTestId('turn-presence').dataset.botState).toBe('writing')
    expect(screen.getByText('正在回复…')).toBeTruthy()
  })

  test('R2a connecting → waking + 「正在连接…」', () => {
    render(<GroupPresenceRow writer={writer({ stage: 'connecting' })} queuedNames={[]} />)
    expect(screen.getByTestId('turn-presence').dataset.botState).toBe('waking')
    expect(screen.getByText('正在连接…')).toBeTruthy()
  })

  test('R2b stalled 两档 → drowsy + 静态等待文案', () => {
    const view = render(
      <GroupPresenceRow writer={writer({ stage: 'stalled', stallLevel: 1 })} queuedNames={[]} />
    )
    expect(screen.getByTestId('turn-presence').dataset.botState).toBe('drowsy')
    expect(screen.getByText('仍在等待响应…')).toBeTruthy()
    view.rerender(
      <GroupPresenceRow writer={writer({ stage: 'stalled', stallLevel: 2 })} queuedNames={[]} />
    )
    expect(screen.getByText('仍在等待响应（可点停止中断）…')).toBeTruthy()
  })

  test('R2c error → sad + 红字，且不挂秒表（终态旁边走动的读数会读成「还在跑」）', () => {
    allowMotion()
    try {
      render(<GroupPresenceRow writer={writer({ stage: 'error' })} queuedNames={[]} />)
      expect(screen.getByTestId('turn-presence').dataset.botState).toBe('sad')
      expect(screen.getByText('响应出错').className).toContain('text-fail')
      expect(screen.queryByTitle(CLOCK)).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('R3 motion allowed → 写者行带秒表且读数在走', async () => {
    allowMotion()
    try {
      render(<GroupPresenceRow writer={writer()} queuedNames={[]} />)
      // motion allowed 下 ShimmerText 是 base + hi 双层，同一句话两个节点。
      expect(screen.getAllByText('正在回复…').length).toBeGreaterThan(0)
      await waitFor(() => expect(screen.getByTitle(CLOCK)).toBeTruthy(), { timeout: 2000 })
      const first = screen.getByTitle(CLOCK).textContent ?? ''
      expect(first).toMatch(/^\d+(\.\d)?[sm]/)
      await waitFor(() => expect(screen.getByTitle(CLOCK).textContent).not.toBe(first), {
        timeout: 2000
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('R6a 成员上传图 → 渲染 img（表情对图片无意义）', () => {
    const data = `data:image/png;base64,${'aGVsbG8='}`
    render(
      <GroupPresenceRow writer={writer({ avatar: { type: 'image', data } })} queuedNames={[]} />
    )
    const img = screen.getByTestId('turn-presence').querySelector('img')
    expect(img?.getAttribute('src')).toBe(data)
  })

  test('R6b 成员 bot 配置 → 渲染 BotAvatar，不渲染 img', () => {
    render(
      <GroupPresenceRow
        writer={writer({ avatar: { type: 'bot', shape: 'cube', color: 'blue' } })}
        queuedNames={[]}
      />
    )
    const row = screen.getByTestId('turn-presence')
    expect(row.querySelector('img')).toBeNull()
    expect(row.querySelector('[data-bot-head]')).toBeTruthy()
  })
})

describe('GroupPresenceRow — 排队半边与空态', () => {
  test('R4a 排队文案不变（≤ 3 逐名，≥ 4 收成 N 位）', () => {
    const view = render(<GroupPresenceRow writer={null} queuedNames={['调研员', '跟进官']} />)
    expect(screen.getByText('调研员、跟进官 排队中')).toBeTruthy()
    expect(screen.queryByTestId('turn-presence')).toBeNull()
    view.rerender(<GroupPresenceRow writer={null} queuedNames={['A', 'B', 'C', 'D']} />)
    expect(screen.getByText('A、B 等 4 位排队中')).toBeTruthy()
  })

  test('R4b 两半同时在场 → 分两行（shimmer 与脉冲点不同行）', () => {
    const { container } = render(<GroupPresenceRow writer={writer()} queuedNames={['跟进官']} />)
    const presence = screen.getByTestId('turn-presence')
    const queued = screen.getByText('跟进官 排队中')
    expect(presence.contains(queued)).toBe(false)
    // 脉冲点在排队那一行里，不在写者行里。
    expect(presence.querySelector('.animate-pulse')).toBeNull()
    expect(container.querySelectorAll('.animate-pulse').length).toBe(3)
  })

  test('R5 两半都空 → 整行不渲染', () => {
    const { container } = render(<GroupPresenceRow writer={null} queuedNames={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
