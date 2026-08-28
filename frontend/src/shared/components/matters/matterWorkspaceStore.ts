// 事项工作台的**模块级** UI 状态（tab / 选中 / 搜索 / 筛选 / 折叠组）。
//
// 为什么提升出组件（task 08-20 P0-3）：`MattersWorkspace` 随路由切换整树卸载，本地 useState
// 每次回来都复位 —— tab 复位 `'board'`、`initialSelectionApplied` 复位 false ⇒ 每次进入都要
// 先渲染一帧看板、等 `/matters` 回来再由冷启动 effect 翻到清单，这就是「每次进事项页都抖一下」
// 的来源；顺带搜索词与筛选也一并丢失。放进模块级 store 后，切走再回直接是上次那一屏。
//
// 🔴 持久化边界：只有「上次选中的事项」落 localStorage（`matterLastSelected`，冷启动 seed），
// 其余全是**会话级**。store 是运行时权威 —— 选中变化时顺手写一次 seed，读 seed 只发生在冷启动
// effect（且要过一遍「这条现在还可见吗」的判定，见 MattersWorkspace）。tab / 搜索 / 筛选不持久
// 化是有意的：带着一个筛选重启应用、然后看到一个「空列表」，是 bug 不是特性（同 email-filter
// 里五条二值轴不持久化的先例）。
//
// 形态跟随仓内既有 store（`navigation.ts` 的 `useMatterNavigation`、`@shared/state/*`）：
// 裸 `create()`、action 与 state 同居，无 middleware。

import { create } from 'zustand'

import { usePopoutMode } from '@shared/state/popout-mode'
import { selectActiveTargetId, useTabWorkspace } from '@shared/state/tab-workspace'
import { openObjectTab, replaceObjectTab } from '@shared/state/tab-workspace-bridge'

import { DEFAULT_MATTER_LIST_QUERY, matterScopeOf } from './matterListQuery'
import type {
  MatterListQuery,
  MatterQuickFilter,
  MatterScopeFields,
  MatterTab
} from './matterListQuery'
import { matterNumericId, matterPublicIdOf } from './matterTabIdentity'
import { writeLastSelectedMatterId } from './matterLastSelected'

export interface MatterWorkspaceState {
  tab: MatterTab
  query: MatterListQuery
  search: string
  selectedId: string | null
  /** V3-05 行内分组的折叠态（key 自带维度前缀，见 matterListQuery::MatterGroup）。 */
  collapsedGroups: ReadonlySet<string>
  /** 冷启动「记住上次选中 / 选第一条」是否已跑过 —— 提升到 store 后，重进事项页不再重挑一次。 */
  initialSelectionApplied: boolean
  setTab(tab: MatterTab): void
  setQuery(query: MatterListQuery): void
  setSearch(search: string): void
  /**
   * V3-11 —— 只在选中一条真实事项时持久化 seed；取消选中（`publicId === null`，例如「选中项
   * 掉出可见集就丢选中」守卫）不清空记录：记录留着，下次冷启动按「当前 scope 可见集里找不找
   * 得到」重新判定，找不到自然退化成选第一条。
   *
   * 08-27 标签工作区（Lane W）—— selectMatter 是事项侧的**唯一桥**（对应 active-email 的
   * setActive）：非空选中转发标签 store（默认 openTab = 点行/程序化 reveal；`mode:'replace'`
   * = 详情上/下条与冷启动初选，原位换目标不涨标签数）。`publicId === null` 是视图局部的
   * 取消选中，标签不动。索引未命中（对象还没进过任何数据面）时只落本地选中，不落标签。
   */
  selectMatter(publicId: string | null, opts?: { mode?: 'open' | 'replace'; title?: string }): void
  /**
   * 展示某个具体事项（看板卡片 / 深链 / 新建落点）：切到清单并把筛选复位到「该事项可见」的
   * 最小状态 —— 本模块有「选中项掉出可见集就丢选中」守卫，保留旧筛选会让跳转当场被守卫吞掉。
   */
  revealMatter(matter: MatterScopeFields & { public_id: string; title?: string }): void
  /** V3-13 —— 看板 tile 的跳转载荷：切到清单 tab 并套用对应快捷筛选预设，其余条件一并复位。 */
  applyQuickFilter(quick: MatterQuickFilter): void
  toggleGroup(key: string): void
  clearCollapsedGroups(): void
  /** reveal-on-navigate：把选中项所在的折叠组展开（详情上/下条导航要求）。 */
  expandGroups(keys: readonly string[]): void
  markInitialSelectionApplied(): void
}

const EMPTY_COLLAPSED: ReadonlySet<string> = new Set<string>()

