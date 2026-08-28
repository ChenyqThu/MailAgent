// 顶栏标签条（task 08-27-l4-tab-workspace P2 Lane U — 原型 Main.dc.html .rtop 1:1）。
//
// 结构：主标签（单例槽，168 定宽，icon 与面包屑随承载切换）｜分隔｜对象标签区
// （宽度实测 → clamp 84-190，「+」钮 Chrome 式跟在最后一个标签右侧）。dogfood 轮4
// 起顶栏右簇迁去左段（TitleBar），标签条独占行末 —— 断开的 hairline 一直延伸到行尾。
//
// 状态全部来自 useTabWorkspace；本组件只消费 activate / close —— openTab 与它的
// 静默 LRU 驱逐在列表点击侧（Lane W），内容区的切换淡入也在那边。
//
// 几何：🔴 对象标签宽度用 ResizeObserver 量 .tstrip-tabs 的**实际**宽度算（原型
// 的 1440 固定窗宽公式只是参考，实现必须响应实际宽度）。滑动面与 hairline 断口
// 的 left/width 由这里算好写内联 style，缓动统一在 authored CSS（.tstrip-surface
// 与 .tstrip-hair 同一条曲线，断口才能跟着面走）。
//
// 开合动效（dogfood 轮4）：AnimatePresence-lite —— 渲染列表 = store 标签 + 「幽灵」
// （刚被关掉、还在收缩淡出的标签，到点卸载）。所有宽度变化（收缩 / 长出 / 余下标签的
// reflow）与滑动面共用同一条 --tstrip-dur/--tstrip-ease：同曲线同时长的宽度过渡做线性
// 组合仍在同曲线上，morph 面的 left 过渡才能与标签实际位置逐帧咬合。测量继续走
// offset*（纯布局量，不被 transform 污染 —— motion 测量陷阱），不引 FLIP。
//
// 材质契约（激活标签内部 = 内容面，无亮线）见 index.css 的 --tab-strip-surface
// 推导注释；🔴 hairline 是「断开的两段」而不是整条 + z-index 盖，理由同见那里。

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { PlusIcon, SearchIcon, XIcon } from '@shared/components/icons'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { NAV_DOMAINS, navDomainLabel } from '@shared/navigation/registry'
import { openSearchTab } from '@shared/state/tab-commands'
import { requestCloseTab } from '@shared/state/tab-workspace-bridge'
import {
  MAIN_SLOT,
  TAB_KIND_DOMAIN,
  useTabWorkspace,
  type TabDescriptor,
  type TabId
} from '@shared/state/tab-workspace'

// 原型几何常量（Main.dc.html ~L1782）。PAD_L / MAIN_W / 间隔与 authored CSS 的
// padding / width 是同一份数（.tstrip padding-left 10、.ttab-main width 168、
// .tstrip gap 3、.tstrip-sep 1+5×2、.tstrip-tabs gap 2）——改任一侧必须同步另一侧。
const PAD_L = 10
const MAIN_W = 168
const TAB_GAP = 2
const TAB_MIN = 84
const TAB_MAX = 190
/** 「+」钮宽（.tstrip-plus width 28）—— 钮在 .tstrip-tabs **内**（Chrome 式跟随最后
 *  一个标签），tabW 要手动扣掉它 + 一个 gap；改任一侧必须同步另一侧。 */
const PLUS_W = 28
/** 外凹圆角宽度 —— hairline 断口在滑动面两侧各让出的量（.tstrip-surface::before/after）。 */
const CORNER = 12
/** tabs 区左缘兜底值 = PAD_L + MAIN_W + gap 3 + 分隔 11 + gap 3；首帧实测前用。 */
const TABS_LEFT_FALLBACK = 195
/** 动效收尾时点（幽灵卸载 / 入场标记摘除）= --tstrip-dur(440) + 一帧余量。
 *  改 CSS 时长必须同步这里。 */
const TAB_ANIM_MS = 480

const NO_DRAG = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

interface WrapBox {
  readonly left: number
  readonly width: number
}

// ── 渲染列表 diff（AnimatePresence-lite）────────────────────────────────────

interface StripItem {
  readonly tab: TabDescriptor
  /** 幽灵：store 里已没有它，正在收缩淡出，到点卸载。 */
  readonly closing: boolean
  /** 刚开出来的（boot 存量不算）→ 播一次从 0 宽长出的入场；到点摘标记。 */
  readonly entering: boolean
}

