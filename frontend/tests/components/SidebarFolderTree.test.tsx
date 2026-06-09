// @vitest-environment happy-dom
//
// 多文件夹同步 (P3) — SidebarFolderTree 渲染 + 过滤测 + buildSidebarFolderTree
// 纯函数测。
//
// 覆盖:
//   - buildSidebarFolderTree: whitelist 过滤 / parent 链层级 / 父未勾子升顶层 / 路径
//   - 渲染: whitelist 空 → null (隔离不变量) / 非空 → 渲染 folder 名 + 计数
//   - 过滤: 点击文件夹 → setCustomMailbox(display_name, path) 被调

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
import { buildSidebarFolderTree } from '../../src/shared/components/layout/sidebarFolderTree.helpers'

await i18n.changeLanguage('zh-CN')

// ── helpers for buildSidebarFolderTree ─────────────────────────────────────
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

describe('buildSidebarFolderTree — 纯函数', () => {
  test('whitelist 过滤: 只保留勾选的文件夹', () => {
    const folders = [fi('Jira', 'Jira', null, 10), fi('Notion', 'Notion', null, 20)]
    const tree = buildSidebarFolderTree(folders, new Set(['Jira']))
    expect(tree).toHaveLength(1)
    expect(tree[0].displayName).toBe('Jira')
  })

  test('parent 链: 勾选的子挂在勾选的父下 — 叶子名切末段, 过滤用全路径', () => {
    // 后端真实返回: display_name 含完整路径 (含 delimiter)。
    const folders = [fi('Proj', '项目', null, null), fi('Proj/Q2', '项目/2026 Q2', 'Proj', 156)]
    const tree = buildSidebarFolderTree(folders, new Set(['Proj', 'Proj/Q2']))
    expect(tree).toHaveLength(1)
    // 父行叶子名 = "项目" (无斜线, 直接用末段)。
    expect(tree[0].displayName).toBe('项目')
    expect(tree[0].fullDisplayName).toBe('项目')
    expect(tree[0].children).toHaveLength(1)
    // 子行 label = 叶子名 "2026 Q2" (切掉 "项目/" 前缀)。
    expect(tree[0].children[0].displayName).toBe('2026 Q2')
    // 过滤 key (fullDisplayName) = 完整路径 "项目/2026 Q2"。
    expect(tree[0].children[0].fullDisplayName).toBe('项目/2026 Q2')
    // path 各段也用叶子名 (面包屑渲染)。
    expect(tree[0].children[0].path).toEqual(['项目', '2026 Q2'])
  })

  test('父未勾、子勾 → 子升为顶层 (不丢)', () => {
    const folders = [fi('Proj', '项目', null, null), fi('Proj/Q2', '项目/2026 Q2', 'Proj', 156)]
    const tree = buildSidebarFolderTree(folders, new Set(['Proj/Q2']))
    expect(tree).toHaveLength(1)
    // 父未勾 → path 只含叶子段。
    expect(tree[0].displayName).toBe('2026 Q2')
    expect(tree[0].fullDisplayName).toBe('项目/2026 Q2')
    expect(tree[0].path).toEqual(['2026 Q2'])
  })

  test('顶层路径 = 单段', () => {
    const tree = buildSidebarFolderTree([fi('Jira', 'Jira', null, 10)], new Set(['Jira']))
    expect(tree[0].path).toEqual(['Jira'])
    expect(tree[0].displayName).toBe('Jira')
    expect(tree[0].fullDisplayName).toBe('Jira')
  })
})

// ── component render + filter ──────────────────────────────────────────────
// useMailApi 稳定单例 (避免 useCallback 重建); 注入 whitelist + discover。
const mockGetWhitelist = vi.fn()
const mockDiscover = vi.fn()
const stableApi = { folder: { getWhitelist: mockGetWhitelist, discover: mockDiscover } }

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => stableApi
}))

// usePollingFallback → 固定值 (不真起 SSE/poll)。
vi.mock('@shared/hooks/usePollingFallback', () => ({
  usePollingFallback: () => false
}))

import { useEmailFilter } from '@shared/state/email-filter'
import { SidebarFolderTree } from '../../src/shared/components/layout/SidebarFolderTree'

function discoverData(folders: FolderInfo[], whitelist: string[]) {
  return {
    folders: folders.map((f) => ({ ...f, is_synced: whitelist.includes(f.imap_name) })),
    tree: [],
    whitelist
  }
}

function renderTree(): { container: HTMLElement } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  })
  const rootRoute = createRootRoute({
    component: () => (
      <I18nextProvider i18n={i18n}>
        <nav>
          <SidebarFolderTree />
        </nav>
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

describe('SidebarFolderTree — 渲染 + 过滤', () => {
  beforeEach(() => {
    mockGetWhitelist.mockReset()
    mockDiscover.mockReset()
    // 每个 case 前重置 customMailbox。
    useEmailFilter.getState().setView('inbox')
  })
  afterEach(() => cleanup())

  test('whitelist 空 → 不渲染任何文件夹行 (隔离不变量)', async () => {
    mockGetWhitelist.mockResolvedValue({ folders: [] })
    mockDiscover.mockResolvedValue(discoverData([], []))
    const { container } = renderTree()
    // 等一拍让 query settle; 仍不应出现任何 button。
    await waitFor(() => expect(mockGetWhitelist).toHaveBeenCalled())
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  test('whitelist 非空 → 渲染文件夹名 + 计数', async () => {
    mockGetWhitelist.mockResolvedValue({ folders: ['Jira'] })
    mockDiscover.mockResolvedValue(discoverData([fi('Jira', 'Jira', null, 3458)], ['Jira']))
    renderTree()
    expect(await screen.findByText('Jira')).toBeTruthy()
    // 计数来自 discover (晚于 whitelist 落地); findByText 轮询等它出现。
    expect(await screen.findByText('3,458')).toBeTruthy()
  })

  test('点击文件夹 → setCustomMailbox(display_name, path)', async () => {
    mockGetWhitelist.mockResolvedValue({ folders: ['DMS&VvpO9lPRXgM-'] })
    mockDiscover.mockResolvedValue(
      discoverData([fi('DMS&VvpO9lPRXgM-', 'DMS固件发布', null, 728)], ['DMS&VvpO9lPRXgM-'])
    )
    renderTree()
    const row = await screen.findByText('DMS固件发布')
    fireEvent.click(row)
    await waitFor(() => {
      const s = useEmailFilter.getState()
      expect(s.customMailbox).toBe('DMS固件发布')
      expect(s.customMailboxPath).toEqual(['DMS固件发布'])
    })
  })

  test('选中文件夹 → row-selected class', async () => {
    mockGetWhitelist.mockResolvedValue({ folders: ['Jira'] })
    mockDiscover.mockResolvedValue(discoverData([fi('Jira', 'Jira', null, 10)], ['Jira']))
    const { container } = renderTree()
    // 等 discover resolve (count '10' 出现 = 真行, 非 pending 期的 disabled fallback 行;
    // imap_name=display_name='Jira' 时两行同名, 必须靠 count 区分才点到可点的那行)。
    await screen.findByText('10')
    fireEvent.click(screen.getByText('Jira'))
    await waitFor(() => {
      expect(container.querySelector('.row-selected')).toBeTruthy()
    })
  })
})
