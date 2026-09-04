// @vitest-environment happy-dom
//
// 报告「导出到资料库」的接线。序列化本身在 reportMarkdown.test.ts 里逐块盯，这里只验三件
// 在组件这一层才成立的事：
//   · 选完文件夹后**真的**往 `POST /library/files` 写了正文（parent_path / 文件名 / source）；
//   · 🔴 回执带「打开」深链 —— 没有去处的回执一律视为缺陷（design §9.5）；
//   · 🔴 重名（服务端恒 409 `E_VERSION_CONFLICT`）自动退让一个序号，且**回执写的是最终
//     用上的那个名字** —— 否则用户会照着回执去找一个不存在的文件。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { LibraryCreateTextFile } from '@shared/api/library'
import type { ReportDoc } from '@shared/api/types'

const hoisted = vi.hoisted(() => ({
  createTextFile: vi.fn(),
  invalidateAll: vi.fn(() => Promise.resolve())
}))

vi.mock('@shared/components/library/hooks', () => ({
  useLibraryApi: () => ({ createTextFile: hoisted.createTextFile }),
  useInvalidateLibrary: () => ({ all: hoisted.invalidateAll })
}))
// 选择器自己有树查询（react-query），这里只要「确认了某个目标路径」这一个事件。
vi.mock('@shared/components/library/FolderPickerDialog', () => ({
  FolderPickerDialog: ({ onConfirm }: { onConfirm(path: string): void }): React.ReactElement => (
    <button type="button" data-testid="pick" onClick={() => onConfirm('文档/报告')}>
      pick
    </button>
  )
}))

import i18n from '@shared/i18n'
import { useToastStore, __resetToastStore } from '@shared/state/toast'
import { ReportExportButton } from '@shared/components/agents/ReportExportButton'

await i18n.changeLanguage('zh-CN')

const DOC = {
  version: 1,
  agent_id: 'daily',
  cadence: 'daily',
  report_date: '2026-09-03',
  window: { start: '', end: '' },
  generated_at: '2026-09-03T09:12:00',
  model: 'claude-opus-5',
  blocks: [
    { type: 'header', title: '今日邮件' },
    { type: 'overview', text: '没什么大事。' }
  ]
} as unknown as ReportDoc

function conflict(): Error & { code: string } {
  const err = new Error('already exists: 文档/报告/今日邮件 2026-09-03.md') as Error & {
    code: string
  }
  err.code = 'E_VERSION_CONFLICT'
  return err
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.clearAllMocks()
  __resetToastStore()
})
afterEach(() => cleanup())

describe('导出到资料库', () => {
  test('选完文件夹 → 写入选中路径，正文是序列化后的 markdown，source=user', async () => {
    hoisted.createTextFile.mockResolvedValue({ id: 77, filename: '今日邮件 2026-09-03.md' })
    render(<ReportExportButton doc={DOC} fallbackTitle="兜底" />)
    fireEvent.click(screen.getByText('导出到资料库'))
    fireEvent.click(screen.getByTestId('pick'))
    await flush()

    const input = hoisted.createTextFile.mock.calls[0][0] as LibraryCreateTextFile
    expect(input.parent_path).toBe('文档/报告')
    expect(input.filename).toBe('今日邮件 2026-09-03.md')
    expect(input.content).toBe('# 今日邮件\n\n没什么大事。\n')
    expect(input.source).toBe('user')
    // report 不属于服务端定义过的任何一种 source_ref 语义，不许自造前缀（会被 422 打回）。
    expect(input.source_ref).toBeUndefined()
  })

  test('成功回执带「打开」深链', async () => {
    hoisted.createTextFile.mockResolvedValue({ id: 77, filename: '今日邮件 2026-09-03.md' })
    render(<ReportExportButton doc={DOC} fallbackTitle="兜底" />)
    fireEvent.click(screen.getByText('导出到资料库'))
    fireEvent.click(screen.getByTestId('pick'))
    await flush()

    const toast = useToastStore.getState().items.at(-1)
    expect(toast?.variant).toBe('success')
    expect(toast?.title).toContain('今日邮件 2026-09-03.md')
    expect(toast?.action?.label).toBe('打开')
  })

  test('🔴 重名 409 → 退让到「(2)」，回执写的是最终用上的名字', async () => {
    hoisted.createTextFile
      .mockRejectedValueOnce(conflict())
      .mockResolvedValueOnce({ id: 78, filename: '今日邮件 2026-09-03 (2).md' })
    render(<ReportExportButton doc={DOC} fallbackTitle="兜底" />)
    fireEvent.click(screen.getByText('导出到资料库'))
    fireEvent.click(screen.getByTestId('pick'))
    await flush()

    expect(
      hoisted.createTextFile.mock.calls.map((c) => (c[0] as LibraryCreateTextFile).filename)
    ).toEqual(['今日邮件 2026-09-03.md', '今日邮件 2026-09-03 (2).md'])
    expect(useToastStore.getState().items.at(-1)?.title).toContain('今日邮件 2026-09-03 (2).md')
  })

  test('非重名的失败照实报错，不退让重试', async () => {
    const denied = new Error('read-only') as Error & { code: string }
    denied.code = 'E_AUTH_FAILED'
    hoisted.createTextFile.mockRejectedValue(denied)
    render(<ReportExportButton doc={DOC} fallbackTitle="兜底" />)
    fireEvent.click(screen.getByText('导出到资料库'))
    fireEvent.click(screen.getByTestId('pick'))
    await flush()

    expect(hoisted.createTextFile).toHaveBeenCalledTimes(1)
    const toast = useToastStore.getState().items.at(-1)
    expect(toast?.variant).toBe('error')
    expect(toast?.detail).toContain('read-only')
  })
})
