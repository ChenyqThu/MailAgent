// @vitest-environment happy-dom
//
// 列表头的文件夹选择器（task 08-27 P1 Lane B）—— 取代原来的常驻文件夹树
// （SidebarFolderTree.test.tsx 的组件段搬到这里，判据沿用）。
//
// 覆盖:
//   - 触发器显示当前位置（内建视图 / 自定义文件夹）
//   - 下拉两段: MAILBOXES（registry 五个内建视图）+ FOLDERS（whitelist × discover）
//   - whitelist 空 → 只有 MAILBOXES 段（隔离不变量: 不渲染任何自定义文件夹行）
//   - 点自定义文件夹 → setCustomMailbox(display_name, path)；点内建视图 → setView
//   - discover 未就绪的 seed 行可点 + 🔴 顺序 = whitelist 数组序（sorted() 变异必红）
//   - per-folder 图标（v62 folder_pref.icon），缺行/不认识的 key 退回兜底 folder
//   - pin: 钉到列表头第一行、上限 4、再点取消

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider
} from '@tanstack/react-router'

import i18n from '../../src/shared/i18n'
import type { FolderInfo } from '../../src/shared/api/types'

await i18n.changeLanguage('zh-CN')

// useMailApi 稳定单例 (避免 useCallback 重建); 注入 whitelist + discover + prefs。
const mockGetWhitelist = vi.fn()
const mockDiscover = vi.fn()
const mockGetPrefs = vi.fn()
const stableApi = {
  folder: { getWhitelist: mockGetWhitelist, discover: mockDiscover, getPrefs: mockGetPrefs }
}

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => stableApi
}))

// usePollingFallback → 固定值 (不真起 SSE/poll)。
vi.mock('@shared/hooks/usePollingFallback', () => ({
  usePollingFallback: () => false
}))

import { ALL_CATEGORIES, ALL_PRIORITIES, useEmailFilter } from '@shared/state/email-filter'
import { usePinnedFolders } from '@shared/state/pinned-folders'
import { __resetToastStore, useToastStore } from '@shared/state/toast'
import { EmailListHeader } from '../../src/shared/components/email/EmailListHeader'

const COUNTS = { all: 12, unread: 3, flagged: 2, done: 1, toMe: 5, hasAttach: 4, failed: 0 }

function fi(
  imap: string,
  display: string,
  parent: string | null,
  count: number | null
): FolderInfo {
  return {
    imap_name: imap,
    display_name: display,
    delimiter: '/',
    special_use: null,
    is_system: false,
    has_children: false,
    parent,
    message_count: count
  }
}

function discoverData(folders: FolderInfo[], whitelist: string[]) {
  return {
    folders: folders.map((f) => ({ ...f, is_synced: whitelist.includes(f.imap_name) })),
    tree: [],
    whitelist
  }
}

function renderHeader(): { container: HTMLElement } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  })
  const rootRoute = createRootRoute({
    component: () => (
      <I18nextProvider i18n={i18n}>
        <EmailListHeader
          counts={COUNTS}
          categoryCounts={Object.fromEntries(ALL_CATEGORIES.map((c) => [c, 0])) as never}
          priorityCounts={Object.fromEntries(ALL_PRIORITIES.map((p) => [p, 0])) as never}
          userEmail="me@example.test"
        />
        <Outlet />
      </I18nextProvider>
    )
  })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => null
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] })
  })
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return { container }
}

/** 打开文件夹下拉（触发器的可及名 = 当前位置 + 「切换文件夹」）。
 *  🔴 必须 await：TanStack Router 首帧后才把子树挂上来，同步 getByRole 会撞空 body。 */
async function openFolderMenu(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: /切换文件夹/ }))
  return screen.getByLabelText('文件夹')
}

beforeEach(() => {
  mockGetWhitelist.mockReset()
  mockDiscover.mockReset()
  mockGetPrefs.mockReset()
  mockGetPrefs.mockResolvedValue({ prefs: [] })
  mockGetWhitelist.mockResolvedValue({ folders: [] })
  mockDiscover.mockResolvedValue(discoverData([], []))
  useEmailFilter.getState().setView('inbox')
  usePinnedFolders.setState({ pinned: [] })
  __resetToastStore()
})
afterEach(() => cleanup())