function sameItems(a: readonly StripItem[], b: readonly StripItem[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].tab !== b[i].tab || a[i].closing !== b[i].closing || a[i].entering !== b[i].entering) {
      return false
    }
  }
  return true
}

/** store 标签集 → 渲染列表。三条规则：
 *  1. 消失的标签变幽灵留在原位收缩（reduceMotion 下直接丢弃）；
 *  2. 新出现的标签按 store 序追加并标记入场（store 只会 append，不会重排）；
 *  3. 🔴 「一删一增且落在同一格」= 原位换身（replaceActiveTab 的 J/K 翻页、
 *     retargetTab 的草稿换锚）——是同一个标签换了目标，不是关一个开一个，
 *     进/退场都不播（否则连按 J 翻十封邮件会闪十次动画）。
 *  兜底：diff 后存活项的顺序必须与 store 完全一致，对不上（理论不可达的组合序列）
 *  就放弃本轮动画、直接镜像 store —— 幽灵只是观感，顺序错了滑动面会指错格。 */
function diffStripItems(
  prev: readonly StripItem[],
  tabs: readonly TabDescriptor[],
  reduceMotion: boolean
): readonly StripItem[] {
  const byId = new Map(tabs.map((t) => [t.id, t]))
  const prevIds = new Set(prev.map((i) => i.tab.id))
  const live = prev.filter((i) => !i.closing)
  const removed = live.filter((i) => !byId.has(i.tab.id))
  const added = tabs.filter((t) => !prevIds.has(t.id))
  const swap =
    removed.length === 1 &&
    added.length === 1 &&
    live.findIndex((i) => i.tab.id === removed[0].tab.id) ===
      tabs.findIndex((t) => t.id === added[0].id)

  const next: StripItem[] = []
  const placed = new Set<TabId>()
  for (const item of prev) {
    const liveTab = byId.get(item.tab.id)
    if (liveTab !== undefined) {
      // 幽灵期间被重新打开（⌘⇧T 秒回）：store 把它追加在末尾 —— 丢幽灵，走下面的
      // 追加分支落到 store 的位置上（原位复活会让渲染序偏离 store 序）。
      if (item.closing) continue
      next.push(
        item.tab === liveTab ? item : { tab: liveTab, closing: false, entering: item.entering }
      )
      placed.add(liveTab.id)
      continue
    }
    if (item.closing) {
      next.push(item)
      continue
    }
    if (swap && item.tab.id === removed[0].tab.id) {
      next.push({ tab: added[0], closing: false, entering: false })
      placed.add(added[0].id)
      continue
    }
    if (reduceMotion) continue
    next.push({ tab: item.tab, closing: true, entering: false })
  }
  for (const t of tabs) {
    if (placed.has(t.id)) continue
    next.push({ tab: t, closing: false, entering: !reduceMotion })
  }

  const liveIds = next.filter((i) => !i.closing).map((i) => i.tab.id)
  if (liveIds.length !== tabs.length || liveIds.some((id, i) => id !== tabs[i].id)) {
    return tabs.map((t) => ({ tab: t, closing: false, entering: false }))
  }
  return sameItems(prev, next) ? prev : next
}

