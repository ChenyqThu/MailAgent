// @vitest-environment happy-dom
//
// W3-① 「思考了 N 秒」—— ReasoningText 折叠头的耗时读数。
//
// 断言的是 useToolElapsed 的第 1 条契约在 reasoning 这一侧同样成立：**没有起点就没有数字**。
// 历史回放的 reasoning part 第一眼就是 settled（status.complete），时钟从未起过 → 折叠头保持静态
// 「思考过程」，而不是一个看起来很真、其实是编的「思考了 0.0 秒」。跑过一轮 running 的那条则相反：
// 终值由 effect 的 cleanup 落下（所以 reduced-motion —— 本套件的默认 —— 下也照样有数）。
//
// 直接渲染组件（不走整条 runtime）：这里要钉的是 part 的 status 语义 → 折叠头文案的映射，
// 中间再垫一层 converter 只会把「谁把 running 翻成了 complete」这件事糊掉。

import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

import type { ReasoningMessagePartProps } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import { ReasoningText } from '@shared/assistant/components/markdown-text'

await i18n.changeLanguage('zh-CN')

afterEach(() => {
  cleanup()
})

function reasoning(text: string, running: boolean): ReasoningMessagePartProps {
  return {
    type: 'reasoning',
    text,
    status: { type: running ? 'running' : 'complete' }
  } as unknown as ReasoningMessagePartProps
}

describe('ReasoningText — W3-① 折叠头耗时', () => {
  test('历史回放（第一眼就是 settled）→ 静态「思考过程」，永不编造耗时', async () => {
    render(<ReasoningText {...reasoning('先读正文…', false)} />)
    await waitFor(() => expect(screen.getByText('思考过程')).toBeTruthy())
    // 再等一会儿：没有起点的部件不会自己长出一个读数来。
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(screen.getByText('思考过程')).toBeTruthy()
    expect(screen.queryByText(/思考了/)).toBeNull()
  })

  test('running → settled：折叠头换成「思考了 N」（终值由 cleanup 落，reduced-motion 下同样有）', async () => {
    const { rerender } = render(<ReasoningText {...reasoning('推理中…', true)} />)
    await waitFor(() => expect(screen.getByText('思考中…')).toBeTruthy())
    // 运行中只说「思考中…」，不预告一个还没定的数。
    expect(screen.queryByText(/思考了/)).toBeNull()

    rerender(<ReasoningText {...reasoning('推理完了。', false)} />)
    await waitFor(() => expect(screen.getByText(/^思考了 \d+(\.\d)?[sm]/)).toBeTruthy())
    expect(screen.queryByText('思考过程')).toBeNull()
  })
})
