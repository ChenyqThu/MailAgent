// 顶栏标签条（task 08-27-l4-tab-workspace P2 Lane U — 原型 Main.dc.html .rtop 1:1）。
//
// 结构：主标签（单例槽，168 定宽，icon 与面包屑随承载切换）｜分隔｜对象标签区
// （宽度实测 → clamp 84-190）｜行尾右簇（TitleBar 传入完整节点；落位在标签条内
// 是为了让断开的 hairline 一直延伸到行末）。
//
// 状态全部来自 useTabWorkspace；本组件只消费 activate / close —— openTab 与它的
// 淘汰 toast 在列表点击侧（Lane W），内容区的切换淡入也在那边。
//
// 几何：🔴 对象标签宽度用 ResizeObserver 量 .tstrip-tabs 的**实际**宽度算（原型
// 的 1440 固定窗宽公式只是参考，实现必须响应实际宽度）。滑动面与 hairline 断口
// 的 left/width 由这里算好写内联 style，缓动统一在 authored CSS（.tstrip-surface
// 与 .tstrip-hair 同一条曲线，断口才能跟着面走）。
//
// 材质契约（激活标签内部 = 内容面，无亮线）见 index.css 的 --tab-strip-surface
// 推导注释；🔴 hairline 是「断开的两段」而不是整条 + z-index 盖，理由同见那里。

import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { XIcon } from '@shared/components/icons'
import { NAV_DOMAINS, navDomainLabel } from '@shared/navigation/registry'
import {
  MAIN_SLOT,
  TAB_KIND_DOMAIN,
  useTabWorkspace,
  type TabDescriptor
} from '@shared/state/tab-workspace'

// 原型几何常量（Main.dc.html ~L1782）。PAD_L / MAIN_W / 间隔与 authored CSS 的
// padding / width 是同一份数（.tstrip padding-left 10、.ttab-main width 168、
// .tstrip gap 3、.tstrip-sep 1+5×2、.tstrip-tabs gap 2）——改任一侧必须同步另一侧。
const PAD_L = 10
const MAIN_W = 168
const TAB_GAP = 2
const TAB_MIN = 84
const TAB_MAX = 190
/** 外凹圆角宽度 —— hairline 断口在滑动面两侧各让出的量（.tstrip-surface::before/after）。 */
const CORNER = 12
/** tabs 区左缘兜底值 = PAD_L + MAIN_W + gap 3 + 分隔 11 + gap 3；首帧实测前用。 */
const TABS_LEFT_FALLBACK = 195

const NO_DRAG = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

interface WrapBox {
  readonly left: number
  readonly width: number
}

export interface TabStripProps {
  /** 行尾右簇（chrome 件）。由 TitleBar 传入完整节点，这里只负责落位。 */
  trailing?: React.ReactNode
}

export function TabStrip({ trailing }: TabStripProps): React.ReactElement {
  const { t } = useTranslation()
  const tabs = useTabWorkspace((s) => s.tabs)
  const active = useTabWorkspace((s) => s.active)
  const mainPage = useTabWorkspace((s) => s.mainPage)
  const mainBreadcrumb = useTabWorkspace((s) => s.mainBreadcrumb)
  const activateTab = useTabWorkspace((s) => s.activateTab)
  const activateMain = useTabWorkspace((s) => s.activateMain)
  const closeTab = useTabWorkspace((s) => s.closeTab)

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [wrap, setWrap] = useState<WrapBox>({ left: TABS_LEFT_FALLBACK, width: 0 })

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
    // 观察 tabs 区自身：窗口缩放、右簇件出现/消失（UpdateIndicator）都会让 flex-1
    // 的它变宽变窄，这一个观察点全覆盖，不需要手抄右簇宽度常量。
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const n = tabs.length
  const tabW =
    n === 0
      ? TAB_MAX
      : Math.max(TAB_MIN, Math.min(TAB_MAX, Math.floor((wrap.width - TAB_GAP * (n - 1)) / n)))

  // 滑动面：主标签激活时压在主标签上（left=PAD_L, width=MAIN_W），对象标签激活时
  // 滑到对应格。left/width 变更由 CSS 过渡接管 ⇒ 切换是滑动不是硬切。
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
        {tabs.map((tab) => (
          <ObjectTab
            key={tab.id}
            tab={tab}
            width={tabW}
            selected={tab.id === active}
            onActivate={() => activateTab(tab.id)}
            onClose={() => closeTab(tab.id)}
          />
        ))}
      </div>

      {trailing}
    </div>
  )
}

interface ObjectTabProps {
  readonly tab: TabDescriptor
  readonly width: number
  readonly selected: boolean
  readonly onActivate: () => void
  readonly onClose: () => void
}

function ObjectTab({
  tab,
  width,
  selected,
  onActivate,
  onClose
}: ObjectTabProps): React.ReactElement {
  const { t } = useTranslation()
  // deeplink 这类入口先开着空标题，详情加载完由消费方 updateTab 补（store 契约）。
  const title = tab.title === '' ? t('tabs.untitled') : tab.title
  return (
    <div
      role="tab"
      aria-selected={selected}
      tabIndex={0}
      className="ttab"
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
      {/* kind icon = 所属域的脸（registry 单源，不为标签另造 glyph）。 */}
      {NAV_DOMAINS[TAB_KIND_DOMAIN[tab.kind]].icon()}
      <span className="ttab-title">{title}</span>
      {tab.locked && <span className="ttab-lock" title={t('tabs.locked')} />}
      <button
        type="button"
        className="ttab-close"
        aria-label={t('tabs.close')}
        title={t('tabs.close')}
        style={NO_DRAG}
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
