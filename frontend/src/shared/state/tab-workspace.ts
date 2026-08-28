// 标签工作区的状态单源（task 08-27-l4-tab-workspace P2 波1）。
//
// 右侧详情区从「单一对象槽」改成多标签：邮件与事项会开成对象标签（判据是「需不需要
// 同时开两个来比对」），外加一个「新标签页」搜索单例（TabKind 词表注释）；八个页面型
// 承载共用最左那个**主标签**单例槽 —— 所以主标签不在 `tabs` 数组里，它是独立的
// `mainPage` + `mainBreadcrumb`。
//
// 🔴 单挂载切换，不是多实例并存（design.md §一）：切标签只换 targetId，详情组件树
// 只有一份。滚动位置 / 草稿快照 / 抽屉开合挂在标签描述符上，切回来由消费方恢复。
// 这个 store 只管「有哪些标签、谁是激活的、每个标签记着什么」，**不解释** draft 的
// 内容，也不出 toast（i18n 在调用方 —— 同 pinned-folders 的 toggle 返回 false 先例）。
//
// 时钟：`lastActiveAt` 用**单调**时间戳（`nextStamp`），不是裸 Date.now()。同一毫秒内
// 连开两个标签时裸时间戳会打平，LRU 就成了「谁在数组里靠前」的偶然结果；单调化之后
// 顺序恒定，测试也不用 fake timers。值仍是墙钟量级，UI 想显示「上次查看于…」可直接用。
//
// 跨窗口：**有意不挂 storage 监听**（对照 nav-shell / group-collapse / pinned-folders
// 那几个偏好 store）。标签集是这一个窗口的工作状态不是偏好，镜像到别的窗口只会让两个
// 窗口抢同一个 active。弹出窗（popout-mode）本来就不渲染标签条。

import { create } from 'zustand'

// 只引类型：`import type` 编译期擦除，本模块运行时不依赖 registry（也就不拖 icon 桶）。
import type { NavDomain } from '@shared/navigation/registry'

const KEY = 'mailagent.tabs.v1'
/** 持久化 blob 的形状版本。对不上整份丢弃回默认（旧形状不做迁移 —— 标签集是可再生的
 *  工作状态，为它写迁移器不划算）。 */
const SCHEMA_VERSION = 1

// ── 词表 ────────────────────────────────────────────────────────────────────

/** 会开成对象标签的内容种类。email / matter 是对象（各归一个一级域）；`'search'` 是
 *  「新标签页」（⌘T / 标签条「+」）—— 单例（targetId 恒 `SEARCH_TARGET_ID`），承载在
 *  `/search` 路由上，不归任何域。它走标签的全部通用语义（LRU 可淘汰 / ⌘W 可关 /
 *  closedStack 可找回 / 持久化恢复），仅两处不同：标题恒定（渲染侧按 kind 取 i18n，
 *  不读快照）、**永不 locked**（没有草稿 / 抽屉工作现场，updateTab 丢弃锁定写入）。 */
export type TabKind = 'email' | 'matter' | 'search'

export const TAB_KINDS: readonly TabKind[] = ['email', 'matter', 'search']

/** 归属一级域的对象种类（= TabKind 减去无域的搜索标签）。 */
export type DomainTabKind = Exclude<TabKind, 'search'>

/** 搜索标签的固定 targetId（原型 `open('search', 0)` 同值）—— 单例判据就是现行的
 *  `kind + targetId` 去重，不另加特判。 */
export const SEARCH_TARGET_ID = 0

/** 标签种类 → 一级域。
 *  🔴 与 registry 的 `NAV_OBJECT_DOMAINS` 是同一件事的两种写法（那边是域名，这边是
 *  内容种类，单复数都不同，编译期对不上）。`NAV_OBJECT_DOMAINS` 的元素类型是
 *  `NavDomain` 而非字面量元组，拿不到字面量做 Exclude —— 故一致性靠闸：
 *  tests/shared/tab-workspace.test.ts 断言本表的值集 ≡ NAV_OBJECT_DOMAINS。
 *  registry 里新增一个对象域而这里没跟，那条闸会红。 */
