// @vitest-environment happy-dom
//
// V3-11 —— 「记住上次选中」冷启动判定的行为闸（设计 HANDOFF-列表与资料-v3.md §1）。
// MatterList/MatterDetail/MatterFocus 全部换成瘦身桩：这五个用例钉的是 MattersWorkspace 自己
// 的 selectedId/tab 编排（存/取「上次选中」、有记录/无记录/记录已不可见三路分叉、切 tab 不
// 清空选中、深链跳转优先级更高），不是那三个组件各自的渲染细节——它们已经有自己的测试文件。
//
// 🔴 持久化层走 `vi.mock('@shared/components/matters/matterLastSelected')` 换成内存实现，
// 不碰真实 `localStorage`：本仓当前 vitest + happy-dom + Node 组合下，happy-dom 环境里裸
// `localStorage`/`window.localStorage` 本身就取不到（`tests/components/CommandPalette.test.tsx`
// 的 `localStorage.clear()` 也包了一层 try/catch 才没红，实测在这里两者皆 `undefined`）——
// 拆出独立小模块正是为了让这条闸不依赖这个环境限制。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import i18n from '@shared/i18n'
import type { Matter } from '@shared/api/types/matter'

await i18n.changeLanguage('zh-CN')

// vi.mock 的调用会被提升到文件顶部（早于下面的 import/const）——固定装置必须走
// vi.hoisted，直接在下面 const 里引用会撞 TDZ（vitest 官方文档明写的坑）。
const { A, B, C, TEST_MATTERS, lastSelectedStore } = vi.hoisted(() => {
  function matter(overrides: Record<string, unknown> = {}): Matter {
    return {
      id: 1,
      public_id: 'MAT-0001',
      title: 'Ship the release',
      background: '',
      goal: '',
      matter_type: null,
      tags: [],
      status: 'active',
      health: 'unknown',
      priority: 'p1',
      owner_id: null,
      source: 'manual',
      due_at: null,
      waiting_context: null,
      next_attention_at: null,
      attention_reason: null,
      last_activity_at: null,
      latest_accepted_update_id: null,
      current_summary: null,
      summary_at: null,
      summary_by_kind: null,
      summary_by_id: null,
      version: 1,
      archived_at: null,
      archived_by_kind: null,
      archived_by_id: null,
      deleted_at: null,
      deleted_by_kind: null,
      deleted_by_id: null,
      purge_after: null,
      created_at: 1,
      updated_at: 1,
      ...overrides
    } as Matter
  }
  // B 的优先级（p0）压过 A（p2），是默认排序（rank）下「无记录 → 选第一条」的自然落点；
  // A 不是自然第一名，专门用来证明「有记录」时读的确实是持久化记录、不是巧合命中第一条。
  // C 已归档（task 08-14 起默认 scope='all' 含 done/canceled，「已完成」不再是「已不可见」
  // 的落点 —— 只有 archived/trash 才是；下面的 mock `list()` 照真实服务端「无参数 → 只回
  // 活跃行」语义把它挡在 liveMatters 之外，用来钉「有记录但已不可见」的退化路径）。
  // 08-27 标签工作区：数值 id 必须互异 —— 它是标签 store 的 targetId（id↔public_id 双向索引），
  // 同 id 会让后注册的覆盖先注册的。
  const a = matter({ id: 11, public_id: 'MAT-0001', priority: 'p2' })
  const b = matter({ id: 12, public_id: 'MAT-0002', priority: 'p0' })
  const c = matter({ id: 13, public_id: 'MAT-0003', priority: 'p3', archived_at: 10 })
  return {
    A: a,
    B: b,
    C: c,
    TEST_MATTERS: [a, b, c],
    lastSelectedStore: { value: null as string | null }
  }
})

vi.mock('@shared/components/matters/matterLastSelected', () => ({
  readLastSelectedMatterId: () => lastSelectedStore.value,
  writeLastSelectedMatterId: (publicId: string) => {
    lastSelectedStore.value = publicId
  }
}))