export function TabStrip(): React.ReactElement {
  const { t } = useTranslation()
  const tabs = useTabWorkspace((s) => s.tabs)
  const active = useTabWorkspace((s) => s.active)
  const mainPage = useTabWorkspace((s) => s.mainPage)
  const mainBreadcrumb = useTabWorkspace((s) => s.mainBreadcrumb)
  const activateTab = useTabWorkspace((s) => s.activateTab)
  const activateMain = useTabWorkspace((s) => s.activateMain)
  const reduceMotion = useReducedMotion()

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [wrap, setWrap] = useState<WrapBox>({ left: TABS_LEFT_FALLBACK, width: 0 })

  // 渲染列表（store 标签 + 幽灵）。boot 存量直接入列不播入场。
  const [items, setItems] = useState<readonly StripItem[]>(() =>
    useTabWorkspace.getState().tabs.map((tab) => ({ tab, closing: false, entering: false }))
  )
  const itemsRef = useRef(items)
  // 动效收尾定时：exit = 幽灵到点卸载；enter = 入场标记到点摘除（class 挂着不摘，
  // 下次同 id 复用元素时会看不出「这次没播」，测试也数不准）。同 id 同时刻只有一种。
  const animTimers = useRef(new Map<TabId, { kind: 'exit' | 'enter'; timer: number }>())

  useLayoutEffect(() => {
    const next = diffStripItems(itemsRef.current, tabs, reduceMotion)
    if (next !== itemsRef.current) {
      itemsRef.current = next
      setItems(next)
    }
    const timers = animTimers.current
    const want = new Map<TabId, 'exit' | 'enter'>()
    for (const item of next) {
      if (item.closing) want.set(item.tab.id, 'exit')
      else if (item.entering) want.set(item.tab.id, 'enter')
    }
    // 态翻转（幽灵被复活 / 入场标签被关成幽灵）→ 旧定时作废重排。
    for (const [id, entry] of timers) {
      if (want.get(id) === entry.kind) continue
      window.clearTimeout(entry.timer)
      timers.delete(id)
    }
    for (const [id, kind] of want) {
      if (timers.has(id)) continue
      timers.set(id, {
        kind,
        timer: window.setTimeout(() => {
          timers.delete(id)
          itemsRef.current =
            kind === 'exit'
              ? itemsRef.current.filter((i) => !(i.closing && i.tab.id === id))
              : itemsRef.current.map((i) =>
                  i.tab.id === id && i.entering ? { ...i, entering: false } : i
                )
          setItems(itemsRef.current)
        }, TAB_ANIM_MS)
      })
    }
  }, [tabs, reduceMotion])

  useEffect(() => {
    const timers = animTimers.current
    return () => {
      for (const entry of timers.values()) window.clearTimeout(entry.timer)
    }
  }, [])

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (el === null) return
    const measure = (): void => {
      // offsetLeft 相对 offsetParent（.tstrip 是 position:relative）＝滑动面坐标系。
      // 用 offset* 而不是 getBoundingClientRect —— 纯布局量，不被 transform 污染
      //（motion 测量陷阱同款教训）。
      const next = { left: el.offsetLeft, width: el.offsetWidth }
      setWrap((prev) => (prev.left === next.left && prev.width === next.width ? prev : next))
    }
    measure()
    // 观察 tabs 区自身：窗口缩放会让 flex-1 的它变宽变窄，这一个观察点全覆盖。
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 「+」钮在 tabs 区内占掉 PLUS_W + 一个 gap，可用宽度手动扣掉（n=0 时钮独占，不扣）。
  const n = tabs.length
  const tabW =
    n === 0
      ? TAB_MAX
      : Math.max(TAB_MIN, Math.min(TAB_MAX, Math.floor((wrap.width - PLUS_W - TAB_GAP * n) / n)))

  // 滑动面：主标签激活时压在主标签上（left=PAD_L, width=MAIN_W），对象标签激活时
  // 滑到对应格。left/width 变更由 CSS 过渡接管 ⇒ 切换是滑动不是硬切。坐标按 store
  // 序算（幽灵不占格）：幽灵收缩与本面同曲线同时长，过渡全程逐帧咬合（文件头注释）。
  const activeIndex = active === MAIN_SLOT ? -1 : tabs.findIndex((tb) => tb.id === active)
  const surfLeft = activeIndex >= 0 ? wrap.left + activeIndex * (tabW + TAB_GAP) : PAD_L
  const surfW = activeIndex >= 0 ? tabW : MAIN_W

  const crumb1 = navDomainLabel(mainPage, t)
  const mainTitle = mainBreadcrumb === null ? crumb1 : `${crumb1} / ${mainBreadcrumb}`

  return (
    <div className="tstrip glass-bar" role="tablist" aria-label={t('tabs.strip')}>
      {/* hairline 两段 + 滑动面 —— 断口 = [surfLeft-12, surfLeft+surfW+12]（含外凹圆角）。 */}
      <div
        className="tstrip-hair"
        style={{ left: 0, width: Math.max(0, surfLeft - CORNER) }}
        aria-hidden
      />
      <div
        className="tstrip-hair"
        style={{ left: surfLeft + surfW + CORNER, right: 0 }}
        aria-hidden
      />
      <div className="tstrip-surface" style={{ left: surfLeft, width: surfW }} aria-hidden />

      <div
        role="tab"
        aria-selected={active === MAIN_SLOT}
        tabIndex={0}
        className="ttab-main"
        style={NO_DRAG}
        title={mainTitle}
        onClick={activateMain}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            activateMain()
          }
        }}
      >
        {NAV_DOMAINS[mainPage].icon()}
        <span className="tcrumb">
          <span>{crumb1}</span>
          {mainBreadcrumb !== null && (
            <>
              {/* 单段时不显分隔符（prd「主标签」）。 */}
              <span className="tcrumb-sep" aria-hidden>
                /
              </span>
              <span className="tcrumb-2">{mainBreadcrumb}</span>
            </>
          )}
        </span>
      </div>

      <div className="tstrip-sep" aria-hidden />

      <div ref={wrapRef} className="tstrip-tabs">
        {items.map(({ tab, closing, entering }) => (
          <ObjectTab
            key={tab.id}
            tab={tab}
            width={closing ? 0 : tabW}
            closing={closing}
            entering={entering}
            selected={!closing && tab.id === active}
            onActivate={() => activateTab(tab.id)}
            // dogfood 波3：× 与 ⌘W 同走关闭守卫 —— dirty 草稿标签先激活再弹确认
            // （守卫路径不动 store ⇒ 不触发关闭动效，「取消」后标签原样在场）。
            onClose={() => requestCloseTab(tab.id)}
          />
        ))}
        {/* 「+」新标签页（⌘T 的鼠标入口，原型 .plus）。dogfood 轮4：Chrome 式跟在最后
            一个标签右侧（含收缩中的幽灵 —— 关标签时它随收缩一起左移）；宽度经 PLUS_W
            手动进几何（tabW 公式）。 */}
        <button
          type="button"
          className="tstrip-plus"
          style={NO_DRAG}
          title={t('tabs.newTab')}
          aria-label={t('tabs.newTab')}
          onClick={openSearchTab}
        >
          <PlusIcon size={14} strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}

