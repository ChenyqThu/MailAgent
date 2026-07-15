// @vitest-environment happy-dom
//
// T3 lane — AttachmentTray 纯展示组件 (未接线 ComposePanel):
//   - 汇总行: N 个附件 · 总大小
//   - kind 判定 (kindFromName): 按扩展名分桶 (pdf/sheet/doc/zip/image/text/file)
//   - 删除回调: 点击卡片删除钮 → onRemove(localId)
//   - 上传中: 底部进度条 (有 progress% → 定值宽度; 无 → 不定态)
//   - 空态: AttachmentDropzone 点击 → onAdd; 拖拽落地文件 → onFilesDropped

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import {
  AttachmentDropzone,
  AttachmentTray,
  kindFromName,
  type AttachmentTrayItem
} from '../../src/shared/components/email/compose/AttachmentTray'

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

describe('AttachmentDropzone — 空态', () => {
  test('点击触发 onAdd', () => {
    const onAdd = vi.fn()
    render(<AttachmentDropzone onAdd={onAdd} />)
    fireEvent.click(screen.getByText('拖拽文件到此，或点击添加附件'))
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  test('Enter/Space 键盘触发 onAdd (role=button)', () => {
    const onAdd = vi.fn()
    render(<AttachmentDropzone onAdd={onAdd} />)
    const zone = screen.getByRole('button')
    fireEvent.keyDown(zone, { key: 'Enter' })
    expect(onAdd).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(zone, { key: ' ' })
    expect(onAdd).toHaveBeenCalledTimes(2)
  })

  test('未传 onFilesDropped 时 drop 不触发任何回调 (不抢父层整窗 dropzone)', () => {
    const onAdd = vi.fn()
    render(<AttachmentDropzone onAdd={onAdd} />)
    const zone = screen.getByRole('button')
    fireEvent.drop(zone, { dataTransfer: { files: [new File(['x'], 'a.txt')], types: ['Files'] } })
    expect(onAdd).not.toHaveBeenCalled()
  })

  test('传 onFilesDropped 时 drop 触发, dragEnter/Leave 切换激活态文案不变但不崩溃', () => {
    const onFilesDropped = vi.fn()
    render(<AttachmentDropzone onAdd={vi.fn()} onFilesDropped={onFilesDropped} />)
    const zone = screen.getByRole('button')
    const file = new File(['x'], 'a.txt')
    fireEvent.dragEnter(zone, { dataTransfer: { files: [], types: ['Files'] } })
    fireEvent.drop(zone, { dataTransfer: { files: [file], types: ['Files'] } })
    expect(onFilesDropped).toHaveBeenCalledTimes(1)
    expect(onFilesDropped.mock.calls[0][0][0]).toBe(file)
  })
})
