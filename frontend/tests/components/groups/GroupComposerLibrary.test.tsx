// @vitest-environment happy-dom
//
// P2-L13 群聊 @ 资料 —— GroupComposer 自写的 `@` 弹层第二组「资料」。
//
// 钉住四件（design §9.3 (b)）：
//   L1 输入 `@词` → 弹层里除成员外多出资料组，行上是文件名 + 虚拟路径；
//   L2 🔴 投影行（mail-attachments，`id: null`）被滤掉 —— 给出去成员也 library_read 不开；
//   L3 选中 → 正文里落 `@名称 `，发送时 onSend 第三参带上 `{fileId, path, name}`；
//   L4 🔴 选完又把那段字删掉 → 引用不跟着走（正文是唯一权威）。
//
// mock 面只有两处：`createLibraryApi`（不打真 HTTP）与 `AgentAvatar`（头像不是本测的事）。
// 弹层、防抖、剪枝、发送全走真实现。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'

const mockSearch = vi.fn()
vi.mock('@shared/api/library', () => ({
  createLibraryApi: () => ({ search: mockSearch })
}))
vi.mock('@shared/components/agents/AgentAvatar', () => ({
  AgentAvatar: ({ title }: { title?: string }) => createElement('span', null, title ?? '')
}))

import { GroupComposer } from '@shared/components/agents/groups/GroupComposer'

const MEMBERS = [{ agentId: 'a1', title: '策划' }]

/** `LibraryFile & {snippet, rank, match}` 里本组件真正读的三列；其余列这里不造。 */
function hit(id: number | null, path: string, filename: string) {
  return { id, path, filename }
}

type SendRefs = { fileId: number; path: string; name: string }[]
/** onSend 的形参在这里标全，`mock.calls[0]` 才带类型 —— 否则它是空元组，
 *  下面两处只能靠 `as [...]` 硬转，而 TS2352 会拦住「空元组转三元组」。 */
function renderComposer(
  onSend = vi.fn(async (_text: string, _attachments: unknown[], _refs: SendRefs) => undefined)
) {
  render(
    createElement(GroupComposer, {
      onSend,
      sending: false,
      disabled: false,
      members: MEMBERS,
      modes: null,
      labsOn: false,
      labsLoading: false,
      realtimeCount: null,
      runAlive: false
    })
  )
  return { onSend, input: screen.getByRole('textbox') as HTMLTextAreaElement }
}

/** 打一段 `@词`，等资料组出现。 */
async function typeMention(input: HTMLTextAreaElement, value: string) {
  fireEvent.change(input, { target: { value } })
  await waitFor(() => expect(mockSearch).toHaveBeenCalled(), { timeout: 2000 })
}

beforeEach(() => {
  mockSearch.mockReset()
  mockSearch.mockResolvedValue({ query: '', mode: 'like', hits: [], warnings: [] })
})
afterEach(cleanup)

describe('GroupComposer — @ 资料组', () => {
  test('L1 资料命中作为一组出现在成员之后，行上是文件名 + 路径', async () => {
    mockSearch.mockResolvedValue({
      query: '报价',
      mode: 'like',
      hits: [hit(42, 'my-docs/报价单.pdf', '报价单.pdf')],
      warnings: []
    })
    const { input } = renderComposer()
    await typeMention(input, '@报价')
    await waitFor(() => expect(screen.getByText('报价单.pdf')).toBeTruthy())
    expect(screen.getByText('my-docs/报价单.pdf')).toBeTruthy()
    expect(mockSearch).toHaveBeenCalledWith('报价', expect.any(Number))
  })

  test('L2 🔴 投影行（id 为 null）不进弹层', async () => {
    mockSearch.mockResolvedValue({
      query: '合同',
      mode: 'like',
      hits: [
        hit(null, 'mail-attachments/2026-09/合同.pdf', '合同.pdf'),
        hit(7, 'my-docs/合同备份.pdf', '合同备份.pdf')
      ],
      warnings: []
    })
    const { input } = renderComposer()
    await typeMention(input, '@合同')
    await waitFor(() => expect(screen.getByText('合同备份.pdf')).toBeTruthy())
    expect(screen.queryByText('合同.pdf')).toBeNull()
    expect(screen.queryByText('mail-attachments/2026-09/合同.pdf')).toBeNull()
  })

  test('L3 选中后正文落 @名称，发送时第三参带 {fileId, path, name}', async () => {
    mockSearch.mockResolvedValue({
      query: '报价',
      mode: 'like',
      hits: [hit(42, 'my-docs/报价单.pdf', '报价单.pdf')],
      warnings: []
    })
    const { onSend, input } = renderComposer()
    await typeMention(input, '@报价')
    await waitFor(() => expect(screen.getByText('报价单.pdf')).toBeTruthy())
    fireEvent.click(screen.getByText('报价单.pdf'))
    await waitFor(() => expect(input.value).toContain('@报价单.pdf'))

    fireEvent.change(input, { target: { value: `${input.value}看看这个` } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    const [text, attachments, refs] = onSend.mock.calls[0]
    expect(text).toContain('@报价单.pdf')
    expect(attachments).toEqual([])
    expect(refs).toEqual([{ fileId: 42, path: 'my-docs/报价单.pdf', name: '报价单.pdf' }])
  })

  test('L4 🔴 选完又把那段字删掉 → 引用不跟着走', async () => {
    mockSearch.mockResolvedValue({
      query: '报价',
      mode: 'like',
      hits: [hit(42, 'my-docs/报价单.pdf', '报价单.pdf')],
      warnings: []
    })
    const { onSend, input } = renderComposer()
    await typeMention(input, '@报价')
    await waitFor(() => expect(screen.getByText('报价单.pdf')).toBeTruthy())
    fireEvent.click(screen.getByText('报价单.pdf'))
    await waitFor(() => expect(input.value).toContain('@报价单.pdf'))

    // 用户把引用那段删掉，只留自己的话。
    fireEvent.change(input, { target: { value: '算了，换个说法' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    const [, , refs] = onSend.mock.calls[0]
    expect(refs).toEqual([])
  })
})
