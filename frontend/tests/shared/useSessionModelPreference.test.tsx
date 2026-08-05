// @vitest-environment happy-dom
//
// useSessionModelPreference — W8 per-session 模型偏好接线（task 08-04 WP2）。
//
// 这是「切会话各自记得上次所选模型」的全部逻辑，覆盖的都是接错了会静默出错的分支：
//   1. **三态 sessionModel**：`undefined`（行还没加载）绝不回填 —— 拿全局默认覆盖真值，就等于
//      每次刚打开会话都把它的模型悄悄改了；`null`（老会话没存过）保持现值；字符串才回填。
//   2. **选模型 = 本地立刻生效 + 落全局默认 + 落当前会话行**；没有会话行（新对话）时不落库。
//   3. **不被自己刚写的值顶回去**：selectModel 之后 sessions 列表刷新带回**旧** backend_model
//      （落库是异步的，列表可能先到），必须保持用户的选择。这条是最容易踩的竞态。
//   4. **切到另一个会话才重新判定**：同一 session id 的后续 sessionModel 抖动不再覆盖。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

// happy-dom（本仓这套配置）不提供 localStorage —— 生产代码的 try/catch 会把它降级成
// 「读不到就用默认值」，但那样就测不到 pref 读写了。用内存 stub 顶上（active-email.test.ts 先例）。
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear()
})

import {
  CUSTOM_MODEL_PREF,
  DEFAULT_CUSTOM_MODEL,
  useSessionModelPreference
} from '@shared/hooks/useSessionModelPreference'

function Probe({
  sessionId,
  sessionModel,
  persist
}: {
  sessionId: number | null
  sessionModel: string | null | undefined
  persist: (sessionId: number, model: string) => void
}): React.JSX.Element {
  const { model, selectModel } = useSessionModelPreference({ sessionId, sessionModel, persist })
  return (
    <div>
      <span data-testid="model">{model}</span>
      <button type="button" onClick={() => selectModel('openai:gpt-5.5')}>
        pick
      </button>
    </div>
  )
}

const model = (): string => screen.getByTestId('model').textContent ?? ''

beforeEach(() => {
  localStorage.clear()
})
afterEach(() => cleanup())

describe('useSessionModelPreference — 回填（读）', () => {
  test('全新对话（sessionId=null）用全局默认，不落库', () => {
    const persist = vi.fn()
    localStorage.setItem(CUSTOM_MODEL_PREF, 'anthropic:claude-opus-4-8')
    render(<Probe sessionId={null} sessionModel={null} persist={persist} />)
    expect(model()).toBe('anthropic:claude-opus-4-8')
    expect(persist).not.toHaveBeenCalled()
  })

  test('localStorage 空 → DEFAULT_CUSTOM_MODEL', () => {
    render(<Probe sessionId={null} sessionModel={null} persist={vi.fn()} />)
    expect(model()).toBe(DEFAULT_CUSTOM_MODEL)
  })

  test('行还没加载（undefined）时不回填；行到了才用该会话的模型', () => {
    localStorage.setItem(CUSTOM_MODEL_PREF, 'anthropic:claude-sonnet-4-6')
    const { rerender } = render(<Probe sessionId={7} sessionModel={undefined} persist={vi.fn()} />)
    expect(model()).toBe('anthropic:claude-sonnet-4-6')
    rerender(<Probe sessionId={7} sessionModel="openai:gpt-5.5" persist={vi.fn()} />)
    expect(model()).toBe('openai:gpt-5.5')
  })

  test('老会话（行在但 backend_model=null）保持现值，不重置', () => {
    localStorage.setItem(CUSTOM_MODEL_PREF, 'anthropic:claude-opus-4-8')
    render(<Probe sessionId={7} sessionModel={null} persist={vi.fn()} />)
    expect(model()).toBe('anthropic:claude-opus-4-8')
  })

  test('切到另一个会话 → 用那个会话自己的模型', () => {
    const { rerender } = render(
      <Probe sessionId={1} sessionModel="anthropic:claude-opus-4-8" persist={vi.fn()} />
    )
    expect(model()).toBe('anthropic:claude-opus-4-8')
    rerender(<Probe sessionId={2} sessionModel="openai:gpt-5.5" persist={vi.fn()} />)
    expect(model()).toBe('openai:gpt-5.5')
  })
})