describe('文件夹选择器 — 触发器', () => {
  test('内建视图: 显示视图名', async () => {
    renderHeader()
    expect(await screen.findByText('收件箱')).toBeTruthy()
  })

  test('自定义文件夹: 显示叶子段, 完整路径进 title', async () => {
    mockGetWhitelist.mockResolvedValue({ folders: ['Proj', 'Proj/Q2'] })
    mockDiscover.mockResolvedValue(
      discoverData(
        [fi('Proj', '项目', null, null), fi('Proj/Q2', '项目/2026 Q2', 'Proj', 5)],
        ['Proj', 'Proj/Q2']
      )
    )
    renderHeader()
    useEmailFilter.getState().setCustomMailbox('项目/2026 Q2', ['项目', '2026 Q2'])
    const trigger = await screen.findByRole('button', { name: /切换文件夹/ })
    await waitFor(() => expect(trigger.textContent).toContain('2026 Q2'))
    expect(trigger.getAttribute('title')).toBe('项目/2026 Q2')
  })
})

describe('文件夹选择器 — 下拉两段', () => {
  test('MAILBOXES 段恒在 (registry 的五个内建视图)', async () => {
    renderHeader()
    const menu = await openFolderMenu()
    for (const label of ['收件箱', '发件箱', '草稿箱', '已标旗', '所有邮件']) {
      expect(within(menu).getByRole('button', { name: label })).toBeTruthy()
    }
  })

  test('whitelist 空 → 没有 FOLDERS 段 (隔离不变量)', async () => {
    renderHeader()
    await waitFor(() => expect(mockGetWhitelist).toHaveBeenCalled())
    const menu = await openFolderMenu()
    expect(within(menu).queryByText('Folders')).toBeNull()
  })

  test('whitelist 非空 → FOLDERS 段渲染文件夹名 + 计数', async () => {
    mockGetWhitelist.mockResolvedValue({ folders: ['Jira'] })
    mockDiscover.mockResolvedValue(discoverData([fi('Jira', 'Jira', null, 3458)], ['Jira']))
    renderHeader()
    await waitFor(() => expect(mockDiscover).toHaveBeenCalled())
    const menu = await openFolderMenu()
    expect(await within(menu).findByText('Jira')).toBeTruthy()
    expect(await within(menu).findByText('3,458')).toBeTruthy()
  })

  test('点文件夹 → setCustomMailbox(display_name, path) 并关掉下拉', async () => {
    mockGetWhitelist.mockResolvedValue({ folders: ['DMS&VvpO9lPRXgM-'] })
    mockDiscover.mockResolvedValue(
      discoverData([fi('DMS&VvpO9lPRXgM-', 'DMS固件发布', null, 728)], ['DMS&VvpO9lPRXgM-'])
    )
    renderHeader()
    await waitFor(() => expect(mockDiscover).toHaveBeenCalled())
    const menu = await openFolderMenu()
    fireEvent.click(await within(menu).findByText('DMS固件发布'))
    await waitFor(() => {
      const s = useEmailFilter.getState()
      expect(s.customMailbox).toBe('DMS固件发布')
      expect(s.customMailboxPath).toEqual(['DMS固件发布'])
    })
  })

  test('点内建视图 → setView 且清掉自定义文件夹', async () => {
    renderHeader()
    useEmailFilter.getState().setCustomMailbox('Jira', ['Jira'])
    const menu = await openFolderMenu()
    fireEvent.click(within(menu).getByRole('button', { name: '草稿箱' }))
    await waitFor(() => {
      expect(useEmailFilter.getState().view).toBe('drafts')
      expect(useEmailFilter.getState().customMailbox).toBeNull()
    })
  })

  // ── seed 树 (§③): discover 未就绪时立即可见**可点** ──────────────────────
  test('discover 未就绪 → seed 行已解码可点, 点击即过滤', async () => {
    mockGetWhitelist.mockResolvedValue({ folders: ['DMS&VvpO9lPRXgM-'] })
    mockDiscover.mockReturnValue(new Promise(() => {})) // 永不 resolve = discover 在途
    renderHeader()
    await waitFor(() => expect(mockGetWhitelist).toHaveBeenCalled())
    const menu = await openFolderMenu()
    // 解码后的 display_name 立即渲染 (老降级态显示未解码 imap_name)。
    const row = await within(menu).findByText('DMS固件发布')
    fireEvent.click(row)
    await waitFor(() => {
      // 过滤 key = 解码后完整 display_name (= email_metadata.mailbox), 与正式树一致。
      expect(useEmailFilter.getState().customMailbox).toBe('DMS固件发布')
    })
  })

  test('seed 顺序 = whitelist 数组序 (discover 在途, 🔴 不按名排)', async () => {
    // 自定义序与字母序相反 —— 把渲染序断言在 DOM 顺序上, sorted() 变异必红。
    mockGetWhitelist.mockResolvedValue({ folders: ['Zeta', 'Alpha'] })
    mockDiscover.mockReturnValue(new Promise(() => {}))
    renderHeader()
    await waitFor(() => expect(mockGetWhitelist).toHaveBeenCalled())
    const menu = await openFolderMenu()
    await within(menu).findByText('Zeta')
    const labels = Array.from(menu.querySelectorAll('button.row span.flex-1'))
      .map((el) => el.textContent)
      .filter((label) => label === 'Zeta' || label === 'Alpha')
    expect(labels).toEqual(['Zeta', 'Alpha'])
  })

  test('选中的文件夹 → row-selected', async () => {
    mockGetWhitelist.mockResolvedValue({ folders: ['Jira'] })
    mockDiscover.mockResolvedValue(discoverData([fi('Jira', 'Jira', null, 10)], ['Jira']))
    renderHeader()
    useEmailFilter.getState().setCustomMailbox('Jira', ['Jira'])
    await waitFor(() => expect(mockDiscover).toHaveBeenCalled())
    const menu = await openFolderMenu()
    await waitFor(() => {
      const selected = menu.querySelectorAll('.row-selected')
      expect(selected).toHaveLength(1)
      expect(selected[0].textContent).toContain('Jira')
    })
  })
})