export const TAB_KIND_DOMAIN = {
  email: 'mail',
  matter: 'matters'
} as const satisfies Record<DomainTabKind, NavDomain>

/** 对象域（会开标签的）。 */
export type ObjectDomain = (typeof TAB_KIND_DOMAIN)[DomainTabKind]

/** 主标签的八种承载 = 全部域减去对象域。**类型从 NavDomain 派生**，不手写第二份并集。 */
export type MainPage = Exclude<NavDomain, ObjectDomain>

/** 运行时表（持久化校验 + 设置面要遍历时用）。
 *  🔴 `satisfies Record<MainPage, true>` 是这里的一致性闸本身：registry 加一个页面域
 *  而这里漏填 → 缺键，typecheck 当场红；填了个不存在的域 → 多键，同样红。 */
const MAIN_PAGE_SET = {
  today: true,
  calendar: true,
  contacts: true,
  chats: true,
  agents: true,
  reports: true,
  ops: true,
  settings: true
} satisfies Record<MainPage, true>

export const MAIN_PAGES = Object.keys(MAIN_PAGE_SET) as readonly MainPage[]

export const DEFAULT_MAIN_PAGE: MainPage = 'today'

/** 激活槽的「主标签」取值。对象标签的 id 形如 `email:53675`，永远不会撞上它。 */
export const MAIN_SLOT = 'main'

export type TabId = string
/** 激活槽：`MAIN_SLOT` 或某个对象标签的 id（TS 会把这个并集折叠成 string，
 *  留着别名是为了让签名读得出意图）。 */
export type ActiveSlot = typeof MAIN_SLOT | TabId

export const MAX_TABS_DEFAULT = 8
export const MAX_TABS_MIN = 4
export const MAX_TABS_MAX = 12

/** 草稿快照 —— store **不解释**内容，形状由消费方定。
 *  🔴 必须 JSON 可序列化：它跟着标签一起进 localStorage。真实草稿仍走后端草稿箱，
 *  这里只是「切回来时输入框里还是那些字」的快照。 */
export type DraftSnapshot = Record<string, unknown>

export interface TabDescriptor {
  /** 稳定 id = 去重键 = `${kind}:${targetId}`。 */
  readonly id: TabId
  readonly kind: TabKind
  readonly targetId: number
  /** 标题快照（避免标签条每次渲染都去查数据）。数据到位后消费方 `updateTab` 刷新。 */
  readonly title: string
  /** LRU 依据：最后一次成为激活标签的单调时间戳。 */
  readonly lastActiveAt: number
  /** 正在写回复 / 抽屉里聊过 → 不参与自动淘汰（标签上画琥珀点）。 */
  readonly locked: boolean
  readonly draft?: DraftSnapshot
  readonly drawerOpen: boolean
  readonly scrollTop: number
}

export function tabId(kind: TabKind, targetId: number): TabId {
  return `${kind}:${targetId}`
}

/** 搜索标签的稳定 id（单例 ⇒ 恒等于这一个）。 */
export const SEARCH_TAB_ID: TabId = tabId('search', SEARCH_TARGET_ID)

// ── 返回值契约 ──────────────────────────────────────────────────────────────

export interface EvictedTab {
  readonly id: TabId
  readonly title: string
}

/** openTab 的三种结局。调用方据此出 toast（store 不认识 i18n）：
 *  - `activated`：已经开着，只是激活了它，不该出任何提示；
 *  - `opened`：开了新标签；`evicted` 非空时说明顺带关掉了谁；
 *  - `rejected`：满了且**全部锁定**（写回复中 / 抽屉聊过），没开也没关，提示用户先关一个。 */
export type OpenTabResult =
  | { readonly outcome: 'activated'; readonly id: TabId }
  | { readonly outcome: 'opened'; readonly id: TabId; readonly evicted: readonly EvictedTab[] }
  | { readonly outcome: 'rejected'; readonly reason: 'all-locked' }