vi.mock('@shared/components/matters/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/components/matters/hooks')>()
  return {
    // options 工厂用真实现（liveList 的 key/缓存配方单源, 抄进 mock 就成第二份镜像）。
    matterLiveListOptions: actual.matterLiveListOptions,
    useMattersApi: () => ({
      // MattersWorkspace 冷启动只发一个 `list({limit:100})`（liveMatters）——照真实服务端
      // 默认子句 `deleted_at IS NULL AND archived_at IS NULL` 过滤，C（已归档）不进活跃集。
      list: async () => {
        const items = TEST_MATTERS.filter(
          (matter) => matter.archived_at == null && matter.deleted_at == null
        )
        return { items, total: items.length }
      }
    }),
    useMatterFlags: () => ({ mattersEnabled: true, matterAgentEnabled: false }),
    usePendingMatterUpdates: () => ({ data: undefined, isLoading: false }),
    useGlobalAttention: () => ({ data: { items: [] } }),
    useAttentionAction: () => ({ mutate: vi.fn() })
  }
})

vi.mock('@shared/components/matters/MatterFocus', () => ({
  MatterFocus: () => <div data-testid="matter-focus" />
}))
// 行按 public_id 出一个可点的桩按钮 —— 波 2 起清单列在看板视图下也在场，「点行等于去看
// 那件事」这条编排（MattersWorkspace::handleSelectMatter）需要一个真实的点击入口来钉。
vi.mock('@shared/components/matters/MatterList', () => ({
  MatterList: (props: {
    selectedId: string | null
    matters: readonly Matter[]
    onSelect(matter: Matter): void
  }) => (
    <div
      data-testid="matter-list"
      data-selected-id={props.selectedId ?? ''}
      data-matter-count={props.matters.length}
    >
      {props.matters.map((matter) => (
        <button key={matter.public_id} type="button" onClick={() => props.onSelect(matter)}>
          {matter.public_id}
        </button>
      ))}
    </div>
  )
}))
vi.mock('@shared/components/matters/MatterDetail', () => ({
  MatterDetail: (props: { matterId: string }) => (
    <div data-testid="matter-detail" data-matter-id={props.matterId} />
  )
}))
// 开合态要可观察 —— 波 2 的「新建事项」行是唯一常驻创建入口，它有没有真的开出弹窗是本
// 文件的断言对象之一（原来的桩恒 null，点了也看不出区别）。
vi.mock('@shared/components/matters/MatterCreateDialog', () => ({
  MatterCreateDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="matter-create-dialog" /> : null
}))
vi.mock('@shared/components/matters/MatterTagManagerModal', () => ({
  MatterTagManagerModal: () => null
}))

const { MattersWorkspace } = await import('@shared/components/matters/MattersWorkspace')
const { useMatterNavigation } = await import('@shared/components/matters/navigation')
const { resetMatterWorkspace, useMatterWorkspace } =
  await import('@shared/components/matters/matterWorkspaceStore')
const { MAIN_SLOT, useTabWorkspace } = await import('@shared/state/tab-workspace')
const { _resetMatterIdentityForTest, registerMatterIdentity } =
  await import('@shared/components/matters/matterTabIdentity')

function renderWorkspace(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MattersWorkspace />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  lastSelectedStore.value = null
  useMatterNavigation.setState({ targetPublicId: null })
  // 🔴 task 08-20：tab / 选中 / 搜索 / 筛选 / 冷启动标记搬进了**模块级** store（就是为了
  // 「切走再回还是上一屏」），它会跨用例存活 —— 不复位的话第二个用例一上来就已经落在
  // 上一个用例留下的 tab 与选中上。
  resetMatterWorkspace()
  // 08-27 标签工作区：selectMatter 转发标签 store（也是模块级），身份索引同样跨用例存活。
  useTabWorkspace.setState({ tabs: [], active: MAIN_SLOT, closedStack: [] })
  _resetMatterIdentityForTest()
})
afterEach(cleanup)

