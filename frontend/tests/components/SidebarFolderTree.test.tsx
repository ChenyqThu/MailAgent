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
    const tree = buildSidebarFolderTree(folders, ['Jira'])
    expect(tree).toHaveLength(1)
    expect(tree[0].displayName).toBe('Jira')
  })

  test('parent 链: 勾选的子挂在勾选的父下 — 叶子名切末段, 过滤用全路径', () => {
    // 后端真实返回: display_name 含完整路径 (含 delimiter)。
    const folders = [fi('Proj', '项目', null, null), fi('Proj/Q2', '项目/2026 Q2', 'Proj', 156)]
    const tree = buildSidebarFolderTree(folders, ['Proj', 'Proj/Q2'])
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
    const tree = buildSidebarFolderTree(folders, ['Proj/Q2'])
    expect(tree).toHaveLength(1)
    // 父未勾 → path 只含叶子段。
    expect(tree[0].displayName).toBe('2026 Q2')
    expect(tree[0].fullDisplayName).toBe('项目/2026 Q2')
    expect(tree[0].path).toEqual(['2026 Q2'])
  })

  test('顶层路径 = 单段', () => {
    const tree = buildSidebarFolderTree([fi('Jira', 'Jira', null, 10)], ['Jira'])
    expect(tree[0].path).toEqual(['Jira'])
    expect(tree[0].displayName).toBe('Jira')
    expect(tree[0].fullDisplayName).toBe('Jira')
  })

  // ── 排序 task: whitelist 数组序 = 自定义显示顺序 ─────────────────────────
  test('顶层按 whitelist 数组序排, 不跟 discover 的服务端 LIST 序', () => {
    // folders 是服务端 LIST 序 (A,B,C); whitelist 自定义序是 C,A,B。
    const folders = [fi('A', 'Alpha', null, 1), fi('B', 'Beta', null, 2), fi('C', 'Gamma', null, 3)]
    const tree = buildSidebarFolderTree(folders, ['C', 'A', 'B'])
    expect(tree.map((n) => n.imapName)).toEqual(['C', 'A', 'B'])
  })

  test('子节点在同层级内也按 whitelist 序排', () => {
    const folders = [
      fi('Proj', '项目', null, null),
      fi('Proj/X', '项目/X', 'Proj', 1),
      fi('Proj/Y', '项目/Y', 'Proj', 2)
    ]
    // 服务端序 X,Y; 自定义序把 Y 排前面。
    const tree = buildSidebarFolderTree(folders, ['Proj', 'Proj/Y', 'Proj/X'])
    expect(tree).toHaveLength(1)
    expect(tree[0].children.map((n) => n.imapName)).toEqual(['Proj/Y', 'Proj/X'])
  })

  test('父未勾升顶层的子, 与其它顶层混排时仍按 whitelist 序', () => {
    const folders = [
      fi('Proj', '项目', null, null),
      fi('Proj/Q2', '项目/2026 Q2', 'Proj', 5),
      fi('Jira', 'Jira', null, 9)
    ]
    // Proj 未勾 → Proj/Q2 升顶层。服务端 LIST 序里 Proj/Q2 在 Jira 之前, 自定义序
    // 要求反过来 —— 断言必须能分辨"排过序"与"照抄服务端序"(否则测试恒绿)。
    const tree = buildSidebarFolderTree(folders, ['Jira', 'Proj/Q2'])
    expect(tree.map((n) => n.imapName)).toEqual(['Jira', 'Proj/Q2'])
  })

  test('whitelist 含已不存在的文件夹 → 跳过且不打乱其余顺序', () => {
    const folders = [fi('A', 'Alpha', null, 1), fi('B', 'Beta', null, 2)]
    const tree = buildSidebarFolderTree(folders, ['B', 'GONE', 'A'])
    expect(tree.map((n) => n.imapName)).toEqual(['B', 'A'])
  })
})

// ── component render + filter ──────────────────────────────────────────────
// useMailApi 稳定单例 (避免 useCallback 重建); 注入 whitelist + discover。
const mockGetWhitelist = vi.fn()
const mockDiscover = vi.fn()
// per-folder 配置 (v62) — 侧边栏只读 icon 列; 缺行 = 没设过 → 兜底 folder 图标。
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
    mockGetPrefs.mockReset()
    mockGetPrefs.mockResolvedValue({ prefs: [] })
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

// ── per-folder 图标 (v62) ──────────────────────────────────────────────────
//
// 🔴 这是本批最实的收益: 收起态 56px rail 上文字全隐, **图标是区分各文件夹的唯一线索**。
// 断言看渲染出的 svg 里有没有那个图标的特征 path, 不看类名/组件名 (换实现不该红)。

/** 某个文件夹行的 svg 里所有 path 的 d 值。 */
function iconPathsOf(container: HTMLElement, label: string): string[] {
  const row = Array.from(container.querySelectorAll('button.row')).find(
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

describe('SidebarFolderTree — per-folder 图标 (v62 folder_pref.icon)', () => {
  beforeEach(() => {
    mockGetWhitelist.mockReset()
    mockDiscover.mockReset()
    mockGetPrefs.mockReset()
    useEmailFilter.getState().setView('inbox')
  })
  afterEach(() => cleanup())

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
    const { container } = renderTree()
    await screen.findByText('22')

    await waitFor(() => expect(iconPathsOf(container, 'Jira')).toContain(CHECK_D))
    // Notion 没有 folder_pref 行 —— 缺行不是错误, 走兜底 folder。
    expect(iconPathsOf(container, 'Notion')).toContain(FOLDER_BODY_D)
    expect(iconPathsOf(container, 'Notion')).not.toContain(CHECK_D)
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
    const { container } = renderTree()
    await screen.findByText('22')

    await waitFor(() => expect(iconPathsOf(container, 'Jira')).toContain(FOLDER_BODY_D))
  })

  // 🔴 收起态 (56px rail) 的收益全押在这条结构契约上: index.css §2.11 的放大规则选的是
  // `nav button > svg`, 隐藏文字的规则选的是 `button > span:not(.app-nav-keep)`。
  // 图标外面多包一层 (哪怕是 <span>) → 收起态图标不放大; 名称若挂上 app-nav-keep →
  // 收起态还留着文字。两条都不报错、不影响展开态, 只有真收起才看得见。
  test('图标是 button 的直接子节点 + 名称在会被收起态隐掉的普通 span 里', async () => {
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
    const { container } = renderTree()
    await screen.findByText('22')

    const row = Array.from(container.querySelectorAll('button.row')).find(
      (b) => b.textContent?.includes('Jira') === true
    )!
    const kids = Array.from(row.children)
    expect(kids.some((c) => c.tagName.toLowerCase() === 'svg')).toBe(true)
    const label = kids.find((c) => c.textContent === 'Jira')!
    expect(label.tagName.toLowerCase()).toBe('span')
    expect(label.classList.contains('app-nav-keep')).toBe(false)
  })

  test('getPrefs 失败 → 整棵树照常渲染, 图标退回兜底 (图标不该拖垮列表)', async () => {
    twoFolders()
    mockGetPrefs.mockRejectedValue(new Error('boom'))
    const { container } = renderTree()
    await screen.findByText('22')

    expect(iconPathsOf(container, 'Jira')).toContain(FOLDER_BODY_D)
  })
})