function initialState(): Pick<
  MatterWorkspaceState,
  'tab' | 'query' | 'search' | 'selectedId' | 'collapsedGroups' | 'initialSelectionApplied'
> {
  return {
    // V3-01 —— 默认落看板（≙ 旧默认 view 'focus'）；有有效的「记住上次选中」记录时，
    // MattersWorkspace 的冷启动 effect 会把它改成 'list'。
    tab: 'board',
    query: DEFAULT_MATTER_LIST_QUERY,
    search: '',
    selectedId: null,
    collapsedGroups: EMPTY_COLLAPSED,
    initialSelectionApplied: false
  }
}

// 选中 → 标签 store 的转发半边。先落本地再转发（active-email.setActive 同款次序）：
// 转发引起的标签提交触发下方订阅时投影值已相等，不会二次覆写。
function forwardMatterSelectToTab(
  publicId: string,
  opts?: { mode?: 'open' | 'replace'; title?: string }
): void {
  if (usePopoutMode.getState().isPopout) return
  const numericId = matterNumericId(publicId)
  if (numericId === null) return
  if (opts?.mode === 'replace') replaceObjectTab('matter', numericId, opts?.title)
  else openObjectTab('matter', numericId, opts?.title)
}

export const useMatterWorkspace = create<MatterWorkspaceState>((set) => ({
  ...initialState(),
  setTab: (tab) => set({ tab }),
  setQuery: (query) => set({ query }),
  setSearch: (search) => set({ search }),
  selectMatter: (selectedId, opts) => {
    if (selectedId) writeLastSelectedMatterId(selectedId)
    set({ selectedId })
    if (selectedId) forwardMatterSelectToTab(selectedId, opts)
  },
  revealMatter: (matter) => {
    writeLastSelectedMatterId(matter.public_id)
    set({
      tab: 'list',
      search: '',
      query: { ...DEFAULT_MATTER_LIST_QUERY, scope: matterScopeOf(matter) },
      selectedId: matter.public_id
    })
    forwardMatterSelectToTab(matter.public_id, { title: matter.title })
  },
  applyQuickFilter: (quick) =>
    set({ tab: 'list', search: '', query: { ...DEFAULT_MATTER_LIST_QUERY, quick: [quick] } }),
  toggleGroup: (key) =>
    set((state) => {
      const next = new Set(state.collapsedGroups)
      if (!next.delete(key)) next.add(key)
      return { collapsedGroups: next }
    }),
  clearCollapsedGroups: () =>
    set((state) =>
      state.collapsedGroups.size === 0 ? state : { collapsedGroups: EMPTY_COLLAPSED }
    ),
  expandGroups: (keys) =>
    set((state) => {
      if (state.collapsedGroups.size === 0) return state
      const next = new Set(state.collapsedGroups)
      let changed = false
      for (const key of keys) changed = next.delete(key) || changed
      return changed ? { collapsedGroups: next } : state
    }),
  markInitialSelectionApplied: () => set({ initialSelectionApplied: true })
}))

// 标签 store → selectedId 的反向投影（事件驱动：只对「激活事项目标变化」动作，
// 「选中项掉出可见集」的本地清空不会被无关标签提交翻回来 —— active-email 同款模型）。
// 顺带切到清单 tab：从标签条激活一件事，落在看板上是看不见它的。
useTabWorkspace.subscribe((state, prev) => {
  if (usePopoutMode.getState().isPopout) return
  const projected = selectActiveTargetId(state, 'matter')
  const prevProjected = selectActiveTargetId(prev, 'matter')
  if (projected !== prevProjected && projected !== null) {
    const publicId = matterPublicIdOf(projected)
    if (publicId !== null && publicId !== useMatterWorkspace.getState().selectedId) {
      writeLastSelectedMatterId(publicId)
      useMatterWorkspace.setState({ selectedId: publicId, tab: 'list' })
    }
    return
  }
  // 选中项对应的标签被关掉、且没有别的事项标签接管激活位 → 清选中（留着会让工作台
  // 展示一件「标签条上已经没有」的事）。
  const cur = useMatterWorkspace.getState().selectedId
  if (cur === null || projected !== null) return
  const curId = matterNumericId(cur)
  if (curId === null) return
  const existedBefore = prev.tabs.some((t) => t.kind === 'matter' && t.targetId === curId)
  const existsNow = state.tabs.some((t) => t.kind === 'matter' && t.targetId === curId)
  if (existedBefore && !existsNow) useMatterWorkspace.setState({ selectedId: null })
})

/** 测试用复位 —— 模块级 store 会跨用例存活，不复位就是用例间互相污染。 */
export function resetMatterWorkspace(): void {
  useMatterWorkspace.setState(initialState())
}