describe('MattersWorkspace — V3-11 记住上次选中', () => {
  test('有记录且可见 → 落「事项」tab 并选中那条', async () => {
    lastSelectedStore.value = A.public_id
    renderWorkspace()

    const detail = await screen.findByTestId('matter-detail')
    expect(detail.getAttribute('data-matter-id')).toBe(A.public_id)
    expect(screen.getByRole('button', { name: '事项' }).getAttribute('aria-current')).toBe('page')
  })

  test('有记录但已不可见（已归档）→ 退化成选第一条，且不强制切 tab', async () => {
    lastSelectedStore.value = C.public_id
    renderWorkspace()

    // 冷启动默认落看板；只有「有记录且可见」才会被拽去事项 tab —— 退化路径不该顺带改动 tab。
    expect(await screen.findByTestId('matter-focus')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '事项' }))

    const list = await screen.findByTestId('matter-list')
    await waitFor(() => expect(list.getAttribute('data-selected-id')).toBe(B.public_id))
  })

  test('无记录 → 选第一条，且不强制切 tab', async () => {
    renderWorkspace()

    expect(await screen.findByTestId('matter-focus')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '事项' }))

    const list = await screen.findByTestId('matter-list')
    await waitFor(() => expect(list.getAttribute('data-selected-id')).toBe(B.public_id))
  })

  test('切到「看板」不清空选中，切回来仍是原来那条', async () => {
    lastSelectedStore.value = A.public_id
    renderWorkspace()

    expect((await screen.findByTestId('matter-detail')).getAttribute('data-matter-id')).toBe(
      A.public_id
    )

    fireEvent.click(screen.getByRole('button', { name: '今日看板' }))
    expect(await screen.findByTestId('matter-focus')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '事项' }))
    const detail = await screen.findByTestId('matter-detail')
    expect(detail.getAttribute('data-matter-id')).toBe(A.public_id)
  })

  test('深链跳转（useMatterNavigation）压过冷启动初选', async () => {
    lastSelectedStore.value = A.public_id
    useMatterNavigation.getState().open(B.public_id)
    renderWorkspace()

    const detail = await screen.findByTestId('matter-detail')
    await waitFor(() => expect(detail.getAttribute('data-matter-id')).toBe(B.public_id))
    expect(useMatterNavigation.getState().targetPublicId).toBeNull()
  })

  // 08-27 标签工作区（Lane W）——
  test('恢复的激活事项标签压过「记住上次选中」记录（冷启动初选不得覆盖恢复的激活标签）', async () => {
    lastSelectedStore.value = B.public_id
    useTabWorkspace.getState().openTab('matter', A.id, A.title)

    renderWorkspace()
    const detail = await screen.findByTestId('matter-detail')
    await waitFor(() => expect(detail.getAttribute('data-matter-id')).toBe(A.public_id))
    // 激活标签原样保留（没有被 replace 成 B）
    expect(useTabWorkspace.getState().active).toBe(`matter:${A.id}`)
    expect(useTabWorkspace.getState().tabs.map((t) => t.id)).toEqual([`matter:${A.id}`])
  })

  test('选中一条事项 = 开出事项标签（selectMatter 转发标签 store）', async () => {
    lastSelectedStore.value = A.public_id
    renderWorkspace()
    await screen.findByTestId('matter-detail')
    await waitFor(() =>
      expect(useTabWorkspace.getState().tabs.some((t) => t.id === `matter:${A.id}`)).toBe(true)
    )
    expect(useTabWorkspace.getState().active).toBe(`matter:${A.id}`)
  })
})

