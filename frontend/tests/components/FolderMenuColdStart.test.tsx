// @vitest-environment happy-dom
//
// 回归闸 —— 「自定义文件夹整段冷启后不出现」（原 SidebarFolderTreeColdStart.test.tsx；
// task 08-27 P1 Lane B 把树搬进列表头的文件夹选择器后，查询配方原样落在
// `useSyncedFolderTree`，这三条防线跟着搬过来）。
//
// 复现链: 冷启时 renderer 比 serve-api 先起 (实测 renderer 已挂载、serve-api 还在
// import) → whitelist query 首拉 E_NETWORK → `hasWhitelist` 恒 false → 整棵树空。
// 回归由 AppShell 单例化 (57cde131) 引入: 此前每次路由切换 Sidebar remount 会把
// errored query 重新拉一遍 (隐性自愈), 单例后失败即**永久**失败 —— 全局 `retry: 1` +
// `refetchOnWindowFocus: false` 一秒内两发全废, SSE 一连上 usePollingFallback 又把兜底
// 轮询清零, 于是再没有任何触发器。
//
// 三条防线各一条用例 (拆掉任何一条这里必红):
//   ① main 的 `mailagent:api-ready` 广播失效 folder 族 → 重拉 → 文件夹出现 (主修复);
//   ② query 层按错误码重试 (E_NETWORK) → 不等广播也能自愈;
//   ③ 业务错误 (非 davmail 后端的 E_INVALID_ARG) **不**重试 —— 防①②被写成无条件重试。

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

// useMailApi 稳定单例 (避免 useCallback 重建); 三个 folder 读全注入 +
// listMailboxes (下拉行尾计数的数据源, 这里恒空 —— 本文件只验文件夹行在不在)。
const mockGetWhitelist = vi.fn()
const mockDiscover = vi.fn()
const mockGetPrefs = vi.fn()
const stableApi = {
  folder: { getWhitelist: mockGetWhitelist, discover: mockDiscover, getPrefs: mockGetPrefs },
  email: { listMailboxes: vi.fn().mockResolvedValue([]) }
}

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => stableApi
}))

// 轮询兜底固定关掉 —— 这里要验的是「没有轮询时还有没有恢复路径」, 让它在场等于
// 把三条防线之一偷偷当成前提。
vi.mock('@shared/hooks/usePollingFallback', () => ({
  usePollingFallback: () => false
}))

import { useApiReadyRefresh } from '@shared/hooks/useApiReadyRefresh'
import { API_READY_CHANNEL } from '@shared/lib/ipcChannels'
import { qk } from '@shared/lib/queryKeys'
import { ALL_CATEGORIES, ALL_PRIORITIES } from '@shared/state/email-filter'
import { EmailListHeader } from '../../src/shared/components/email/EmailListHeader'

const COUNTS = { all: 12, unread: 3, flagged: 2, done: 1, toMe: 5, hasAttach: 4, failed: 0 }

/** http_client / IPC envelope 抛出的形状: 普通 Error 挂一个字符串 `code`。 */
function apiError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

function folderInfo(imap: string, display: string, count: number): FolderInfo {
  return {
    imap_name: imap,
    display_name: display,
    delimiter: '/',
    special_use: null,
    is_system: false,
    has_children: false,
    parent: null,
    message_count: count
  }
}

function discoverOk(folders: FolderInfo[], whitelist: string[]) {
  return {
    folders: folders.map((f) => ({ ...f, is_synced: whitelist.includes(f.imap_name) })),
    tree: [],
    whitelist
  }
}

interface ColdStartView {
  queryClient: QueryClient
  /** 模拟 main 侧软门控轮到 /api/health 200 后广播 `mailagent:api-ready`。 */
  fireApiReady: () => void
}

function renderColdStart(): ColdStartView {
  let broadcast: (() => void) | null = null
  const on = vi.fn((channel: string, fn: () => void) => {
    if (channel === API_READY_CHANNEL) broadcast = fn
    return () => {}
  })
  vi.stubGlobal('window', Object.assign(window, { electron: { ipcRenderer: { on } } }))

  // App.tsx 的真实 defaultOptions (retryDelay 归零只为不等指数退避)。
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 30 * 60_000,
        refetchOnWindowFocus: false,
        retry: 1,
        retryDelay: 0
      }
    }
  })

  function ApiReadyProbe(): null {
    useApiReadyRefresh()
    return null
  }

  const rootRoute = createRootRoute({
    component: () => (
      <I18nextProvider i18n={i18n}>
        <ApiReadyProbe />
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
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return {
    queryClient,
    fireApiReady: () => {
      if (!broadcast) throw new Error(`no listener on ${API_READY_CHANNEL}`)
      broadcast()
    }
  }
}

/** 打开列表头的文件夹下拉（自定义文件夹段就在里面）。 */
async function openFolderMenu(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: /切换文件夹/ }))
  return screen.getByLabelText('文件夹')
}

/** whitelist query 停在 error (重试已耗尽) —— 断言「不渲染」前必须等到这里,
 *  否则测的是「还在 loading」而不是「失败后没恢复」。 */
async function waitForWhitelistError(queryClient: QueryClient): Promise<void> {
  await waitFor(() =>
    expect(queryClient.getQueryState(qk.folder.whitelist())?.status).toBe('error')
  )
}

describe('文件夹选择器 — serve-api 冷启窗口的回归闸', () => {
  beforeEach(() => {
    mockGetWhitelist.mockReset()
    mockDiscover.mockReset()
    mockGetPrefs.mockReset()
    mockGetPrefs.mockResolvedValue({ prefs: [] })
    mockDiscover.mockResolvedValue(discoverOk([], []))
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  test('① whitelist 首拉失败 → 没有自定义文件夹段; api-ready 广播后重拉 → 出现', async () => {
    mockGetWhitelist.mockRejectedValue(apiError('E_NETWORK', 'serve-api 还没 bind'))
    const { queryClient, fireApiReady } = renderColdStart()

    await waitForWhitelistError(queryClient)
    const menu = await openFolderMenu()
    expect(within(menu).queryByText('Jira')).toBeNull()

    // serve-api 起来了, main 广播就绪。
    mockGetWhitelist.mockResolvedValue({ folders: ['Jira'] })
    mockDiscover.mockResolvedValue(discoverOk([folderInfo('Jira', 'Jira', 42)], ['Jira']))
    fireApiReady()

    expect(await within(menu).findByText('Jira')).toBeTruthy()
  })

  test('② E_NETWORK 是传输层抖动 → query 层自己重试到成功 (不等广播)', async () => {
    mockGetWhitelist
      .mockRejectedValueOnce(apiError('E_NETWORK', 'ECONNREFUSED'))
      .mockRejectedValueOnce(apiError('E_NETWORK', 'ECONNREFUSED'))
      .mockResolvedValue({ folders: ['Jira'] })
    mockDiscover.mockResolvedValue(discoverOk([folderInfo('Jira', 'Jira', 7)], ['Jira']))
    renderColdStart()

    // 全局 retry:1 (两发) 盖不住的窗口, 靠 query 层按错误码续命。
    const menu = await openFolderMenu()
    expect(await within(menu).findByText('Jira')).toBeTruthy()
  })

  test('③ 非 davmail 后端的 E_INVALID_ARG 不重试 (重试结果一样, 只拖慢门控态)', async () => {
    mockGetWhitelist.mockRejectedValue(apiError('E_INVALID_ARG', 'davmail backend only'))
    const { queryClient } = renderColdStart()

    await waitForWhitelistError(queryClient)
    expect(mockGetWhitelist).toHaveBeenCalledTimes(1)
  })
})
