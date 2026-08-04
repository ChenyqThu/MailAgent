// SectionAnchorNav — 通用「页内区块锚点导航」(scrollspy)。
//
// 为什么存在: settings-AI 等长页面需要右侧锚点导航跳转 + 高亮当前区块。仓库
// 此前零现成实现 (唯一同页跳转先例是 custom-ai/SystemCapabilitiesSection 的
// 裸 scrollIntoView), 这里收成一个可复用组件。
//
// 🔴 三条与宿主页面的约定 —— 集成方必须满足, 否则组件行为无从谈起:
//
//   1. **滚动容器不是 viewport**。由 `scrollContainerRef` 传入 (Settings 的
//      唯一滚动容器是 SettingsShell 的 `<section aria-label="settings content">`,
//      不是 window)。active 追踪与触底判定全部挂这个容器, 组件不读 window.scroll*。
//
//   2. **落点偏移由目标元素自己负责**。容器内可能有 sticky 竞争者 (Settings 的
//      RestartBanner `sticky top-0 z-10`) 遮住 scrollIntoView 的落点。本组件
//      **有意不做**偏移补偿 —— 集成方给每个 id 目标加 `scroll-margin-top`
//      (Tailwind `scroll-mt-*`), 这样偏移量跟着各页面自己的 sticky 高度走,
//      不用把宿主布局常量抄进组件。
//
//   3. **`items` 只是静态候选清单**。部分区块受 flag 门控整体 `return null`
//      (外裹 wrapper 仍挂在 DOM 里但高度为 0)。组件运行时过滤「目标元素不存在
//      或 offsetHeight === 0」的条目, 并在区块显隐变化时重扫
//      (ResizeObserver + MutationObserver, 卸载时全部 disconnect)。
//
// 定位 (右浮 / sticky / 宽度 / 与正文的间距) **不归本组件管** —— 它只输出纵向
// 导航列表本身, 由消费方包一层容器决定。
//
// 视觉 = DESIGN.md §18 (主题 v3「原生材质」): 条目圆角 `--r-ctl` 8px 档;
// active 走「选中签名」`--sel-wash` 药丸 + 3px 左条 —— 复用 Sidebar / 设置 rail
// 同源的 authored 类 `row-selected`(左条 ::before) + `acc-select`(wash), 左条在
// `.app-nav` 外不做 -8px 悬挂 (同 SurfacePicker/ThemePicker popover 先例);
// 过渡 `--ease-out-strong` @ duration-fast(120ms), 无 `transition: all` / 无回弹。

import * as React from 'react'

import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { cn } from '@shared/lib/cn'

export interface SectionAnchorItem {
  id: string
  label: string
}

/** 判定线: 容器顶边往下 24px。盖住这条线的最后一个区块 = active。 */
const ACTIVATION_OFFSET_PX = 24
/** 触底 / 可滚动判定的容差 (px)。 */
const BOTTOM_EPSILON_PX = 2

