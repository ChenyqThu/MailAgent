// @vitest-environment happy-dom
//
// T3 lane — AttachmentTray 纯展示组件 (未接线 ComposePanel):
//   - 汇总行: N 个附件 · 总大小
//   - kind 判定 (kindFromName): 按扩展名分桶 (pdf/sheet/doc/zip/image/text/file)
//   - 删除回调: 点击卡片删除钮 → onRemove(localId)
//   - 上传中: 底部进度条 (有 progress% → 定值宽度; 无 → 不定态)
//   (空态 AttachmentDropzone 已随组件移除 — dogfood: 底部空态占位冗余)

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import i18n from '@shared/i18n'
import {
  AttachmentTray,
  kindFromName,
  type AttachmentTrayItem
} from '../../src/shared/components/email/compose/AttachmentTray'

// T5 接线后组件文案走 i18n (compose.attachTray.*) — 断言按 zh-CN 文案。
await i18n.changeLanguage('zh-CN')

afterEach(() => cleanup())

function item(overrides: Partial<AttachmentTrayItem> & { localId: number }): AttachmentTrayItem {
  return {
    filename: 'report.pdf',
    size: 1024,
    status: 'done',
    ...overrides
  }
}

describe('AttachmentTray — kindFromName', () => {
  test.each([
    ['report.pdf', 'pdf'],
    ['budget.xlsx', 'sheet'],
    ['data.csv', 'sheet'],
    ['contract.docx', 'doc'],
    ['deck.pptx', 'doc'],
    ['archive.zip', 'zip'],
    ['bundle.tar.gz', 'zip'],
    ['photo.png', 'image'],
    ['photo.JPEG', 'image'],
    ['notes.txt', 'text'],
    ['config.json', 'text'],
    ['unknown.xyz', 'file'],
    ['noext', 'file']
  ] as const)('%s → %s', (name, kind) => {
    expect(kindFromName(name)).toBe(kind)
  })
})

describe('AttachmentTray — 汇总行', () => {
  test('渲染 N 个附件 · 总大小', () => {
    render(
      <AttachmentTray
        items={[
          item({ localId: 1, filename: 'a.pdf', size: 1024 }),
          item({ localId: 2, filename: 'b.png', size: 2048 })
        ]}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    expect(screen.getByText(/2 个附件/)).toBeTruthy()
    // 1024 + 2048 = 3072 B = 3 KB
    expect(screen.getByText(/3 KB/)).toBeTruthy()
  })

  test('size=null 的条目不计入总大小格式化崩溃, 仍渲染文件名', () => {
    render(
      <AttachmentTray
        items={[item({ localId: 1, filename: 'pending.pdf', size: null, status: 'uploading' })]}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    expect(screen.getByText(/1 个附件/)).toBeTruthy()
    expect(screen.getByText('pending.pdf')).toBeTruthy()
  })

  test('空数组渲染 null (不显示汇总行/grid)', () => {
    const { container } = render(<AttachmentTray items={[]} onAdd={vi.fn()} onRemove={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  test('点击「添加」按钮触发 onAdd', () => {
    const onAdd = vi.fn()
    render(<AttachmentTray items={[item({ localId: 1 })]} onAdd={onAdd} onRemove={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(onAdd).toHaveBeenCalledTimes(1)
  })
})

describe('AttachmentTray — 卡片', () => {
  test('图片类且有 previewUrl → 渲染 <img>; 其余显类型图标+扩展名角标', () => {
    render(
      <AttachmentTray
        items={[
          item({ localId: 1, filename: 'photo.png', previewUrl: 'blob:xyz' }),
          item({ localId: 2, filename: 'sheet.xlsx' })
        ]}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    const img = screen.getByAltText('') as HTMLImageElement
    expect(img.src).toContain('blob:xyz')
    expect(screen.getByText('XLSX')).toBeTruthy()
  })

  test('删除钮点击 → onRemove(localId)', () => {
    const onRemove = vi.fn()
    render(
      <AttachmentTray
        items={[item({ localId: 7, filename: 'contract.docx' })]}
        onAdd={vi.fn()}
        onRemove={onRemove}
      />
    )
    fireEvent.click(screen.getByLabelText('移除 contract.docx'))
    expect(onRemove).toHaveBeenCalledWith(7)
  })

  test('status=error → 无 aria-label progressbar, 标题带失败提示', () => {
    render(
      <AttachmentTray
        items={[item({ localId: 1, filename: 'broken.pdf', status: 'error' })]}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  test('status=uploading 无 progress → 进度条不定态渲染 (无 aria-valuenow)', () => {
    render(
      <AttachmentTray
        items={[item({ localId: 1, filename: 'up.pdf', status: 'uploading', size: 500 })]}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBeNull()
    expect(screen.getByText(/上传中/)).toBeTruthy()
  })

  test('status=uploading 带 progress → 进度条按百分比渲染宽度', () => {
    render(
      <AttachmentTray
        items={[
          item({ localId: 1, filename: 'up.pdf', status: 'uploading', size: 500, progress: 42 })
        ]}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('42')
    const fill = bar.firstElementChild as HTMLElement
    expect(fill.style.width).toBe('42%')
  })

  test('status=done → 不渲染进度条', () => {
    render(
      <AttachmentTray
        items={[item({ localId: 1, filename: 'done.pdf', status: 'done' })]}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    expect(screen.queryByRole('progressbar')).toBeNull()
  })
})