/** replaceActiveTab 比 openTab 多一种结局：当前标签**原位换了目标**（没开新的也没关旧的）。
 *  🔴 toast 判据仍然只看 `opened` 带 evicted / `rejected` 两支 —— 原位变身与 activated
 *  都是「用户自己按 J 换了一封」，出提示是噪音。 */
export type ReplaceTabResult =
  | OpenTabResult
  | { readonly outcome: 'replaced'; readonly id: TabId; readonly previousId: TabId }

/** 最近关闭栈的条目（⌘⇧T 用）。只记身份与标题快照 —— 草稿 / 滚动位置随标签一起没了，
 *  恢复的是「那个对象」，不是「那次会话现场」。 */
export interface ClosedTab {
  readonly kind: TabKind
  readonly targetId: number
  readonly title: string
}

/** 最近关闭栈的深度。不持久化（重启后 ⌘⇧T 从空开始）—— 跨会话「恢复上次关掉的东西」
 *  本来就由标签集自身的持久化承担。 */
export const CLOSED_STACK_CAP = 10

/** updateTab 可写的字段（id / kind / targetId 是身份，不可改；lastActiveAt 归激活语义管）。 */
export type TabPatch = Partial<
  Pick<TabDescriptor, 'title' | 'locked' | 'draft' | 'drawerOpen' | 'scrollTop'>
>

export interface TabWorkspaceState {
  readonly tabs: readonly TabDescriptor[]
  readonly active: ActiveSlot
  readonly mainPage: MainPage
  /** 主标签面包屑的第二段（由当前承载页自己 set）。null = 单段，不显分隔符。 */
  readonly mainBreadcrumb: string | null
  readonly maxTabs: number
  /** 最近关闭栈，**末尾 = 最近关掉的**。不持久化。关闭与 LRU 自动淘汰都进栈
   *  （被挤掉的也能 ⌘⇧T 找回），原位变身不进（见 replaceActiveTab）。 */
  readonly closedStack: readonly ClosedTab[]

  /** 开 / 激活一个对象标签。`title` 省略或空串时不覆盖已有标题（deeplink 这类
   *  拿不到标题的入口先开着，详情加载完再 `updateTab` 补）。 */
  openTab(kind: TabKind, targetId: number, title?: string): OpenTabResult
  /** J/K 导航、归档后续选 —— 在**当前激活的对象标签里原位换目标**，不是每按一次开一个
   *  （连按十次 J 开十个标签会把 LRU 打爆）。三条分支：
   *  - 目标已经开在**别的**标签里 → 只激活它，当前标签原样保留（不关不改）；
   *  - 当前激活的是主标签，**或**当前标签已锁定 → 退回 openTab 语义（开新的）。
   *    🔴 锁定态不原位变身：锁定的含义就是「这里有没完成的工作」，变身会把草稿快照
   *    与抽屉状态一起抹掉 —— 连自动淘汰都不许碰的东西，J 一下更不该碰。
   *  - 其余 → 原位变身：id 按新 kind+targetId 重算，title 换，lastActiveAt 刷新，
   *    draft / scrollTop / drawerOpen / locked 一律回默认（新目标没写过任何东西）。
   *  变身掉的旧目标**不进最近关闭栈** —— 否则翻十封邮件就把 ⌘⇧T 的队列灌满，
   *  而「回到上一封」本来就是 K 的事。 */
  replaceActiveTab(kind: TabKind, targetId: number, title?: string): ReplaceTabResult
  /** ⌘⇧T：弹出最近关掉的那个重开（走 openTab 全套语义，含去重与 LRU）。栈空返回 null。
   *  开不成（满且全锁定）时条目**留在栈里**，等用户腾出位置再按一次。 */
  reopenLastClosed(): OpenTabResult | null
  /** draft replace 语义（task 08-20）：保存成功后服务端删旧行、建镜像新行 —— 标签跟着
   *  换锚，否则标签指着已删行（重启后成死标签）。这是**身份延续**不是「关一个开一个」：
   *  title / draft / scrollTop / drawerOpen / locked / lastActiveAt / 标签条位置全保留，
   *  只换 id 与 targetId（TabPatch 有意排除 targetId，换锚走这个独立动作）。
   *  新 targetId 已有同类标签时合并：保留带着会话现场的这一个，移除重复者 ——
   *  重复者**不进最近关闭栈**（合并不是用户关闭，⌘⇧T 捞回一个重复标签毫无意义）。
   *  激活槽指向两者任一时改指合并后的标签（激活态连续，lastActiveAt 不刷新）。 */
  retargetTab(kind: TabKind, oldTargetId: number, newTargetId: number): void
  closeTab(id: TabId): void
  activateTab(id: TabId): void
  activateMain(): void
  /** 切主标签承载（隐含激活主标签）。切到**别的**页面时清掉面包屑第二段。 */
  setMainPage(page: MainPage): void
  setMainBreadcrumb(text: string | null): void
  /** draft / scrollTop / drawerOpen / locked / title 的收敛写入口。
   *  🔴 每次调用都会写一次 localStorage —— scrollTop 这类高频量请消费方自己节流
   *  （建议切走 / 卸载时写一次，别挂在每个 scroll 事件上）。 */
  updateTab(id: TabId, patch: TabPatch): void
  /** 设置「标签」节的上限，clamp 到 4-12。
   *  🔴 调低上限**不追溯**淘汰已开的标签（拖个滑杆就当场关掉几个正在看的东西太粗暴），
   *  只影响后续 openTab —— 下一次开新标签时按新上限一次收敛到位。 */
  setMaxTabs(next: number): void
}

