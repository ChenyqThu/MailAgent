// @vitest-environment happy-dom
//
// 历史抽屉的三条判据（task 09-03 P2-L4；design §4，mockup C9）：
//   ① 快照正文**不在列表里** —— 只有点开某一行才去打单条快照端点，且打的是那一行的 id；
//   ② 回滚是**二次确认**：点「回滚到这一版」不写盘，点确认才发请求；与磁盘同 hash 的那条
//      根本不给回滚入口（回滚到当前版本是空操作）；
//   ③ 回滚**会撞 409**（它就是一次普通写）—— 撞了要出冲突条 + 「重试」，而不是一句失败 toast；
//      重试再发一次（服务端下一次用新 hash 重算）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { api } = vi.hoisted(() => ({
  api: {
    history: vi.fn(),
    historySnapshot: vi.fn(),
    rollback: vi.fn()
  }
}))

vi.mock('@shared/api/library', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLibraryApi: () => api
}))
vi.mock('@shared/components/settings/custom-ai/shared', () => ({
  resolveApiBaseUrl: () => 'http://127.0.0.1:8200/api'
}))

import i18n from '@shared/i18n'
import { HistoryDrawer } from '@shared/components/library/HistoryDrawer'
import type { LibraryFile, LibraryHistoryEntry } from '@shared/api/types/library'

await i18n.changeLanguage('en-US')

/** 当前磁盘正文的 hash —— 列表里 `new_hash` 等于它的那条就是「当前版本」。 */
const CURRENT = 'hash-c'

const FILE: LibraryFile = {
  id: 7,
  mount_id: 0,
  rel_path: 'plans/sow.md',
  path: 'my-docs/plans/sow.md',
  parent_path: 'my-docs/plans',
  filename: 'sow.md',
  kind: 'markdown',
  mime: 'text/markdown',
  size_bytes: 320,
  mtime: 1_756_000_000,
  content_hash: CURRENT,
  source: 'user',
  source_ref: null,
  created_by: 'user',
  status: 'present',
  text_status: 'extracted',
  created_at: 1_755_000_000,
  updated_at: 1_756_000_000
}

function entry(over: Partial<LibraryHistoryEntry>): LibraryHistoryEntry {
  return {
    id: 1,
    file_id: 7,
    old_hash: null,
    new_hash: 'hash-x',
    changed_by: 'user',
    change_note: '手动编辑',
    session_id: null,
    message_id: null,
    created_at: 1_756_000_000,
    snapshot_bytes: 320,
    ...over
  }
}

/** 新 → 旧（服务端就是这个序）：当前版本 / agent 写的 / 应用之外改的。 */
const ENTRIES: LibraryHistoryEntry[] = [
  entry({ id: 30, new_hash: CURRENT, snapshot_bytes: 320, created_at: 1_756_000_300 }),
  entry({ id: 20, new_hash: 'hash-b', changed_by: 'agent-7', change_note: 'agent 补充', snapshot_bytes: 300 }),
  entry({ id: 10, new_hash: 'hash-a', changed_by: 'external', change_note: null, snapshot_bytes: 280 })
]

function renderDrawer(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={qc}>
      <HistoryDrawer open onOpenChange={vi.fn()} file={FILE} />
    </QueryClientProvider>
  )
}

function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[data-testid="library-history-row"]'))
}

/** 某一行上的按钮（行内只有「查看快照」与「回滚到这一版」两个）。 */
function rowButton(historyId: number, testid: string): HTMLElement | null {
  const row = rows().find((r) => r.dataset.historyId === String(historyId))
  return row?.querySelector(`[data-testid="${testid}"]`) ?? null
}

beforeEach(() => {
  vi.clearAllMocks()
  api.history.mockResolvedValue(ENTRIES)
  api.historySnapshot.mockResolvedValue({
    id: 20,
    file_id: 7,
    old_hash: 'hash-a',
    new_hash: 'hash-b',
    changed_by: 'agent-7',
    change_note: 'agent 补充',
    session_id: null,
    message_id: null,
    created_at: 1_756_000_000,
    content_snapshot: '# 旧版正文\n交付日期 3 月 1 日'
  })
  api.rollback.mockResolvedValue({ ...FILE, content_hash: 'hash-b' })
})

afterEach(() => {
  cleanup()
})

describe('P2-L4 历史抽屉', () => {
  test('列表不带快照正文；点「查看快照」才按那一行的 id 单独取', async () => {
    renderDrawer()
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(api.historySnapshot).not.toHaveBeenCalled()
    expect(screen.queryByTestId('library-history-snapshot')).toBeNull()

    fireEvent.click(rowButton(20, 'library-history-view')!)
    await waitFor(() => expect(api.historySnapshot).toHaveBeenCalledWith(7, 20))
    await waitFor(() =>
      expect(screen.getByTestId('library-history-snapshot').textContent).toContain('交付日期')
    )
  })

  test('回滚要二次确认：点按钮不写盘，确认后才发 rollback', async () => {
    renderDrawer()
    await waitFor(() => expect(rows()).toHaveLength(3))

    fireEvent.click(rowButton(10, 'library-history-rollback')!)
    expect(api.rollback).not.toHaveBeenCalled()
    expect(screen.getByTestId('library-history-confirm')).toBeTruthy()

    fireEvent.click(screen.getByTestId('library-history-confirm-ok'))
    await waitFor(() => expect(api.rollback).toHaveBeenCalledWith(7, 10))
    await waitFor(() => expect(screen.queryByTestId('library-history-confirm')).toBeNull())
  })

  test('与当前正文同 hash 的那条不给回滚入口（回滚到当前版本是空操作）', async () => {
    renderDrawer()
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(rowButton(30, 'library-history-rollback')).toBeNull()
    expect(rowButton(20, 'library-history-rollback')).not.toBeNull()
    expect(rowButton(10, 'library-history-rollback')).not.toBeNull()
  })

  test('🔴 回滚撞 409 → 出冲突条 + 「重试」，重试再发一次（不是一句失败 toast）', async () => {
    api.rollback.mockRejectedValueOnce(
      Object.assign(new Error('conflict'), { code: 'E_VERSION_CONFLICT' })
    )
    renderDrawer()
    await waitFor(() => expect(rows()).toHaveLength(3))

    fireEvent.click(rowButton(20, 'library-history-rollback')!)
    fireEvent.click(screen.getByTestId('library-history-confirm-ok'))
    await waitFor(() => expect(screen.getByTestId('library-history-conflict')).toBeTruthy())
    expect(screen.queryByTestId('library-history-confirm')).toBeNull()

    fireEvent.click(screen.getByTestId('library-history-retry'))
    await waitFor(() => expect(api.rollback).toHaveBeenCalledTimes(2))
    expect(api.rollback).toHaveBeenLastCalledWith(7, 20)
    await waitFor(() => expect(screen.queryByTestId('library-history-conflict')).toBeNull())
  })

  test('external 那条没有 change_note → 出「对账补记」占位，不是空白', async () => {
    renderDrawer()
    await waitFor(() => expect(rows()).toHaveLength(3))
    const external = rows().find((r) => r.dataset.historyId === '10')!
    expect(external.textContent).toContain(i18n.t('library.history.externalNoNote'))
  })
})
