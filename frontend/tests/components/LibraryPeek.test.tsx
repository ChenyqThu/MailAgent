// @vitest-environment happy-dom
//
// 资料库域 peek 的登记闸（P1-L8）。
//
// 🔴 `NavPeek.PAGE_LISTS` 是 `Partial<Record<NavDomain, …>>`：page 域漏登记**不会**编译红，
// 只会在折叠态 hover 资料库格时浮出一个空面板（DomainPanel 对 page 域投影不出任何行）。
// 群聊拆域时同一个坑已经踩过一次（见 sidebar-contract 里那条同款注释），故这里从
// 「NavPeek 拿到 domain='library' 时渲染的是不是资料库清单」这一侧钉死。
//
// 顺带钉点行的两段动作：写域内选中态 + 落**干净**的 `/library`（不是回放本域上次的
// location —— 那可能带着 `?file=`，会把刚点的文件夹盖成某个文件）。
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider
} from '@tanstack/react-router'

import type { LibraryTreeResponse } from '@shared/api/types/library'

// 树数据 —— 只换这一个 hook，`useLibraryApi` / 上传 / 失效那一串保持真身。
const { fixture } = vi.hoisted(() => ({
  fixture: {
    data: {
      folders: [
        { path: 'my-docs', parent_path: '', name: 'my-docs', mount_id: 0, file_count: 2 },
        { path: 'my-docs/notes', parent_path: 'my-docs', name: 'notes', mount_id: 0, file_count: 5 }
      ],
      mounts: [],
      file_count: 7
    } as LibraryTreeResponse | undefined,
    isPending: false
  }
}))

vi.mock('@shared/components/library/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/components/library/hooks')>()
  return {
    ...actual,
    useLibraryTreeQuery: () =>
      ({ data: fixture.data, isPending: fixture.isPending }) as unknown as ReturnType<
        typeof actual.useLibraryTreeQuery
      >
  }
})

import i18n from '../../src/shared/i18n'
import { NavPeek } from '../../src/shared/components/layout/NavPeek'
import { resetLibraryTreeState, useLibraryTree } from '../../src/shared/state/library-tree'

const noop = (): void => {}

async function renderPeek(onClose = noop): Promise<{
  container: HTMLElement
  router: ReturnType<typeof createRouter>
}> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({
    component: () => (
      <I18nextProvider i18n={i18n}>
        <NavPeek
          domain="library"
          width={336}
          entries={[]}
          onEntryClick={noop}
          onEntryHover={noop}
          onClose={onClose}
          onPointerEnter={noop}
          onPointerLeave={noop}
        />
      </I18nextProvider>
    )
  })
  const shellRouter = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => <div /> }),
      createRoute({ getParentRoute: () => rootRoute, path: '/library', component: () => <div /> })
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] })
  }) as ReturnType<typeof createRouter>
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={shellRouter} />
    </QueryClientProvider>
  )
  await waitFor(() => {
    expect(container.querySelector('[data-nav-peek="library"]')).toBeTruthy()
  })
  return { container, router: shellRouter }
}

function rowLabels(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll('[data-nav-peek-list="library"] .row span.flex-1')
  ).map((el) => el.textContent?.trim() ?? '')
}

beforeEach(async () => {
  window.localStorage.clear()
  resetLibraryTreeState()
  fixture.isPending = false
  await i18n.changeLanguage('zh-CN')
})

afterEach(() => cleanup())

describe('资料库 peek', () => {
  test('NavPeek 对 library 域分派到资料库清单（PAGE_LISTS 登记闸）', async () => {
    const { container } = await renderPeek()
    // 漏登记时这里是 null，渲染出来的是 DomainPanel（page 域投影不出任何行的空壳）。
    await waitFor(() => {
      expect(container.querySelector('[data-nav-peek-list="library"]')).toBeTruthy()
    })
    expect(container.querySelector('[data-nav-panel]')).toBeNull()
    // 内置根走 slug → i18n；子目录用服务端给的末段名（my-docs 缺省展开）。
    await waitFor(() => {
      expect(rowLabels(container)).toEqual([
        '邮件附件',
        '对话附件',
        'Agents 文档',
        '我的文档',
        'notes',
        '废纸篓'
      ])
    })
  })

  test('点行 = 展开并选中该文件夹 + 落干净的 /library + 收浮层', async () => {
    const onClose = vi.fn()
    const { container, router } = await renderPeek(onClose)
    const navigate = vi.spyOn(router, 'navigate').mockImplementation(async () => {})
    await waitFor(() => expect(rowLabels(container)).toContain('notes'))

    const row = container.querySelector<HTMLElement>('[data-library-path="my-docs/notes"]')
    expect(row).toBeTruthy()
    fireEvent.click(row!)

    expect(useLibraryTree.getState().selectedPath).toBe('my-docs/notes')
    // revealPath 展开每一层祖先 —— 进域后那一行在树上是可见的，不是折在 my-docs 里。
    expect(useLibraryTree.getState().expanded.has('my-docs')).toBe(true)
    // 🔴 落点不带 search：带着上次的 `?file=` 回去 = 点了文件夹却打开了某个文件。
    expect(navigate.mock.calls.at(-1)?.[0]).toEqual({ to: '/library' })
    expect(onClose).toHaveBeenCalled()
    navigate.mockRestore()
  })

  test('数据没到时先骨架（没访问过这个域的第一帧）', async () => {
    fixture.isPending = true
    const { container } = await renderPeek()
    await waitFor(() => {
      expect(container.querySelector('[data-nav-peek-skeleton]')).toBeTruthy()
    })
    expect(container.querySelector('[data-library-path]')).toBeNull()
  })
})
