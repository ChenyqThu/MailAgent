// @vitest-environment happy-dom

// 快捷反馈弹窗的接线测试（task 08-27 P4a + 08-31 dogfood 修正）。
//
// 只测**只有真渲染才会暴露**的事，且每一条断言的都是 `submit` 收到的 payload —— 断言 UI
// class 抓不到「界面上撤掉了、payload 里还带着」这类静默错：
//   ① 复现频率只在「问题」类进 payload（换成建议后整个字段不出现）；
//   ② 图片：粘贴 / 选文件进 payload，撤掉后真的少一张；
//   ③ 撤掉诊断包 → payload 里没有路径；
//   ④ 版本那一行看得见（owner dogfood 说「没做」的根因是它藏在末尾灰字里）；
//   ⑤ 邮箱预填当前账户邮箱，且用户改过之后不被 settings 覆盖；
//   ⑥ 🔴 提交失败必须显示「没发出去」+ 降级入口，绝不能显示成回执。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import i18n from '../../src/shared/i18n'
import { useFeedbackStore } from '../../src/shared/state/feedback'

await i18n.changeLanguage('zh-CN')

const hoisted = vi.hoisted(() => ({
  submit: vi.fn(),
  diagnostics: vi.fn(),
  openForm: vi.fn(),
  context: vi.fn(),
  settingsGet: vi.fn()
}))

vi.mock('@tanstack/react-router', () => ({
  useRouterState: () => '/settings'
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    settings: { get: hoisted.settingsGet },
    feedback: {
      context: hoisted.context,
      diagnostics: hoisted.diagnostics,
      submit: hoisted.submit,
      recent: vi.fn(),
      openForm: hoisted.openForm
    }
  })
}))

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { FeedbackDialog } = await import('../../src/shared/components/feedback/FeedbackDialog')
const { readableIpcError } = await import('../../src/shared/lib/ipcErrors')

function renderDialog(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <FeedbackDialog />
    </QueryClientProvider>
  )
}

function reset(): void {
  hoisted.submit.mockReset().mockResolvedValue({ submissionBlockId: 'blk-9' })
  hoisted.diagnostics
    .mockReset()
    .mockResolvedValue({ path: '/tmp/x/diag.zip', name: 'diag.zip', bytes: 1024 })
  hoisted.openForm.mockReset()
  hoisted.context.mockReset().mockResolvedValue('2.27.0 · darwin · /settings')
  hoisted.settingsGet.mockReset().mockResolvedValue({ userEmail: 'owner@omadanetworks.com' })
  useFeedbackStore.setState({ open: true, attachDiagnosticsDefault: false })
}

afterEach(() => {
  cleanup()
  useFeedbackStore.setState({ open: false })
})

/** happy-dom 的 File 没有 arrayBuffer 的真实实现路径，给一个够用的。 */
function pngFile(name: string, bytes = [1, 2, 3]): File {
  const file = new File([new Uint8Array(bytes)], name, { type: 'image/png' })
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => new Uint8Array(bytes).buffer
  })
  return file
}

/** 填标题 → 下一步 → 等第二步渲染完。 */
async function fillAndAdvance(title = '切换标签后正文停在上一封'): Promise<void> {
  fireEvent.change(screen.getByLabelText('标题'), { target: { value: title } })
  fireEvent.click(screen.getByText('下一步'))
  await screen.findByText('自动带上的运行环境')
}