describe('useSessionModelPreference — 选择（写）', () => {
  test('选模型：本地立刻生效 + 写全局默认 + 落当前会话行', () => {
    const persist = vi.fn()
    render(<Probe sessionId={42} sessionModel="anthropic:claude-sonnet-4-6" persist={persist} />)
    act(() => {
      screen.getByText('pick').click()
    })
    expect(model()).toBe('openai:gpt-5.5')
    expect(localStorage.getItem(CUSTOM_MODEL_PREF)).toBe('openai:gpt-5.5')
    expect(persist).toHaveBeenCalledWith(42, 'openai:gpt-5.5')
  })

  test('还没有会话行时只落全局默认，不调 persist（没有 id 可写）', () => {
    const persist = vi.fn()
    render(<Probe sessionId={null} sessionModel={null} persist={persist} />)
    act(() => {
      screen.getByText('pick').click()
    })
    expect(model()).toBe('openai:gpt-5.5')
    expect(localStorage.getItem(CUSTOM_MODEL_PREF)).toBe('openai:gpt-5.5')
    expect(persist).not.toHaveBeenCalled()
  })

  test('🔴 竞态：选完之后 sessions 列表带回旧 backend_model，不得把用户的选择顶回去', () => {
    const persist = vi.fn()
    const { rerender } = render(
      <Probe sessionId={42} sessionModel="anthropic:claude-sonnet-4-6" persist={persist} />
    )
    act(() => {
      screen.getByText('pick').click()
    })
    expect(model()).toBe('openai:gpt-5.5')
    // 落库是异步的；列表刷新可能先带着旧值回来。
    rerender(<Probe sessionId={42} sessionModel="anthropic:claude-sonnet-4-6" persist={persist} />)
    expect(model()).toBe('openai:gpt-5.5')
  })

  test('🔴 竞态（切走再切回）：选完切到别的会话再切回来，stale 列表不得把选择顶回去', () => {
    // sessions 列表是 useEmailChat 的本地 state，切会话**不**重拉；落库又是 fire-and-forget
    // 不失效缓存。故切回来时 sessionModel 仍是旧值 —— 只认 resolvedForRef 那一版会在这里
    // 把用户刚选的模型静默丢掉（DB 里其实已经是新值），本用例就是那条回归闸。
    const persist = vi.fn()
    const { rerender } = render(
      <Probe sessionId={42} sessionModel="anthropic:claude-sonnet-4-6" persist={persist} />
    )
    act(() => {
      screen.getByText('pick').click()
    })
    expect(model()).toBe('openai:gpt-5.5')
    // 切到别的会话（它有自己的模型）。
    rerender(<Probe sessionId={7} sessionModel="anthropic:claude-opus-4-8" persist={persist} />)
    expect(model()).toBe('anthropic:claude-opus-4-8')
    // 切回来 —— 列表还没刷新，带回的仍是**旧** backend_model。
    rerender(<Probe sessionId={42} sessionModel="anthropic:claude-sonnet-4-6" persist={persist} />)
    expect(model()).toBe('openai:gpt-5.5')
  })

  test('同一会话内 sessionModel 抖动（含短暂 undefined）也不覆盖已判定的值', () => {
    const { rerender } = render(
      <Probe sessionId={9} sessionModel="anthropic:claude-opus-4-8" persist={vi.fn()} />
    )
    expect(model()).toBe('anthropic:claude-opus-4-8')
    rerender(<Probe sessionId={9} sessionModel={undefined} persist={vi.fn()} />)
    rerender(<Probe sessionId={9} sessionModel="openai:gpt-5.5" persist={vi.fn()} />)
    expect(model()).toBe('anthropic:claude-opus-4-8')
  })
})