interface ObjectTabProps {
  readonly tab: TabDescriptor
  readonly width: number
  readonly selected: boolean
  readonly closing: boolean
  readonly entering: boolean
  readonly onActivate: () => void
  readonly onClose: () => void
}

function ObjectTab({
  tab,
  width,
  selected,
  closing,
  entering,
  onActivate,
  onClose
}: ObjectTabProps): React.ReactElement {
  const { t } = useTranslation()
  // 搜索标签标题恒定（不读快照 ⇒ 切语言即时跟）；对象标签 deeplink 这类入口先开着
  // 空标题，详情加载完由消费方 updateTab 补（store 契约）。
  const title =
    tab.kind === 'search'
      ? t('tabs.searchTitle')
      : tab.title === ''
        ? t('tabs.untitled')
        : tab.title
  // 改动点（accent）与锁定点（琥珀）互斥，dirty 优先 —— dirty 必带 draft ⇒ 必 locked，
  // 两个点一起画只是噪音（dogfood 波3）。dirty 位直读快照原始字段，与关闭守卫同判据。
  const dirty =
    tab.kind === 'email' && (tab.draft as { dirty?: unknown } | undefined)?.dirty === true
  return (
    <div
      // 幽灵退出可交互序列（不是 tab、不进 a11y 树、不可聚焦）；pointer-events 由
      // .ttab-closing 关掉，onClick 兜底也打不中（activateTab 对不存在的 id no-op）。
      {...(closing
        ? { 'aria-hidden': true as const }
        : { role: 'tab', 'aria-selected': selected, tabIndex: 0 })}
      className={`ttab${closing ? ' ttab-closing' : ''}${entering ? ' ttab-enter' : ''}`}
      style={{ width, ...NO_DRAG }}
      title={title}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onActivate()
        }
      }}
    >
      {/* kind icon = 所属域的脸（registry 单源，不为标签另造 glyph）；搜索标签没有域，
          用放大镜（与页面 slogo / ⌘K 钮同一枚）。 */}
      {tab.kind === 'search' ? <SearchIcon /> : NAV_DOMAINS[TAB_KIND_DOMAIN[tab.kind]].icon()}
      <span className="ttab-title">{title}</span>
      {dirty ? (
        <span className="ttab-dirty" title={t('tabs.dirty')} />
      ) : tab.locked ? (
        <span className="ttab-lock" title={t('tabs.locked')} />
      ) : null}
      <button
        type="button"
        className="ttab-close"
        aria-label={t('tabs.close')}
        title={t('tabs.close')}
        style={NO_DRAG}
        tabIndex={closing ? -1 : 0}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
      >
        <XIcon size={10} strokeWidth={2.4} />
      </button>
    </div>
  )
}
