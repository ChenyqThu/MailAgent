// @vitest-environment happy-dom
//
// 挂载根的树内操作（task 09-03 P2-L6；design §8.2，mockup A3 / D1）。四组判据，每条错了在真 app 里
// 都是「摘不掉的根」「删了用户的文件」或「界面上漏出绝对路径」：
//   · 卸载 = `DELETE /library/mounts/{id}` 一条，**不碰任何文件端点**（F5：不删行、不动磁盘），
//     确认文案说的是「磁盘上的文件一个都不动」，不是作废的旧口径「只删索引」；
//   · 切只读 = `PATCH {mode:'ro'}` 直接发，**不因为有文件在编辑而拒绝**（F5 的另一半）；
//   · 不可用的挂载根（卷拔了）仍能右键并卸载 —— 否则那一根永远摘不掉；
//   · 树里一个绝对路径都不出现，且**根本不去调** `GET /library/mounts`（唯一带 abs_path 的端点）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const ABS_PATH = '/Users/someone/Documents/Omada/工作区'

const { api, pickFolder } = vi.hoisted(() => ({
  api: {
    tree: vi.fn(),
    mounts: vi.fn(),
    addMount: vi.fn(),
    patchMount: vi.fn(),
    removeMount: vi.fn(),
    trashFile: vi.fn(),
    moveFile: vi.fn()
  },
  pickFolder: vi.fn()
}))

vi.mock('@shared/api/library', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLibraryApi: () => api
}))
vi.mock('@shared/components/settings/custom-ai/shared', () => ({
  resolveApiBaseUrl: () => 'http://127.0.0.1:8200/api'
}))
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ settings: { pickFolder } })
}))

import i18n from '@shared/i18n'
import { LibraryTreePanel } from '@shared/components/library/LibraryTreePanel'
import type { LibraryMountSummary, LibraryTreeResponse } from '@shared/api/types/library'

await i18n.changeLanguage('en-US')

function mount(over: Partial<LibraryMountSummary> = {}): LibraryMountSummary {
  return {
    id: 7,
    label: '工作区',
    path: '@工作区',
    mode: 'rw',
    status: 'ok',
    file_count: 12,
    ...over
  }
}

function tree(mounts: LibraryMountSummary[]): LibraryTreeResponse {
  return {
    folders: [
      { path: 'my-docs', parent_path: '', name: 'my-docs', mount_id: 0, file_count: 2 },
      ...mounts.map((m) => ({
        path: m.path,
        parent_path: '',
        name: m.path,
        mount_id: m.id,
        file_count: m.file_count
      }))
    ],
    mounts,
    file_count: 14
  }
}

function renderTree(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={qc}>
      <LibraryTreePanel
        selectedPath="my-docs"
        expanded={new Set(['__mounts__'])}
        searchQuery=""
        onSearchChange={vi.fn()}
        onSelectFolder={vi.fn()}
        onExpandedChange={vi.fn()}
        onNewMarkdown={vi.fn()}
        onImportFiles={vi.fn()}
        onReveal={vi.fn()}
      />
    </QueryClientProvider>
  )
}

/** 右键挂载根，返回菜单里可见的动作名。 */
async function openMountMenu(): Promise<string[]> {
  const row = await screen.findByText('@工作区')
  fireEvent.contextMenu(row.closest('button') as HTMLElement)
  await screen.findByRole('menu')
  return Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).map(
    (el) => el.textContent?.trim() ?? ''
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  api.tree.mockResolvedValue(tree([mount()]))
  api.patchMount.mockResolvedValue({})
  api.removeMount.mockResolvedValue({})
  api.addMount.mockResolvedValue({})
})
afterEach(cleanup)

describe('挂载根节点菜单', () => {
  test('可写挂载根给出改名 / 切只读 / 访达 / 卸载四项', async () => {
    renderTree()
    expect(await openMountMenu()).toEqual([
      'Rename label',
      'Set to read-only',
      'Reveal in Finder',
      'Unmount'
    ])
  })

  test('只读挂载根照样能改名与切回可写（不被 readonly 短路吃掉）', async () => {
    api.tree.mockResolvedValue(tree([mount({ mode: 'ro' })]))
    renderTree()
    expect(await openMountMenu()).toContain('Set to writable')
  })

  test('不可用的挂载根只剩「卸载」，但那一项必须还在（否则这根摘不掉）', async () => {
    api.tree.mockResolvedValue(tree([mount({ status: 'unavailable' })]))
    renderTree()
    expect(await openMountMenu()).toEqual(['Unmount'])
  })
})