// task 08-20 P0-3 —— 「切走再回直接是上一屏」。旧结构里这些状态是 `MattersWorkspace` 的
// useState，路由离开整树卸载就复位：回来先渲染一帧看板、再由冷启动 effect 翻到清单（肉眼可见
// 的抖动），搜索词与筛选一并丢失。
describe('MattersWorkspace — 状态提升（task 08-20）', () => {
  test('卸载再挂载：tab / 选中 / 搜索 全部保留，且不重跑冷启动初选', async () => {
    lastSelectedStore.value = A.public_id
    const first = renderWorkspace()
    expect((await screen.findByTestId('matter-detail')).getAttribute('data-matter-id')).toBe(
      A.public_id
    )

    // 用户改了搜索词、又手动选了另一条（模拟一屏「工作现场」）。
    useMatterWorkspace.getState().setSearch('ship')
    useMatterWorkspace.getState().selectMatter(B.public_id)
    // 把 localStorage seed 掰回 A —— 它只是**冷启动** seed，运行时权威在 store。重挂时若又跑
    // 一遍冷启动初选，选中会被这颗 seed 冲回 A（这正是下面最后一条断言要挡的东西）。
    lastSelectedStore.value = A.public_id

    // 路由切走 = 整树卸载。
    first.unmount()
    renderWorkspace()

    // 回来直接就是那一屏：清单 tab、选中 B、搜索词还在 —— 中间没有「先看板后清单」的翻转。
    const list = await screen.findByTestId('matter-list')
    expect(list.getAttribute('data-selected-id')).toBe(B.public_id)
    expect(screen.getByRole('button', { name: '事项' }).getAttribute('aria-current')).toBe('page')
    expect(useMatterWorkspace.getState().search).toBe('ship')

    // 🔴 等这一遍的 `/matters` 落地再断言一次：冷启动初选**只做一次**，重挂时它若再跑一遍，
    // 选中会被悄悄冲回「上次选中」记录里的 A。（不等的话查询还没回来，effect 根本没机会跑，
    // 断言会恒绿。）
    await waitFor(() => expect(list.getAttribute('data-matter-count')).toBe('2'))
    expect(useMatterWorkspace.getState().selectedId).toBe(B.public_id)
  })
})

// task 08-20 P0-2 —— 看板的冷启动同样不许出误导空态：`matters=[]` 时真看板四个 tile 全是 0、
// 关注区还会写一句「全部处理完了」。
describe('MattersWorkspace — 看板冷启动骨架（task 08-20）', () => {
  test('数据到达前出看板骨架，到达后才换成真看板', async () => {
    renderWorkspace()

    expect(screen.getByTestId('matter-board-skeleton')).toBeTruthy()
    expect(screen.queryByTestId('matter-focus')).toBeNull()

    expect(await screen.findByTestId('matter-focus')).toBeTruthy()
    expect(screen.queryByTestId('matter-board-skeleton')).toBeNull()
  })
})

// task 08-14 —— PRD §5 验收第三条：范围默认 all，已归档/回收站的事项不出现。这里不是靠
// matterInScope 挡（scope='all' 对它恒真），而是靠 liveMatters 本身就是服务端「无参数只回
// 活跃行」的结果集 —— C（已归档）从未进入这份数据，「全部」自然只剩 A、B 两条。
describe('MattersWorkspace — scope 默认 all（task 08-14）', () => {
  test('已归档事项不出现在默认「全部」范围下的清单里', async () => {
    renderWorkspace()
    fireEvent.click(screen.getByRole('button', { name: '事项' }))

    const list = await screen.findByTestId('matter-list')
    await waitFor(() => expect(list.getAttribute('data-matter-count')).toBe('2'))
  })
})

// 08-27 dogfood 修正批 —— 42px 通栏模块 tab 栏退役，视图切换与「新建」收进清单列（336）
// 顶部的单行视图行（MatterViewNav）。
function viewNav(): HTMLElement {
  const host = document.querySelector('[data-matter-view-nav]')
  if (!host) throw new Error('view nav not rendered')
  return host as HTMLElement
}