/** 运行时候选过滤: 元素在 DOM 里 **且** 真的占高度 (flag 关掉的区块 return null → 0 高)。 */
function isRenderedAnchor(id: string): boolean {
  const el = document.getElementById(id)
  return el != null && el.offsetHeight > 0
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export function SectionAnchorNav({
  items,
  scrollContainerRef,
  ariaLabel,
  className
}: {
  /** 静态候选清单, 按页面出现顺序。运行时不存在 / 0 高的条目会被过滤掉。 */
  items: SectionAnchorItem[]
  /** 滚动容器 (active 追踪的 root)。为 null 时组件仍渲染, 只是不追踪 active。 */
  scrollContainerRef: React.RefObject<HTMLElement | null>
  ariaLabel?: string
  className?: string
}): React.ReactElement | null {
  const reduceMotion = useReducedMotion()
  const [visibleIds, setVisibleIds] = React.useState<string[]>([])
  const [activeId, setActiveId] = React.useState<string | null>(null)

  // 候选 id 的最新快照 —— 长生命周期的 observer 回调从这里读, 避免把 `items`
  // (调用方多半是内联数组字面量, 每次 render 换 identity) 塞进 effect deps 里
  // 导致 observer 每帧重挂。
  const idsRef = React.useRef<string[]>([])

  const rescan = React.useCallback((ids: readonly string[]): void => {
    const next = ids.filter(isRenderedAnchor)
    // 结果一致时返回 prev, 让 React 直接 bail out —— 既省 render, 也让上面的
    // 「每次 render 后重扫」effect 不会自激。
    setVisibleIds((prev) => (sameOrder(prev, next) ? prev : next))
  }, [])

  const computeActive = React.useCallback((): void => {
    const container = scrollContainerRef.current
    if (container == null) return
    if (visibleIds.length === 0) {
      setActiveId(null)
      return
    }

    // 触底 → 恒最后一个条目。少了这一条, 末尾的短区块永远顶不到判定线 =
    // 「最后一个条目永远高亮不到」。
    const overflow = container.scrollHeight - container.clientHeight
    if (overflow > BOTTOM_EPSILON_PX && overflow - container.scrollTop <= BOTTOM_EPSILON_PX) {
      setActiveId(visibleIds[visibleIds.length - 1] ?? null)
      return
    }

    const line = container.getBoundingClientRect().top + ACTIVATION_OFFSET_PX
    let current = visibleIds[0] ?? null
    for (const id of visibleIds) {
      const el = document.getElementById(id)
      if (el != null && el.getBoundingClientRect().top <= line) current = id
    }
    setActiveId(current)
  }, [scrollContainerRef, visibleIds])

  // 每次 render 后重扫一次 —— 覆盖「`items` 候选清单本身变了」以及父层重渲染
  // 带来的区块显隐。无依赖数组是有意的: rescan 只在结果真的变化时 setState,
  // 收敛后不再触发新的 render。
  React.useEffect(() => {
    idsRef.current = items.map((it) => it.id)
    rescan(idsRef.current)
  })

  // 区块显隐重扫: RO 抓「0 高 ↔ 有高」(flag 门控的区块), MO 抓「元素整个被
  // 增删」。两者都经 rAF 合并成每帧至多一次重扫。
  React.useEffect(() => {
    const container = scrollContainerRef.current
    let frame = 0
    // RO 当前实际观察的元素集 —— 只做增删差量, 生命周期与本 effect 持有的 RO 同进退。
    // 🔴 ResizeObserver 在 observe() 时会**立刻回调一次**: 若每轮重扫都
    // disconnect + 全量 observe, 那次回调会再触发一轮重扫 → 无限 rAF 自激循环。
    const observed = new Set<Element>()

    function schedule(): void {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        syncResizeTargets()
        rescan(idsRef.current)
      })
    }

    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)

    function syncResizeTargets(): void {
      if (ro == null) return
      const next = new Set<Element>()
      if (container != null) next.add(container)
      for (const id of idsRef.current) {
        const el = document.getElementById(id)
        if (el != null) next.add(el)
      }
      for (const el of observed) {
        if (!next.has(el)) {
          ro.unobserve(el)
          observed.delete(el)
        }
      }
      for (const el of next) {
        if (!observed.has(el)) {
          ro.observe(el)
          observed.add(el)
        }
      }
    }

    let mo: MutationObserver | null = null
    if (container != null && typeof MutationObserver !== 'undefined') {
      mo = new MutationObserver(schedule)
      mo.observe(container, { childList: true, subtree: true })
    }

    syncResizeTargets()

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      mo?.disconnect()
      ro?.disconnect()
      observed.clear()
    }
  }, [scrollContainerRef, rescan])

  // active 追踪: 监听**传入容器**的 scroll (不是 window), rAF 节流后按几何位置
  // 判定 —— 一次 layout 读批完所有条目, 且触底分支天然覆盖末尾短区块。
  React.useEffect(() => {
    const container = scrollContainerRef.current
    if (container == null) return undefined
    let frame = 0
    const onScroll = (): void => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        computeActive()
      })
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    computeActive()
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      container.removeEventListener('scroll', onScroll)
    }
  }, [scrollContainerRef, computeActive])

  const handleJump = React.useCallback(
    (id: string): void => {
      // 乐观置 active: reduced-motion 下是瞬跳, 非 reduced 下平滑滚动期间的
      // scroll 事件会接管并收敛到真实位置。
      setActiveId(id)
      document
        .getElementById(id)
        ?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })
    },
    [reduceMotion]
  )

  const rendered = items.filter((it) => visibleIds.includes(it.id))
  if (rendered.length === 0) return null

  return (
    <nav aria-label={ariaLabel} className={className}>
      <ul role="list" className="flex flex-col gap-0.5">
        {rendered.map((it) => {
          const active = it.id === activeId
          return (
            <li key={it.id}>
              <button
                type="button"
                onClick={() => handleJump(it.id)}
                aria-current={active ? 'location' : undefined}
                className={cn(
                  // 圆角 --r-ctl (导航项/工具钮档); relative = .row-selected::before
                  // 左条的 containing block。
                  'relative flex w-full items-center rounded-[var(--r-ctl)] px-2.5 py-1.5 text-left',
                  'text-meta transition-colors duration-fast',
                  '[transition-timing-function:var(--ease-out-strong)]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70',
                  active
                    ? // 选中签名 = --sel-wash 药丸 (.acc-select) + 3px 左条
                      // (.row-selected::before), 与 sidebar / 设置 rail 同源。
                      'row-selected acc-select text-ink-fg font-medium'
                    : 'text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg'
                )}
              >
                <span className="min-w-0 truncate">{it.label}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