describe('卸载语义（F5：不删行、不动磁盘）', () => {
  test('确认文案讲的是「磁盘上的文件一个都不动」，不是「只删索引」', async () => {
    renderTree()
    await openMountMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unmount' }))

    const body = await screen.findByText(/Nothing on disk is touched/i)
    expect(body.textContent).toMatch(/gray out instead of breaking/i)
    expect(body.textContent).not.toMatch(/index only|only the index/i)
  })

  test('确认后只发 removeMount，一个文件端点都不碰', async () => {
    renderTree()
    await openMountMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unmount' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Unmount' }))

    await waitFor(() => expect(api.removeMount).toHaveBeenCalledWith(7))
    expect(api.trashFile).not.toHaveBeenCalled()
    expect(api.moveFile).not.toHaveBeenCalled()
  })

  test('取消 = 什么都不发', async () => {
    renderTree()
    await openMountMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unmount' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Unmount' })).toBeNull())
    expect(api.removeMount).not.toHaveBeenCalled()
  })
})

describe('切只读（F5：不拒切）', () => {
  test('点一下就 PATCH mode=ro，不弹「有文件正在编辑」之类的拦截', async () => {
    renderTree()
    await openMountMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set to read-only' }))

    await waitFor(() => expect(api.patchMount).toHaveBeenCalledWith(7, { mode: 'ro' }))
    // 中间没有任何确认对话框 —— 唯一的 dialog 角色只会来自卸载确认 / 改名。
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('只读态点「设为可写」发 mode=rw', async () => {
    api.tree.mockResolvedValue(tree([mount({ mode: 'ro' })]))
    renderTree()
    await openMountMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set to writable' }))

    await waitFor(() => expect(api.patchMount).toHaveBeenCalledWith(7, { mode: 'rw' }))
  })
})

describe('重命名标签', () => {
  test('改完发 PATCH label', async () => {
    renderTree()
    await openMountMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename label' }))

    const input = (await screen.findByRole('dialog')).querySelector('input') as HTMLInputElement
    expect(input.value).toBe('工作区')
    fireEvent.change(input, { target: { value: '招投标' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    await waitFor(() => expect(api.patchMount).toHaveBeenCalledWith(7, { label: '招投标' }))
  })
})

describe('添加文件夹', () => {
  test('走系统目录对话框 → 确认面板 → POST /library/mounts', async () => {
    pickFolder.mockResolvedValue(ABS_PATH)
    renderTree()
    fireEvent.click(await screen.findByRole('button', { name: 'Add folder' }))

    // 显示名默认取末段目录名。
    const input = (await screen.findByRole('dialog')).querySelector('input') as HTMLInputElement
    await waitFor(() => expect(input.value).toBe('工作区'))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(
      Array.from(dialog.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Add folder'
      ) as HTMLElement
    )

    await waitFor(() => expect(api.addMount).toHaveBeenCalledWith(ABS_PATH, '工作区', 'rw'))
  })

  test('用户在系统对话框里取消 = 不弹我们的面板', async () => {
    pickFolder.mockResolvedValue(null)
    renderTree()
    fireEvent.click(await screen.findByRole('button', { name: 'Add folder' }))

    await waitFor(() => expect(pickFolder).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('服务端拒挂时原样显示它给的原因，面板不关', async () => {
    pickFolder.mockResolvedValue(ABS_PATH)
    const err = Object.assign(new Error('directory has 84207 files (limit 20000)'), {
      code: 'E_INVALID_ARG',
      hint: '选一个更小的文件夹'
    })
    api.addMount.mockRejectedValue(err)
    renderTree()
    fireEvent.click(await screen.findByRole('button', { name: 'Add folder' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(
      Array.from(dialog.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Add folder'
      ) as HTMLElement
    )

    expect(await screen.findByText(/directory has 84207 files/)).toBeTruthy()
    expect(screen.getByText(/选一个更小的文件夹/)).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})

describe('绝对路径不进树（design §8.2）', () => {
  test('树里既不显示绝对路径，也不去调唯一带 abs_path 的 /library/mounts', async () => {
    renderTree()
    await screen.findByText('@工作区')

    expect(document.body.textContent).not.toContain(ABS_PATH)
    expect(document.body.textContent).not.toContain('/Users/')
    expect(api.mounts).not.toHaveBeenCalled()
  })
})
