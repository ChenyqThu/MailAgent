// @vitest-environment happy-dom
//
// EmailListHeader 的筛选/排序菜单接线 —— 2026-08 Outlook 结构重做。
//
// 这里验的是「store ↔ 菜单项」这一层（Popmenu 自身的行为在 Popmenu.test.tsx）：
// 六条筛选项 + 两个下钻子面板 + 排序/方向两组单选都在、勾选态跟 store 走、点了真写
// store、方向文案随排序键切换、以及「清除筛选」只在真有筛选时出现。
//
// task 08-27 P1 Lane B 起还多一段「两行结构」：非收件箱视图只是分栏消失，第二行的统计
// 与右端工具簇原样在场（行高由工具钮定，切文件夹时列表不跳）。列表头现在要 router +
// query provider —— 文件夹选择器要读 whitelist/discover/prefs 并写 `?view=`。

import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider
} from '@tanstack/react-router'

import i18n from '@shared/i18n'

// 文件夹选择器的三个读 —— 这里只关心筛选菜单，给空白名单（= 没有自定义文件夹段）。
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    folder: {
      getWhitelist: vi.fn().mockResolvedValue({ folders: [] }),
      discover: vi.fn().mockResolvedValue({ folders: [], tree: [], whitelist: [] }),
      getPrefs: vi.fn().mockResolvedValue({ prefs: [] })
    }
  })
}))
vi.mock('@shared/hooks/usePollingFallback', () => ({ usePollingFallback: () => false }))

import { ALL_CATEGORIES, ALL_PRIORITIES, useEmailFilter } from '@shared/state/email-filter'
import { EmailListHeader } from '../../src/shared/components/email/EmailListHeader'

await i18n.changeLanguage('en-US')

const COUNTS = { all: 12, unread: 3, flagged: 2, done: 1, toMe: 5, hasAttach: 4, failed: 0 }

/** 🔴 async：TanStack Router 首帧后才把子树挂上来，同步 getByRole 会撞空 body。 */
async function renderHeader(userEmail: string | null = 'me@example.test') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  })
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <EmailListHeader
          counts={COUNTS}
          categoryCounts={Object.fromEntries(ALL_CATEGORIES.map((c) => [c, 0])) as never}
          priorityCounts={Object.fromEntries(ALL_PRIORITIES.map((p) => [p, 0])) as never}
          userEmail={userEmail}
        />
        <Outlet />
      </>
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
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  await screen.findByRole('button', { name: 'Filter mail' })
  return view
}

function openMenu(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Filter mail' }))
}

beforeEach(() => {
  useEmailFilter.setState({
    unread: false,
    flagMark: null,
    toMe: false,
    hasAttach: false,
    failed: false,
    view: 'inbox',
    customMailbox: null,
    customMailboxPath: [],
    sortKey: 'date',
    sortDir: 'desc',
    selectedPriorities: new Set(ALL_PRIORITIES),
    selectedCategories: new Set(ALL_CATEGORIES)
  })
})
afterEach(cleanup)

describe('筛选菜单 — 结构', () => {
  test('六条筛选项齐全（未读/标记/收件人是我/具有附件/优先级/分类/同步失败）', async () => {
    await renderHeader()
    openMenu()
    const menu = screen.getByRole('menu', { name: 'Filter mail' })
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Unread/ })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: /Marked/ })).toBeTruthy()
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Addressed to me/ })).toBeTruthy()
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Has attachments/ })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: /Priority/ })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: /Category/ })).toBeTruthy()
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Sync failed/ })).toBeTruthy()
  })

  test('行尾展示各轴计数与快捷键（快捷键在菜单关着时也生效，这里只验标注）', async () => {
    await renderHeader()
    openMenu()
    const unread = screen.getByRole('menuitemcheckbox', { name: /Unread/ })
    expect(unread.textContent).toContain('3')
    expect(unread.textContent).toContain('⇧⌘O')
    expect(screen.getByRole('menuitemcheckbox', { name: /Has attachments/ }).textContent).toContain(
      '⇧⌘A'
    )
  })

  test('USER_EMAIL 未知 → 「收件人是我」置灰且不显计数（判据取不到，不给假开关）', async () => {
    await renderHeader(null)
    openMenu()
    const row = screen.getByRole('menuitemcheckbox', { name: /Addressed to me/ })
    expect(row.getAttribute('aria-disabled')).toBe('true')
    expect(row.textContent).not.toContain('5')
  })
})

describe('筛选菜单 — 写 store', () => {
  test('点「未读」翻转对应轴，勾选态跟着 store', async () => {
    await renderHeader()
    openMenu()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Unread/ }))
    expect(useEmailFilter.getState().unread).toBe(true)
    expect(
      screen.getByRole('menuitemcheckbox', { name: /Unread/ }).getAttribute('aria-checked')
    ).toBe('true')
  })

  test('「标记」下钻后是两档互斥单选（已标记 / 已完成）', async () => {
    await renderHeader()
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Marked/ }))
    const sub = screen.getByRole('menu', { name: 'Marked' })
    fireEvent.click(within(sub).getByRole('menuitemradio', { name: /Flagged/ }))
    expect(useEmailFilter.getState().flagMark).toBe('flagged')
    fireEvent.click(within(sub).getByRole('menuitemradio', { name: /Done/ }))
    expect(useEmailFilter.getState().flagMark).toBe('done')
  })

  test('优先级子面板里的 5 档多选沿用既有 store（去掉一档 → hint 出现 4/5）', async () => {
    await renderHeader()
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Priority/ }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Low/ }))
    expect(useEmailFilter.getState().selectedPriorities.has('low')).toBe(false)
    // 返回根面板后，submenu 行尾出现收窄提示。
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Priority' }), { key: 'ArrowLeft' })
    expect(screen.getByRole('menuitem', { name: /Priority/ }).textContent).toContain('4/5')
  })
})

