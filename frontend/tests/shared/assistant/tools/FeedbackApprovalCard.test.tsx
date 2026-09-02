// @vitest-environment happy-dom
//
// task 09-02 — FeedbackApprovalCard 的**执行态**。owner dogfood 里「反馈会卡住」的实际形态是：
// 完全授权模式免卡 → part 上没有 approval 对象 → 卡片在诊断包组装的 70 多秒里显示「已完成」
// 却空无一物。这里锁两件事：authorized 相位下要有那句「正在组装诊断包」的提示，done（真收到
// 结果）时它必须消失 —— 后者是防提示行赖着不走的反向断言。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import { FeedbackApprovalCard } from '@shared/assistant/tools/generic/FeedbackApprovalCard'

await i18n.changeLanguage('zh-CN')

function mockProps(over: Partial<ToolCallMessagePartProps>): ToolCallMessagePartProps {
  return {
    type: 'tool-call',
    toolName: 'submit_feedback',
    toolCallId: 'tc-fb-1',
    args: {
      kind: '问题',
      title: '通知点进去跳错地方',
      detail: '点通知落到 AI 分段，左侧列表里根本没有那条会话。',
      freq: '每次',
      attach_diagnostics: true
    },
    argsText: '{}',
    result: undefined,
    isError: undefined,
    // 免卡执行中：上游只给 running，approval 整个不存在。
    status: { type: 'running' },
    approval: undefined,
    addResult: vi.fn(),
    resume: vi.fn(),
    respondToApproval: vi.fn(),
    ...over
  } as unknown as ToolCallMessagePartProps
}

afterEach(() => {
  cleanup()
})

describe('FeedbackApprovalCard — 执行中（authorized）', () => {
  test('带诊断包 → 参数表 + 「正在组装诊断包」提示', () => {
    const { container } = render(<FeedbackApprovalCard {...mockProps({})} />)
    expect(screen.getByText('通知点进去跳错地方')).toBeTruthy()
    const hint = container.querySelector('[data-diagnostics-hint]')
    expect(hint).not.toBeNull()
    expect(hint?.textContent).toBe('正在组装诊断包，通常需要几十秒')
  })

  test('不带诊断包 → 没有提示行（不等的那条路不该冒出一句「正在组装」）', () => {
    const { container } = render(
      <FeedbackApprovalCard
        {...mockProps({
          args: { kind: '建议', title: '换个图标', attach_diagnostics: false }
        })}
      />
    )
    expect(container.querySelector('[data-diagnostics-hint]')).toBeNull()
  })
})

describe('FeedbackApprovalCard — 已完成（done）', () => {
  test('拿到结果后提示行消失，只剩「已提交」', () => {
    const { container } = render(
      <FeedbackApprovalCard
        {...mockProps({
          status: { type: 'complete' },
          result: { submissionBlockId: '3cf15375-830d-8157-a031-e098d85443bd' }
        })}
      />
    )
    expect(container.querySelector('[data-diagnostics-hint]')).toBeNull()
    expect(screen.getByText(/已提交/)).toBeTruthy()
  })
})