// ── 单调时钟 ────────────────────────────────────────────────────────────────

let lastStamp = 0

function nextStamp(): number {
  const now = Date.now()
  lastStamp = now > lastStamp ? now : lastStamp + 1
  return lastStamp
}

// ── 持久化 ──────────────────────────────────────────────────────────────────

type PersistedSlice = Pick<TabWorkspaceState, 'tabs' | 'active' | 'mainPage' | 'maxTabs'>

function clampMaxTabs(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return Math.min(MAX_TABS_MAX, Math.max(MAX_TABS_MIN, Math.round(raw)))
}

function isTabKind(v: unknown): v is TabKind {
  return typeof v === 'string' && TAB_KINDS.includes(v as TabKind)
}

function isMainPage(v: unknown): v is MainPage {
  return typeof v === 'string' && Object.hasOwn(MAIN_PAGE_SET, v)
}

function parseTab(raw: unknown): TabDescriptor | null {
  if (raw === null || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  if (!isTabKind(rec.kind)) return null
  const targetId = rec.targetId
  if (typeof targetId !== 'number' || !Number.isInteger(targetId)) return null
  // 搜索标签是单例：targetId 只有 SEARCH_TARGET_ID 一个合法值，存档被手改出第二个
  // 搜索标签也不放进来（会破坏「已存在则激活」的单例判据）。
  if (rec.kind === 'search' && targetId !== SEARCH_TARGET_ID) return null
  const lastActiveAt =
    typeof rec.lastActiveAt === 'number' && Number.isFinite(rec.lastActiveAt) ? rec.lastActiveAt : 0
  const scrollTop =
    typeof rec.scrollTop === 'number' && Number.isFinite(rec.scrollTop) ? rec.scrollTop : 0
  const draft =
    rec.draft !== null && typeof rec.draft === 'object' && !Array.isArray(rec.draft)
      ? (rec.draft as DraftSnapshot)
      : undefined
  return {
    // id 按 kind + targetId 重算而不是照抄存的那份 —— 存的 id 被手改过也不会让去重失效。
    id: tabId(rec.kind, targetId),
    kind: rec.kind,
    targetId,
    title: typeof rec.title === 'string' ? rec.title : '',
    lastActiveAt,
    // 搜索标签永不 locked（词表注释）—— 存档里被写进 true 也在这里放平。
    locked: rec.locked === true && rec.kind !== 'search',
    drawerOpen: rec.drawerOpen === true,
    scrollTop,
    ...(draft === undefined ? {} : { draft })
  }
}

function defaults(): PersistedSlice {
  return { tabs: [], active: MAIN_SLOT, mainPage: DEFAULT_MAIN_PAGE, maxTabs: MAX_TABS_DEFAULT }
}

function hydrate(): PersistedSlice {
  if (typeof window === 'undefined') return defaults()
  let parsed: unknown
  try {
    const raw = window.localStorage.getItem(KEY)
    if (raw === null || raw === '') return defaults()
    parsed = JSON.parse(raw)
  } catch {
    // 坏 JSON / privacy mode —— 回默认，不要让一份烂存档卡住整个工作区。
    return defaults()
  }
  if (parsed === null || typeof parsed !== 'object') return defaults()
  const blob = parsed as Record<string, unknown>
  if (blob.v !== SCHEMA_VERSION) return defaults()

  const seen = new Set<TabId>()
  const parsedTabs: TabDescriptor[] = []
  if (Array.isArray(blob.tabs)) {
    for (const item of blob.tabs) {
      const tab = parseTab(item)
      if (tab === null || seen.has(tab.id)) continue
      seen.add(tab.id)
      parsedTabs.push(tab)
    }
  }
  // 硬上限兜底：正常路径下 openTab 不会让长度超过 maxTabs(≤12)，这一刀防的是被手改
  // 或被别的版本写进来的存档（几十个标签会让标签条彻底不可用）。留最近用过的那些，
  // 顺序仍按存档里的排列（标签条的位置不该因为一次兜底就被重排）。
  let tabs = parsedTabs
  if (parsedTabs.length > MAX_TABS_MAX) {
    const keep = new Set(
      [...parsedTabs]
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        .slice(0, MAX_TABS_MAX)
        .map((t) => t.id)
    )
    tabs = parsedTabs.filter((t) => keep.has(t.id))
  }

  for (const tab of tabs) if (tab.lastActiveAt > lastStamp) lastStamp = tab.lastActiveAt

  return {
    tabs,
    active:
      typeof blob.active === 'string' &&
      (blob.active === MAIN_SLOT || tabs.some((t) => t.id === blob.active))
        ? blob.active
        : MAIN_SLOT,
    mainPage: isMainPage(blob.mainPage) ? blob.mainPage : DEFAULT_MAIN_PAGE,
    maxTabs: clampMaxTabs(blob.maxTabs) ?? MAX_TABS_DEFAULT
  }
}

function write(slice: PersistedSlice): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        v: SCHEMA_VERSION,
        tabs: slice.tabs,
        active: slice.active,
        mainPage: slice.mainPage,
        maxTabs: slice.maxTabs
      })
    )
  } catch {
    /* quota / private mode —— 状态留在内存里 */
  }
}

