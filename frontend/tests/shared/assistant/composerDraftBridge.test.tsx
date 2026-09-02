// @vitest-environment happy-dom
//
// 09-02 对话域拆分 —— composer 文本 ↔ 标签草稿快照的桥（`ComposerDraftBridge`）。宿主
// （AgentViewLayout 的 ChatTabHost）只存 ref + 卸载时落盘，真正「把字放回输入框 / 把字交
// 出来」的那一段全在这里，而它渲染 null：坏掉的表现是**切回标签输入框是空的**，DOM 上
// 没有任何东西会红。
//
// 钉三条：
//   B1 挂载时把宿主的初值写进空 composer（切回标签 = 草稿回来）；
//   B2 composer 非空（用户已经在打字）时不覆盖 —— runtime 会在同一个标签内重挂
//      （navEpoch / settle 后的 `:rN`），那时抢着写会把在打的字冲掉；
//   B3 挂载那一次不回调。此刻 composer 还是 runtime 的空初值，回调出去会把宿主刚交来的
//      草稿清成 '' —— 于是「切走再切回」两次之后草稿静默消失。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'

const { composerState, setText, listeners } = vi.hoisted(() => ({
  composerState: { text: '' },
  setText: vi.fn(),
  listeners: new Set<() => void>()
}))

// 以最小实现镜像 assistant-ui 的两个消费面（selector(state) + 订阅），让测试能显式驱动
// 「用户打了一个字」这一刻。体例同 `tests/shared/chatPromptDispatch.test.tsx`。
vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({ composer: () => ({ setText }) }),
  useAuiState: (selector: (state: { composer: typeof composerState }) => unknown) => {
    const { useSyncExternalStore } = require('react') as typeof import('react')
    return useSyncExternalStore(
      (onChange: () => void) => {
        listeners.add(onChange)
        return () => listeners.delete(onChange)
      },
      () => selector({ composer: composerState })
    )
  }
}))

const { ComposerDraftBridge } = await import('@shared/assistant/components/ComposerDraftBridge')

/** 模拟用户在输入框里打字（composer 文本变化 → 订阅者重渲染）。 */
function type(text: string): void {
  act(() => {
    composerState.text = text
    listeners.forEach((fn) => fn())
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  composerState.text = ''
  listeners.clear()
})

afterEach(() => cleanup())

describe('ComposerDraftBridge', () => {
  test('B1 挂载时把宿主初值写进空 composer', () => {
    render(<ComposerDraftBridge restore={() => '写了一半的问题'} onChange={vi.fn()} />)
    expect(setText).toHaveBeenCalledTimes(1)
    expect(setText).toHaveBeenCalledWith('写了一半的问题')
  })

  test("B1b 宿主没有草稿（''）→ 一个字都不写", () => {
    render(<ComposerDraftBridge restore={() => ''} onChange={vi.fn()} />)
    expect(setText).not.toHaveBeenCalled()
  })

  test('B2 composer 已有文本 → 不覆盖用户正在打的字', () => {
    composerState.text = '用户正在打的'
    render(<ComposerDraftBridge restore={() => '标签上的旧草稿'} onChange={vi.fn()} />)
    expect(setText).not.toHaveBeenCalled()
  })

  test('B3 挂载那次不回调；之后每次文本变化都同步给宿主', () => {
    const onChange = vi.fn()
    render(<ComposerDraftBridge restore={() => '恢复的草稿'} onChange={onChange} />)
    // 🔴 这里若回调一次，宿主 ref 会被 runtime 的空初值清成 ''（setText 还没落地），
    // 「切走再切回」两次之后草稿就没了。
    expect(onChange).not.toHaveBeenCalled()

    type('恢复的草稿再加一句')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith('恢复的草稿再加一句')

    type('')
    expect(onChange).toHaveBeenLastCalledWith('')
  })
})