describe('排序菜单', () => {
  test('四个排序键 + 默认勾在「日期」', async () => {
    await renderHeader()
    openMenu()
    const menu = screen.getByRole('menu', { name: 'Filter mail' })
    for (const label of ['Date', 'Sender', 'Subject', 'Importance']) {
      expect(within(menu).getByRole('menuitemradio', { name: label })).toBeTruthy()
    }
    expect(
      within(menu).getByRole('menuitemradio', { name: 'Date' }).getAttribute('aria-checked')
    ).toBe('true')
  })

  test('选排序键写 store', async () => {
    await renderHeader()
    openMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Sender' }))
    expect(useEmailFilter.getState().sortKey).toBe('sender')
  })

  test('🔴 方向文案随排序键切换（「按发件人 · 由新到旧」是自相矛盾的组合）', async () => {
    await renderHeader()
    openMenu()
    expect(screen.getByRole('menuitemradio', { name: 'Newest first' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Sender' }))
    expect(screen.queryByRole('menuitemradio', { name: 'Newest first' })).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'Z → A' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Importance' }))
    expect(screen.getByRole('menuitemradio', { name: 'Highest first' })).toBeTruthy()
  })

  test('选方向写 store；默认是 desc', async () => {
    await renderHeader()
    openMenu()
    expect(useEmailFilter.getState().sortDir).toBe('desc')
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Oldest first' }))
    expect(useEmailFilter.getState().sortDir).toBe('asc')
  })
})

describe('清除筛选 / 激活指示', () => {
  test('无筛选时既没有「清除筛选」行、过滤钮也不亮；有了就都出现', async () => {
    await renderHeader()
    const btn = screen.getByRole('button', { name: 'Filter mail' })
    expect(btn.getAttribute('data-active')).toBe('false')
    openMenu()
    expect(screen.queryByRole('menuitem', { name: 'Clear filters' })).toBeNull()

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Has attachments/ }))
    expect(btn.getAttribute('data-active')).toBe('true')
    expect(screen.getByRole('menuitem', { name: 'Clear filters' })).toBeTruthy()
  })

  test('🔴 只换排序不算「有筛选」（否则激活点常亮）', async () => {
    await renderHeader()
    openMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Subject' }))
    expect(screen.getByRole('button', { name: 'Filter mail' }).getAttribute('data-active')).toBe(
      'false'
    )
    expect(screen.queryByRole('menuitem', { name: 'Clear filters' })).toBeNull()
  })

  test('点「清除筛选」把所有轴归零', async () => {
    await renderHeader()
    openMenu()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Unread/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear filters' }))
    expect(useEmailFilter.getState().unread).toBe(false)
    expect(useEmailFilter.getState().hasActiveFilter()).toBe(false)
  })
})

// ── 两行结构（task 08-27 P1 Lane B）────────────────────────────────────────
//
// 「行高与收件箱一致」是几何事实，happy-dom 不算布局量不到；能测的是它的**成立条件**：
// 第二行右端那对 28px 工具钮在四种变体里都在场，分栏只是它左边的可选项。真掉了行高
// 就守不住 —— 这条断言掉了就说明有人把工具钮挪进了分栏的条件分支。
describe('列表头两行结构', () => {
  test('收件箱: 第二行 = 分栏 + 统计 + 批量/筛选', async () => {
    await renderHeader()
    expect(screen.getByRole('tablist', { name: 'Inbox view' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Enter batch mode' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Filter mail' })).toBeTruthy()
    expect(screen.getByText(/total/)).toBeTruthy()
  })

  test('非收件箱视图: 分栏消失, 统计与工具钮原样在场', async () => {
    await renderHeader()
    useEmailFilter.getState().setView('drafts')
    await screen.findByRole('button', { name: 'Filter mail' })
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByRole('button', { name: 'Enter batch mode' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Filter mail' })).toBeTruthy()
    expect(screen.getByText(/total/)).toBeTruthy()
  })

  test('自定义文件夹: 同样没有分栏（分栏只属于收件箱）', async () => {
    await renderHeader()
    useEmailFilter.getState().setCustomMailbox('Jira', ['Jira'])
    await screen.findByRole('button', { name: 'Filter mail' })
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByText(/total/)).toBeTruthy()
  })

  test('写邮件 CTA 在第一行（原来在二级栏，二级栏对邮件域已不渲染）', async () => {
    await renderHeader()
    expect(screen.getByRole('button', { name: 'Compose' })).toBeTruthy()
  })
})

describe('快捷键（菜单关着也生效）', () => {
  test('⇧⌘O 未读 / ⌥⌘O 已标记 / ⇧⌘A 具有附件', async () => {
    await renderHeader()
    fireEvent.keyDown(document, { key: 'o', metaKey: true, shiftKey: true })
    expect(useEmailFilter.getState().unread).toBe(true)
    fireEvent.keyDown(document, { key: 'o', metaKey: true, altKey: true })
    expect(useEmailFilter.getState().flagMark).toBe('flagged')
    fireEvent.keyDown(document, { key: 'a', metaKey: true, shiftKey: true })
    expect(useEmailFilter.getState().hasAttach).toBe(true)
    // 再按一次 = 取消（都是 toggle）。
    fireEvent.keyDown(document, { key: 'o', metaKey: true, altKey: true })
    expect(useEmailFilter.getState().flagMark).toBeNull()
  })
})