// ── 纯逻辑（可单独测，也让 store 方法读起来是一句话）──────────────────────────

/** 淘汰候选：**非激活且非锁定**里 `lastActiveAt` 最小的那个。没有候选返回 null。 */
function pickEvictable(tabs: readonly TabDescriptor[], active: ActiveSlot): TabDescriptor | null {
  let victim: TabDescriptor | null = null
  for (const tab of tabs) {
    if (tab.id === active || tab.locked) continue
    if (victim === null || tab.lastActiveAt < victim.lastActiveAt) victim = tab
  }
  return victim
}

/** 入栈：同一个对象只留一条（关掉两次不该让 ⌘⇧T 在原地按两下），压顶后截到 cap。 */
function pushClosed(stack: readonly ClosedTab[], tab: TabDescriptor): readonly ClosedTab[] {
  const rest = stack.filter((e) => !(e.kind === tab.kind && e.targetId === tab.targetId))
  const next = [...rest, { kind: tab.kind, targetId: tab.targetId, title: tab.title }]
  return next.length > CLOSED_STACK_CAP ? next.slice(next.length - CLOSED_STACK_CAP) : next
}

function mostRecent(tabs: readonly TabDescriptor[]): TabDescriptor | null {
  let best: TabDescriptor | null = null
  for (const tab of tabs) {
    if (best === null || tab.lastActiveAt > best.lastActiveAt) best = tab
  }
  return best
}