describe('FeedbackDialog — payload', () => {
  test('① 问题类：复现频率进 payload', async () => {
    reset()
    renderDialog()
    fireEvent.click(screen.getByText('每次必现'))
    await fillAndAdvance()
    fireEvent.click(screen.getByText('发送'))
    await waitFor(() => expect(hoisted.submit).toHaveBeenCalled())
    expect(hoisted.submit.mock.calls[0][0]).toMatchObject({ kind: '问题', freq: '每次必现' })
  })

  test('① bis 建议类：payload 里没有复现频率（断言 payload，不是断言 UI）', async () => {
    reset()
    renderDialog()
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

  test('② 选进来的图片进 payload（多张，带文件名与类型）', async () => {
    reset()
    renderDialog()
    fireEvent.change(screen.getByLabelText('图片'), {
      target: { files: [pngFile('a.png'), pngFile('b.png', [9])] }
    })
    await screen.findByAltText('a.png')
    await fillAndAdvance()
    fireEvent.click(screen.getByText('发送'))
    await waitFor(() => expect(hoisted.submit).toHaveBeenCalled())
    expect(hoisted.submit.mock.calls[0][0].images).toEqual([
      { name: 'a.png', type: 'image/png', dataBase64: 'AQID' },
      { name: 'b.png', type: 'image/png', dataBase64: 'CQ==' }
    ])
  })

  test('② bis 粘贴（⌘V）也进 payload —— 这是删掉「截取当前屏幕」后的主路径', async () => {
    reset()
    renderDialog()
    fireEvent.paste(screen.getByLabelText('标题'), {
      clipboardData: { files: [pngFile('paste.png')] }
    })
    await screen.findByAltText('paste.png')
    await fillAndAdvance()
    fireEvent.click(screen.getByText('发送'))
    await waitFor(() => expect(hoisted.submit).toHaveBeenCalled())
    expect(hoisted.submit.mock.calls[0][0].images).toHaveLength(1)
  })

  test('② ter 撤掉那一张 → payload 里整个 images 键都不在（对照组在上面）', async () => {
    reset()
    renderDialog()
    fireEvent.change(screen.getByLabelText('图片'), { target: { files: [pngFile('a.png')] } })
    await screen.findByAltText('a.png')
    await fillAndAdvance()
    fireEvent.click(screen.getAllByLabelText('撤掉 a.png')[0])
    fireEvent.click(screen.getByText('发送'))
    await waitFor(() => expect(hoisted.submit).toHaveBeenCalled())
    expect(hoisted.submit.mock.calls[0][0].images).toBeUndefined()
  })

  test('③ 勾了诊断包 → 第二步才组装，撤掉后 payload 里没有路径', async () => {
    reset()
    useFeedbackStore.setState({ attachDiagnosticsDefault: true })
    renderDialog()
    // 第一步不该组装（约 1 分钟，不能白花）。
    expect(hoisted.diagnostics).not.toHaveBeenCalled()
    await fillAndAdvance()
    await waitFor(() => expect(hoisted.diagnostics).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByText('撤掉'))
    fireEvent.click(screen.getByText('发送'))
    await waitFor(() => expect(hoisted.submit).toHaveBeenCalled())
    expect(hoisted.submit.mock.calls[0][0].diagnosticsPath).toBeUndefined()
  })

  test('③ ter 设置里那一行是关的 → 第二步也不组装，payload 里没有诊断包', async () => {
    reset() // attachDiagnosticsDefault: false —— 「通用 › 诊断」那一行的出厂值
    renderDialog()
    await fillAndAdvance()
    fireEvent.click(screen.getByText('发送'))
    await waitFor(() => expect(hoisted.submit).toHaveBeenCalled())
    expect(hoisted.diagnostics).not.toHaveBeenCalled()
    expect(hoisted.submit.mock.calls[0][0].diagnosticsPath).toBeUndefined()
  })

  test('③ bis 不撤 → 路径进 payload（上一条的对照组）', async () => {
    reset()
    useFeedbackStore.setState({ attachDiagnosticsDefault: true })
    renderDialog()
    await fillAndAdvance()
    await waitFor(() => expect(hoisted.diagnostics).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByText('发送'))
    await waitFor(() => expect(hoisted.submit).toHaveBeenCalled())
    expect(hoisted.submit.mock.calls[0][0].diagnosticsPath).toBe('/tmp/x/diag.zip')
  })
})

describe('FeedbackDialog — 自动带上的两项（08-31 dogfood：owner 以为「都没做」）', () => {
  test('④ 版本那一行在第一步就看得见，且与实发的是同一份', async () => {
    reset()
    renderDialog()
    // 🔴 断言的是**第一步**（还没点下一步）—— 它以前只在末尾一行灰字里出现过。
    expect(await screen.findByText('2.27.0 · darwin · /settings')).toBeTruthy()
    expect(screen.queryByText('下一步')).toBeTruthy()
    await fillAndAdvance()
    fireEvent.click(screen.getByText('发送'))
    await waitFor(() => expect(hoisted.submit).toHaveBeenCalled())
    // 版本串由主进程算（route 传过去，回来的那一行就是写进 payload 的那一行）。
    expect(hoisted.submit.mock.calls[0][0].route).toBe('/settings')
  })

  test('⑤ 邮箱预填当前账户邮箱，并原样进 payload', async () => {
    reset()
    renderDialog()
    await waitFor(() =>
      expect((screen.getByLabelText('邮箱（选填）') as HTMLInputElement).value).toBe(
        'owner@omadanetworks.com'
      )
    )
    await fillAndAdvance()
    fireEvent.click(screen.getByText('发送'))
    await waitFor(() => expect(hoisted.submit).toHaveBeenCalled())
    expect(hoisted.submit.mock.calls[0][0].email).toBe('owner@omadanetworks.com')
  })

  test('⑤ bis 用户改过之后以用户填的为准（预填不能反过来盖掉他敲的字）', async () => {
    reset()
    renderDialog()
    await waitFor(() =>
      expect((screen.getByLabelText('邮箱（选填）') as HTMLInputElement).value).toBe(
        'owner@omadanetworks.com'
      )
    )
    fireEvent.change(screen.getByLabelText('邮箱（选填）'), { target: { value: 'me@else.com' } })
    await fillAndAdvance()
    fireEvent.click(screen.getByText('发送'))
    await waitFor(() => expect(hoisted.submit).toHaveBeenCalled())
    expect(hoisted.submit.mock.calls[0][0].email).toBe('me@else.com')
  })

  test('⑤ ter 取不到账户邮箱时留空（不编一个假的出来）', async () => {
    reset()
    hoisted.settingsGet.mockResolvedValue({ userEmail: null })
    renderDialog()
    await fillAndAdvance()
    fireEvent.click(screen.getByText('发送'))
    await waitFor(() => expect(hoisted.submit).toHaveBeenCalled())
    expect(hoisted.submit.mock.calls[0][0].email).toBeUndefined()
  })
})

describe('FeedbackDialog — 🔴 失败可见', () => {
  test('提交失败 → 显示「没发出去」+「打开表单页」降级，不显示回执', async () => {
    reset()
    hoisted.submit.mockRejectedValue(new Error('feedback submit failed (status 403)'))
    renderDialog()
    await fillAndAdvance()
    fireEvent.click(screen.getByText('发送'))
    await screen.findByText(/没发出去/)
    // 回执文案一个字都不该出现。
    expect(screen.queryByText(/已提交，编号/)).toBeNull()
    fireEvent.click(screen.getByText('打开表单页手动提交'))
    expect(hoisted.openForm).toHaveBeenCalled()
  })

  test('🔴 上传被拒的真实形状：原因要露出来，不是一句 status 400', async () => {
    reset()
    hoisted.submit.mockRejectedValue(
      new Error(
        "Error invoking remote method 'feedback:submit': FeedbackSubmitError: " +
          'feedback upload failed (status 400): Uploading .zip files is not allowed'
      )
    )
    renderDialog()
    await fillAndAdvance()
    fireEvent.click(screen.getByText('发送'))
    await screen.findByText(/Uploading \.zip files is not allowed/)
    // Electron 的 IPC 包装层不该出现在用户眼前。
    expect(screen.queryByText(/invoking remote method/)).toBeNull()
  })

  test('成功 → 给编号回执', async () => {
    reset()
    renderDialog()
    await fillAndAdvance()
    fireEvent.click(screen.getByText('发送'))
    await screen.findByText(/blk-9/)
  })

  test('🔴 发完再打开是全新一份表单，不是上一条的回执页', async () => {
    reset()
    renderDialog()
    await fillAndAdvance('第一条')
    fireEvent.click(screen.getByText('发送'))
    await screen.findByText(/blk-9/)

    // 🔴 走真入口（closeDialog / openDialog），不是 setState({open}) —— 「重开是全新一份」
    // 靠的是 openDialog 递增的 openSeq；直接改 open 测不到，那才是恒绿装饰。
    useFeedbackStore.getState().closeDialog()
    useFeedbackStore.getState().openDialog()

    // 回执页只有「关闭」按钮，停在那里等于第二条反馈发不出去。
    await waitFor(() => expect(screen.queryByText(/blk-9/)).toBeNull())
    expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('')
  })
})

describe('readableIpcError —— 界面上不该出现 Electron 的 IPC 包装层', () => {
  test('剥掉 IPC 与异常类名两层壳，只留原因', () => {
    expect(
      readableIpcError(
        new Error(
          "Error invoking remote method 'feedback:submit': FeedbackSubmitError: upload failed"
        )
      )
    ).toBe('upload failed')
  })

  test('本来就干净的原样返回', () => {
    expect(readableIpcError(new Error('ECONNREFUSED'))).toBe('ECONNREFUSED')
  })
})