describe('MattersWorkspace — 二级栏视图行', () => {
  test('看板视图下清单列仍在场：视图行与看板同屏（二级栏不随视图消失）', async () => {
    renderWorkspace()

    expect(await screen.findByTestId('matter-focus')).toBeTruthy()
    // 🔴 这条钉的正是本批的形态：原来 tab='board' 是通栏，清单列整个不渲染。
    expect(screen.getByTestId('matter-list')).toBeTruthy()
    expect(
      within(viewNav()).getByRole('button', { name: '今日看板' }).getAttribute('aria-current')
    ).toBe('page')
  })

  test('点行内两个视图钮切视图，选中态跟着搬家', async () => {
    renderWorkspace()
    await screen.findByTestId('matter-focus')

    fireEvent.click(within(viewNav()).getByRole('button', { name: '事项' }))
    expect(screen.queryByTestId('matter-focus')).toBeNull()
    expect(
      within(viewNav()).getByRole('button', { name: '事项' }).getAttribute('aria-current')
    ).toBe('page')
    expect(
      within(viewNav()).getByRole('button', { name: '今日看板' }).getAttribute('aria-current')
    ).toBeNull()

    fireEvent.click(within(viewNav()).getByRole('button', { name: '今日看板' }))
    expect(await screen.findByTestId('matter-focus')).toBeTruthy()
  })

  test('三个入口同在一行：两个视图钮 + 新建，没有第四个（段头/折叠钮）', async () => {
    renderWorkspace()
    await screen.findByTestId('matter-focus')

    // 🔴 钉的是「一行放得下就别折叠」：段头 + chevron 那套退役后，这一列顶部只剩三个钮，
    // 多出来的任何一个都意味着又长回了多行。
    const buttons = within(viewNav()).getAllByRole('button')
    expect(buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual([
      '今日看板',
      '事项',
      '新建事项'
    ])
  })

  test('看板视图下点清单行 = 去看那件事（选中 + 主区换成详情）', async () => {
    renderWorkspace()
    await screen.findByTestId('matter-focus')

    // 🔴 这条钉的是 handleSelectMatter 里的 setTab('list')：标签 store 的反向投影腿在这条
    // 路径上帮不上忙（它的判据是「投影值与当前选中不同」，而选中已经先设好了），少了那一
    // 行，点行只会静静地换选中、主区仍停在看板 —— 看着就是「点了没反应」。
    fireEvent.click(screen.getByRole('button', { name: A.public_id }))

    const detail = await screen.findByTestId('matter-detail')
    expect(detail.getAttribute('data-matter-id')).toBe(A.public_id)
    expect(screen.queryByTestId('matter-focus')).toBeNull()
  })

  test('「新建事项」钮仍是常驻创建入口（点开创建弹窗）', async () => {
    renderWorkspace()
    await screen.findByTestId('matter-focus')

    expect(screen.queryByTestId('matter-create-dialog')).toBeNull()
    fireEvent.click(within(viewNav()).getByRole('button', { name: '新建事项' }))
    expect(screen.getByTestId('matter-create-dialog')).toBeTruthy()
  })
})

describe('selectMatter — 开标签被拒时回滚本地投影（check 波3 续改）', () => {
  test('标签满且全 locked → selectedId 不落新值、标签没开、seed 不写', () => {
    registerMatterIdentity(21, 'MAT-0021')
    useTabWorkspace.setState({ maxTabs: 4 })
    for (let i = 1; i <= 4; i++) useTabWorkspace.getState().openTab('email', i, `邮件${i}`)
    for (const t of useTabWorkspace.getState().tabs) {
      useTabWorkspace.getState().updateTab(t.id, { locked: true })
    }
    useMatterWorkspace.getState().selectMatter('MAT-0021', { title: '开不进来' })
    // 回滚：不回滚 = 详情区展示 MAT-0021、标签条还高亮旧标签的劈叉（active-email 同形）
    expect(useMatterWorkspace.getState().selectedId).toBeNull()
    expect(useTabWorkspace.getState().tabs.some((t) => t.id === 'matter:21')).toBe(false)
    // seed 也不写 —— 写了会让冷启动去追一件根本没开成标签的事
    expect(lastSelectedStore.value).toBeNull()
  })

  test('未满 → 正常选中 + 开标签 + seed 落盘（回滚不误伤主路径）', () => {
    registerMatterIdentity(21, 'MAT-0021')
    useTabWorkspace.setState({ maxTabs: 8 })
    useMatterWorkspace.getState().selectMatter('MAT-0021', { title: '正常' })
    expect(useMatterWorkspace.getState().selectedId).toBe('MAT-0021')
    expect(useTabWorkspace.getState().tabs.some((t) => t.id === 'matter:21')).toBe(true)
    expect(lastSelectedStore.value).toBe('MAT-0021')
  })
})