// ── store ───────────────────────────────────────────────────────────────────

export const useTabWorkspace = create<TabWorkspaceState>((set, get) => {
  const commit = (patch: Partial<TabWorkspaceState>): void => {
    set(patch)
    write(get())
  }

  return {
    ...hydrate(),
    mainBreadcrumb: null,
    closedStack: [],

    openTab(kind, targetId, title) {
      const state = get()
      const id = tabId(kind, targetId)
      const stamp = nextStamp()

      if (state.tabs.some((t) => t.id === id)) {
        commit({
          tabs: state.tabs.map((t) =>
            t.id === id
              ? {
                  ...t,
                  lastActiveAt: stamp,
                  title: title !== undefined && title !== '' ? title : t.title
                }
              : t
          ),
          active: id
        })
        return { outcome: 'activated', id }
      }

      // 先在副本上算，成功了才 commit —— 「淘汰几个之后发现还是开不了」时不能把
      // 已经算出来的淘汰落地（那会变成「什么也没开，还关了几个」）。
      let next = state.tabs
      const victims: TabDescriptor[] = []
      while (next.length >= state.maxTabs) {
        const victim = pickEvictable(next, state.active)
        if (victim === null) break
        victims.push(victim)
        next = next.filter((t) => t.id !== victim.id)
      }
      if (next.length >= state.maxTabs) return { outcome: 'rejected', reason: 'all-locked' }

      const tab: TabDescriptor = {
        id,
        kind,
        targetId,
        title: title ?? '',
        lastActiveAt: stamp,
        locked: false,
        drawerOpen: false,
        scrollTop: 0
      }
      // 被挤掉的也进最近关闭栈 —— 用户没主动关它，⌘⇧T 得能捞回来。
      let closedStack = state.closedStack
      for (const victim of victims) closedStack = pushClosed(closedStack, victim)
      commit({ tabs: [...next, tab], active: id, closedStack })
      return {
        outcome: 'opened',
        id,
        evicted: victims.map((v) => ({ id: v.id, title: v.title }))
      }
    },

    replaceActiveTab(kind, targetId, title) {
      const state = get()
      const current = selectActiveTab(state)
      const id = tabId(kind, targetId)
      // 主标签激活 / 当前标签锁定 / 目标已经开在别处 —— 三种都退回 openTab：
      // 它已经把「去重只激活」「满了先淘汰」「全锁定就拒绝」都算全了。
      if (current === null || current.locked || state.tabs.some((t) => t.id === id)) {
        return get().openTab(kind, targetId, title)
      }
      const stamp = nextStamp()
      const replaced: TabDescriptor = {
        id,
        kind,
        targetId,
        title: title ?? '',
        lastActiveAt: stamp,
        locked: false,
        drawerOpen: false,
        scrollTop: 0
      }
      commit({
        tabs: state.tabs.map((t) => (t.id === current.id ? replaced : t)),
        active: id
      })
      return { outcome: 'replaced', id, previousId: current.id }
    },

    reopenLastClosed() {
      const stack = get().closedStack
      const entry = stack[stack.length - 1]
      if (entry === undefined) return null
      const result = get().openTab(entry.kind, entry.targetId, entry.title)
      if (result.outcome === 'rejected') return result
      // 按引用摘除而不是再弹一次栈顶 —— openTab 可能顺带淘汰了别的标签并压了新顶。
      commit({ closedStack: get().closedStack.filter((e) => e !== entry) })
      return result
    },

    retargetTab(kind, oldTargetId, newTargetId) {
      // 搜索标签是单例（targetId 恒 SEARCH_TARGET_ID），换锚会破坏单例判据。
      if (kind === 'search' || oldTargetId === newTargetId) return
      const state = get()
      const oldId = tabId(kind, oldTargetId)
      const source = state.tabs.find((t) => t.id === oldId)
      if (source === undefined) return
      const newId = tabId(kind, newTargetId)
      const moved: TabDescriptor = { ...source, id: newId, targetId: newTargetId }
      // 先移除已存在的重复者（合并），再原位替换 —— 标签条位置跟着源标签走。
      const tabs = state.tabs.filter((t) => t.id !== newId).map((t) => (t.id === oldId ? moved : t))
      const active = state.active === oldId || state.active === newId ? newId : state.active
      commit({ tabs, active })
    },

    closeTab(id) {
      const state = get()
      const closing = state.tabs.find((t) => t.id === id)
      if (closing === undefined) return
      const tabs = state.tabs.filter((t) => t.id !== id)
      const closedStack = pushClosed(state.closedStack, closing)
      if (state.active !== id) {
        commit({ tabs, closedStack })
        return
      }
      // 关掉激活的那个 → 接管的是「最近用过」的邻居；一个都不剩就回主标签。
      // 接管者当场成为被看的那个，顺手刷新它的 lastActiveAt。
      const heir = mostRecent(tabs)
      if (heir === null) {
        commit({ tabs, active: MAIN_SLOT, closedStack })
        return
      }
      const stamp = nextStamp()
      commit({
        tabs: tabs.map((t) => (t.id === heir.id ? { ...t, lastActiveAt: stamp } : t)),
        active: heir.id,
        closedStack
      })
    },

    activateTab(id) {
      const state = get()
      if (state.active === id || !state.tabs.some((t) => t.id === id)) return
      const stamp = nextStamp()
      commit({
        tabs: state.tabs.map((t) => (t.id === id ? { ...t, lastActiveAt: stamp } : t)),
        active: id
      })
    },

    activateMain() {
      if (get().active === MAIN_SLOT) return
      commit({ active: MAIN_SLOT })
    },

    setMainPage(page) {
      const state = get()
      commit({
        mainPage: page,
        active: MAIN_SLOT,
        // 同一个承载被再次点中不算「切」，别把它刚 set 的第二段擦掉。
        mainBreadcrumb: page === state.mainPage ? state.mainBreadcrumb : null
      })
    },

    setMainBreadcrumb(text) {
      if (get().mainBreadcrumb === text) return
      commit({ mainBreadcrumb: text })
    },

    updateTab(id, patch) {
      const state = get()
      const target = state.tabs.find((t) => t.id === id)
      if (target === undefined) return
      // 搜索标签永不 locked（词表注释）——锁定写入丢弃，其余字段照常。
      const applied =
        target.kind === 'search' && patch.locked === true ? { ...patch, locked: false } : patch
      commit({ tabs: state.tabs.map((t) => (t.id === id ? { ...t, ...applied } : t)) })
    },

    setMaxTabs(next) {
      const clamped = clampMaxTabs(next)
      if (clamped === null || clamped === get().maxTabs) return
      commit({ maxTabs: clamped })
    }
  }
})

// ── 选择器（消费方直接用，别各自再手写一遍）────────────────────────────────

type Slice = Pick<TabWorkspaceState, 'tabs' | 'active'>

export function selectActiveTab(state: Slice): TabDescriptor | null {
  if (state.active === MAIN_SLOT) return null
  return state.tabs.find((t) => t.id === state.active) ?? null
}

/** 「激活标签的 targetId」投影 —— active-email / MattersWorkspace 的单例降级后读它：
 *  激活的是主标签或另一类对象时返回 null。 */
export function selectActiveTargetId(state: Slice, kind: TabKind): number | null {
  const tab = selectActiveTab(state)
  return tab !== null && tab.kind === kind ? tab.targetId : null
}
