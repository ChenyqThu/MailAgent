// @vitest-environment happy-dom

// 快捷反馈弹窗的接线测试（task 08-27 P4a）。
//
// 只测**只有真渲染才会暴露**的三件，且每一条断言的都是 `submit` 收到的 payload —— 断言 UI
// class 抓不到「界面上撤掉了、payload 里还带着」这类静默错：
//   ① 复现频率只在「问题」类进 payload（换成建议后整个字段不出现）；
//   ② 第二步「撤掉」截图 / 诊断包，payload 里对应的键真的消失；
//   ③ 🔴 提交失败必须显示「没发出去」+ 降级入口，绝不能显示成回执。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import i18n from '../../src/shared/i18n'
import { useFeedbackStore } from '../../src/shared/state/feedback'

await i18n.changeLanguage('zh-CN')

const hoisted = vi.hoisted(() => ({
  submit: vi.fn(),
  capture: vi.fn(),
  diagnostics: vi.fn(),
  openForm: vi.fn(),
  context: vi.fn()
}))

vi.mock('@tanstack/react-router', () => ({
  useRouterState: () => '/settings'
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    feedback: {
      context: hoisted.context,
      capture: hoisted.capture,
      diagnostics: hoisted.diagnostics,
      submit: hoisted.submit,
      recent: vi.fn(),
      openForm: hoisted.openForm
    }
  })
}))

const { FeedbackDialog } = await import('../../src/shared/components/feedback/FeedbackDialog')

function reset(): void {
  hoisted.submit.mockReset().mockResolvedValue({ submissionBlockId: 'blk-9' })
  hoisted.capture
    .mockReset()
    .mockResolvedValue({ name: 's.png', type: 'image/png', dataBase64: 'AAA', bytes: 3 })
  hoisted.diagnostics
    .mockReset()
    .mockResolvedValue({ path: '/tmp/x/diag.zip', name: 'diag.zip', bytes: 1024 })
  hoisted.openForm.mockReset()
  hoisted.context.mockReset().mockResolvedValue('2.26.0 · darwin · /settings')
  useFeedbackStore.setState({ open: true, attachDiagnosticsDefault: false })
}

afterEach(() => {
  cleanup()
  useFeedbackStore.setState({ open: false })
})

/** 填标题 → 下一步 → 等第二步渲染完。 */
async function fillAndAdvance(title = '切换标签后正文停在上一封'): Promise<void> {
  fireEvent.change(screen.getByLabelText('标题'), { target: { value: title } })
  fireEvent.click(screen.getByText('下一步'))
  await screen.findByText('自动带上的运行环境')
}

describe('FeedbackDialog — payload', () => {
  test('① 问题类：复现频率进 payload', async () => {
    reset()
    render(<FeedbackDialog />)
    fireEvent.click(screen.getByText('每次必现'))
    await fillAndAdvance()
    fireEvent.click(screen.getByText('发送'))
    await waitFor(() => expect(hoisted.submit).toHaveBeenCalled())
    expect(hoisted.submit.mock.calls[0][0]).toMatchObject({ kind: '问题', freq: '每次必现' })
  })

  test('① bis 建议类：payload 里没有复现频率（断言 payload，不是断言 UI）', async () => {
    reset()
    render(<FeedbackDialog />)
    // 先在「问题」态选一个频率，再切到「建议」—— 这样才测得到「切类型要把它丢掉」，
    // 只测「建议态没有频率按钮」是恒绿装饰（那个 state 初值本来就没被读）。
    fireEvent.click(screen.getByText('每次必现'))
    fireEvent.click(screen.getByText('建议'))
    await fillAndAdvance('希望标签能拖拽排序')
    fireEvent.click(screen.getByText('发送'))
    await waitFor(() => expect(hoisted.submit).toHaveBeenCalled())
    expect(hoisted.submit.mock.calls[0][0].freq).toBeUndefined()
    expect(hoisted.submit.mock.calls[0][0].kind).toBe('建议')
  })

  test('② 撤掉截图 → payload 里没有 screenshotBase64', async () => {
    reset()
    render(<FeedbackDialog />)
    await fillAndAdvance()
    // 带着截图的那一版先确认存在，再撤掉 —— 否则「本来就没带」也会让断言绿。
    await screen.findByAltText('界面截图')
    fireEvent.click(screen.getAllByText('撤掉')[0])
    fireEvent.click(screen.getByText('发送'))
    await waitFor(() => expect(hoisted.submit).toHaveBeenCalled())
    expect(hoisted.submit.mock.calls[0][0].screenshotBase64).toBeUndefined()
  })

  test('② bis 不撤 → payload 里带着截图（上一条的对照组）', async () => {
    reset()
    render(<FeedbackDialog />)
    await fillAndAdvance()
    await screen.findByAltText('界面截图')
    fireEvent.click(screen.getByText('发送'))
    await waitFor(() => expect(hoisted.submit).toHaveBeenCalled())
    expect(hoisted.submit.mock.calls[0][0].screenshotBase64).toBe('AAA')
  })

  test('② ter 勾了诊断包 → 第二步才组装，撤掉后 payload 里没有路径', async () => {
    reset()
    useFeedbackStore.setState({ attachDiagnosticsDefault: true })
    render(<FeedbackDialog />)
    // 第一步不该组装（约 1 分钟，不能白花）。
    expect(hoisted.diagnostics).not.toHaveBeenCalled()
    await fillAndAdvance()
    await waitFor(() => expect(hoisted.diagnostics).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getAllByText('撤掉')[1])
    fireEvent.click(screen.getByText('发送'))
    await waitFor(() => expect(hoisted.submit).toHaveBeenCalled())
    expect(hoisted.submit.mock.calls[0][0].diagnosticsPath).toBeUndefined()
  })
})

describe('FeedbackDialog — 🔴 失败可见', () => {
  test('提交失败 → 显示「没发出去」+「打开表单页」降级，不显示回执', async () => {
    reset()
    hoisted.submit.mockRejectedValue(new Error('feedback submit failed (status 403)'))
    render(<FeedbackDialog />)
    await fillAndAdvance()
    fireEvent.click(screen.getByText('发送'))
    await screen.findByText(/没发出去/)
    // 回执文案一个字都不该出现。
    expect(screen.queryByText(/已提交，编号/)).toBeNull()
    fireEvent.click(screen.getByText('打开表单页手动提交'))
    expect(hoisted.openForm).toHaveBeenCalled()
  })

  test('成功 → 给编号回执', async () => {
    reset()
    render(<FeedbackDialog />)
    await fillAndAdvance()
    fireEvent.click(screen.getByText('发送'))
    await screen.findByText(/blk-9/)
  })
})