// ── per-folder 图标 (v62) ──────────────────────────────────────────────────
//
// 断言看渲染出的 svg 里有没有那个图标的特征 path, 不看类名/组件名 (换实现不该红)。

/** 某个文件夹行的 svg 里所有 path 的 d 值。 */
function iconPathsOf(scope: HTMLElement, label: string): string[] {
  const row = Array.from(scope.querySelectorAll('button.row')).find(
    (b) => b.textContent?.includes(label) === true
  )
  if (!row) throw new Error(`row not found: ${label}`)
  return Array.from(row.querySelectorAll('svg path')).map((p) => p.getAttribute('d') ?? '')
}

/** folder-check 的勾 (lucide 1.16.0 __iconNode)。 */
const CHECK_D = 'm9 13 2 2 4-4'
/** 兜底 folder 的主体 (lucide 1.16.0 __iconNode)。 */
const FOLDER_BODY_D =
  'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'

describe('文件夹选择器 — per-folder 图标 (v62 folder_pref.icon)', () => {
  function twoFolders(): void {
    mockGetWhitelist.mockResolvedValue({ folders: ['Jira', 'Notion'] })
    mockDiscover.mockResolvedValue(
      discoverData(
        [fi('Jira', 'Jira', null, 11), fi('Notion', 'Notion', null, 22)],
        ['Jira', 'Notion']
      )
    )
  }

  test('设过 icon 的文件夹渲染那个图标; 没设过的退回兜底 folder', async () => {
    twoFolders()
    mockGetPrefs.mockResolvedValue({
      prefs: [
        {
          imap_name: 'Jira',
          mailbox_label: 'Jira',
          icon: 'folder-check',
          notify_enabled: false,
          llm_disabled: false,
          updated_at: 0
        }
      ]
    })
    renderHeader()
    await waitFor(() => expect(mockGetPrefs).toHaveBeenCalled())
    const menu = await openFolderMenu()
    await within(menu).findByText('22')

    await waitFor(() => expect(iconPathsOf(menu, 'Jira')).toContain(CHECK_D))
    // Notion 没有 folder_pref 行 —— 缺行不是错误, 走兜底 folder。
    expect(iconPathsOf(menu, 'Notion')).toContain(FOLDER_BODY_D)
    expect(iconPathsOf(menu, 'Notion')).not.toContain(CHECK_D)
  })

  test('存的 icon key 不认识 (lucide 改名 / 手改 DB) → 兜底 folder, 不炸', async () => {
    twoFolders()
    mockGetPrefs.mockResolvedValue({
      prefs: [
        {
          imap_name: 'Jira',
          mailbox_label: 'Jira',
          icon: 'folder-does-not-exist',
          notify_enabled: false,
          llm_disabled: false,
          updated_at: 0
        }
      ]
    })
    renderHeader()
    await waitFor(() => expect(mockGetPrefs).toHaveBeenCalled())
    const menu = await openFolderMenu()
    await within(menu).findByText('22')

    await waitFor(() => expect(iconPathsOf(menu, 'Jira')).toContain(FOLDER_BODY_D))
  })

  test('getPrefs 失败 → 整个面板照常渲染, 图标退回兜底 (图标不该拖垮列表)', async () => {
    twoFolders()
    mockGetPrefs.mockRejectedValue(new Error('boom'))
    renderHeader()
    await waitFor(() => expect(mockDiscover).toHaveBeenCalled())
    const menu = await openFolderMenu()
    await within(menu).findByText('22')

    expect(iconPathsOf(menu, 'Jira')).toContain(FOLDER_BODY_D)
  })
})

// ── pin（列表头第一行的常驻图标）────────────────────────────────────────────
describe('文件夹选择器 — pin', () => {
  test('pin 一个文件夹 → 第一行出现它的图标钮; 再点取消', async () => {
    mockGetWhitelist.mockResolvedValue({ folders: ['Jira'] })
    mockDiscover.mockResolvedValue(discoverData([fi('Jira', 'Jira', null, 10)], ['Jira']))
    const { container } = renderHeader()
    await waitFor(() => expect(mockDiscover).toHaveBeenCalled())
    const menu = await openFolderMenu()
    fireEvent.click(await within(menu).findByRole('button', { name: '把「Jira」固定到列表头' }))

    await waitFor(() => expect(usePinnedFolders.getState().pinned).toHaveLength(1))
    // 第一行（下拉之外）出现同名图标钮。
    const chips = Array.from(container.querySelectorAll('button[aria-label="Jira"]'))
    expect(chips).toHaveLength(1)

    fireEvent.click(within(menu).getByRole('button', { name: '把「Jira」从列表头取消固定' }))
    await waitFor(() => expect(usePinnedFolders.getState().pinned).toHaveLength(0))
  })

  test('🔴 上限 4: 第 5 个不写 store, 出 toast', async () => {
    renderHeader()
    const menu = await openFolderMenu()
    for (const label of ['收件箱', '发件箱', '草稿箱', '已标旗']) {
      fireEvent.click(within(menu).getByRole('button', { name: `把「${label}」固定到列表头` }))
    }
    await waitFor(() => expect(usePinnedFolders.getState().pinned).toHaveLength(4))

    fireEvent.click(within(menu).getByRole('button', { name: '把「所有邮件」固定到列表头' }))
    await waitFor(() => {
      expect(usePinnedFolders.getState().pinned).toHaveLength(4)
      expect(useToastStore.getState().items[0]?.title).toContain('4')
    })
  })

  test('pin 的图标钮点一下就切过去（不用先开下拉）', async () => {
    const { container } = renderHeader()
    const menu = await openFolderMenu()
    fireEvent.click(within(menu).getByRole('button', { name: '把「草稿箱」固定到列表头' }))
    await waitFor(() => expect(usePinnedFolders.getState().pinned).toHaveLength(1))
    // 关掉下拉 —— 验的就是「不用开下拉也能切」，面板还开着的话点的是面板里那一行。
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByLabelText('文件夹')).toBeNull())

    const chip = container.querySelector<HTMLButtonElement>('button[aria-label="草稿箱"]')
    expect(chip).not.toBeNull()
    fireEvent.click(chip as HTMLButtonElement)
    await waitFor(() => expect(useEmailFilter.getState().view).toBe('drafts'))
  })
})
