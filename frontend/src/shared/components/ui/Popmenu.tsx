// Popmenu —— 全 app 弹层基座（trigger 锚定 + 无限下钻堆叠面板）。
//
// 来源：lab.moumen.dev 的 `unlimited-nested-menu`，源码取自它的 shadcn registry
// （`https://lab.moumen.dev/r/unlimited-nested-menu.json`，registry item 里带完整
// TSX）。**这是照搬移植，不是复刻**：面板栈的几何、morph 的时序、缓动常量、
// AnimatePresence 的进退治理全部保留原实现 —— 上一版（GSAP 自研版 `DrillMenu`）
// 凭印象重写，owner dogfood 判「交互质感一坨屎」，别再走那条路。
//
// 原实现的核心（也是手感的来源，改动前先读懂）：
//   • 主面板**永不移动**。点一个分支，它的子面板作为**新的一层**绝对定位在「被点
//     那一行的位置」，盖在它下面的内容之上 —— 父面板整块留在原地、只被压暗。多层
//     下钻就是一道向下的楼梯，点任意一层父面板即回到那一层。
//     （自研版做的是「壳体高度 tween + 面板整体换人」，那是完全不同的心智模型。）
//   • 下钻 = shared-element morph：子面板挂载时被 clip 成只剩它的 header，而这个
//     header 的几何**与被点的那一行逐像素对齐**（见下方「几何契约」），然后 clip
//     向下展开、标题从行标签的座位滑到位、字重 plain→bold 交叉淡入。读起来就是
//     「这一行长成了新面板的标题」。因为目标值依赖被点行的实测几何，这一段是
//     imperative 的 `animate()`，不是声明式 variants。
//   • 退场（弹一层 / 关整个菜单）一律 AnimatePresence 原地淡出，比进入更快更安静。
//
// 🔴 几何契约（morph 的成立条件，改 padding / gap / 图标尺寸必须两边一起改）：
//   行标签 x = list padding(6) + row px(8) + 图标槽(16) + gap(10) = 40px
//   标题  x = header px(14)              + 图标槽(16) + gap(10) = 40px
//   两者必须相等，否则标题会在 morph 结束时「跳」一下。故**每一行都留 16px 前置
//   槽**（勾选框 / 单选勾 / 自定义图标 / 空占位），不给「有图标的行」和「没图标的
//   行」两种标签起点。
//
// 与原实现的差异仅两类（内容 + 颜色），逐条见 README 式清单：
//   内容：原组件只有 label/icon/hint 一种行；这里扩成 label/separator/action/
//         checkbox/radio/submenu/custom 七种，以覆盖全 app 的弹层形态。行的**几何**
//         （min-h-9 / gap-2.5 / rounded-lg / px-2 / text-sm）逐字保留。
//   颜色：原组件的 `bg-popover` / `text-foreground` / `bg-accent` /
//         `text-muted-foreground` / `outline-ring` / `text-destructive` 在本仓
//         tailwind.config 里**已经**别名到 ink/coral token（Sprint 19 shadcn 别名），
//         所以类名原样保留即自动双主题。只有两处硬编码黑色阴影改成了 CSS 变量
//         （见 index.css `.popmenu` 块）—— 原值是给亮色调的，暗色下等于没有。
//
// a11y：role=menu + menuitem/menuitemcheckbox/menuitemradio，roving tabindex，
// ↑↓ 循环、Home/End、→/Enter 进子面板、←/Backspace/Esc 回上一层（根面板 Esc = 关）。

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import {
  AnimatePresence,
  MotionConfig,
  animate,
  motion,
  useIsPresent,
  useReducedMotion
} from 'motion/react'

import { cn } from '@shared/lib/cn'

// ── 原实现的动效常量（逐字保留，勿调） ───────────────────────────────────
const EASE = [0.22, 1, 0.36, 1] as const
const POP_S = 0.22 // 单个面板的进场
const EXIT_S = 0.15 // 退场比进场更快、更安静
/** clip-path 的负向外扩：`inset(0)` 正好压在 border box 上，会把面板自己的
 *  box-shadow / ring 削掉一圈。原实现用 -48px 让 clip 结束时完全放开阴影。 */
const CLIP_BLEED = 48
const DEFAULT_WIDTH = 272 // 原实现 w-[17rem]
const DEFAULT_MAX_HEIGHT = 288 // 原实现 max-h-[18rem]

export type PopmenuTone = 'accent' | 'danger'

/** 一行的公共外观位（除 label/separator/custom 外都有）。 */
interface RowCommon {
  id: string
  label: string
  /** 前置 16px 槽里的内容。不给则留空占位 —— 槽本身恒在（见几何契约）。 */
  icon?: ReactNode
  /** 行尾的弱化说明（如 `3/5`、当前值）。 */
  hint?: string
  /** 行尾的快捷键标注。 */
  shortcut?: string
  disabled?: boolean
}

export type PopmenuItem =
  /** 分节标题（不可聚焦、不可点）。 */
  | { kind: 'label'; id: string; label: string }
  | { kind: 'separator'; id: string }
  /** 普通动作行。**默认点完关菜单**（右键菜单 / 命令列表的常态）；
   *  `keepOpen` opt-out 给「全选 / 清空」这类留在原地继续操作的行。 */
  | (RowCommon & { kind: 'action'; tone?: PopmenuTone; keepOpen?: boolean; onSelect: () => void })
  /** 独立开关轴 —— 勾选框在前置槽。**默认不关菜单**（多选连点）。 */
  | (RowCommon & {
      kind: 'checkbox'
      checked: boolean
      count?: number
      /** 标签前的一枚色点（Tailwind 背景类，如 `bg-crit`）。给「优先级」这类
       *  本身带颜色语义的项用 —— 纯文字列表会把列表行上的颜色编码丢掉。 */
      dotClassName?: string
      closeOnSelect?: boolean
      onToggle: () => void
    })
  /** 单选 —— 勾在前置槽（同组内至多一个 checked）。**默认不关菜单**。 */
  | (RowCommon & {
      kind: 'radio'
      checked: boolean
      count?: number
      closeOnSelect?: boolean
      onSelect: () => void
    })
  /** 下钻一层。点它 → 子面板从这一行 morph 出来。 */
  | (RowCommon & { kind: 'submenu'; items: readonly PopmenuItem[] })
  /** 逃生舱：任意 React 内容嵌进菜单列表（滑块行、色板、预览条…）。
   *  不进键盘导航序列（内部自己管焦点）。 */
  | { kind: 'custom'; id: string; content: ReactNode }

interface Frame {
  /** 根面板为 null。 */
  node: (RowCommon & { kind: 'submenu'; items: readonly PopmenuItem[] }) | null
  key: string
  fromIndex: number | null
  anchor: { top: number; left: number }
  /** 被点行的标签座位（morph 起点）。键盘进入时也有 —— 走的是同一条路径。 */
  morph?: { labelX: number; labelCY: number } | null
}

export interface PopmenuProps {
  open: boolean
  /** 关闭请求（受控：调用方负责把 `open` 置 false）。 */
  onClose: () => void
  /** 无 `title` 时作为根面板的可及性名字。 */
  ariaLabel: string
  /** 菜单形态的内容。与 `children` 二选一。 */
  items?: readonly PopmenuItem[]
  /** 逃生舱：整个根面板交给调用方渲染（表单、日期选择器…）。给了它就不渲染
   *  `items`；子面板仍可由 `items` 里的 submenu 提供。 */
  children?: ReactNode
  /** 根面板的标题栏。不给 = 根面板没有 header（列表直接顶到面板顶）。 */
  title?: string
  /** 触发按钮 —— outside-click 判定排除它（否则点触发器会「关了又开」），
   *  且关闭后把焦点还给它。 */
  triggerRef?: React.RefObject<HTMLElement | null>
  /** 默认锚点（`start` = 左对齐 / `end` = 右对齐），被 `anchorClassName` 覆盖。 */
  align?: 'start' | 'end'
  /** 完全自定义定位类（默认锚在触发器下方）。调用方的定位父元素需 `relative`。 */
  anchorClassName?: string
  /** 面板宽度，px。 */
  width?: number
  /** 列表区的高度上限，px（原实现是写死的 18rem=288）。**另外恒被「面板顶到视口
   *  底的可用空间」二次夹取** —— 原实现只做了横向的边缘修正，纵向靠这个固定上限
   *  兜着；菜单一长（本仓筛选+排序共 13 行 ≈ 579px）固定值就会把内容推到视口外，
   *  而面板是 absolute、页面不滚，被推出去的行**点不到也滚不出来**。 */
  maxHeight?: number
  /** 压暗后方父面板（默认开）。 */
  dim?: boolean
  id?: string
  className?: string
}

function isFocusable(item: PopmenuItem): boolean {
  if (item.kind === 'label' || item.kind === 'separator' || item.kind === 'custom') return false
  return item.disabled !== true
}

function firstFocusable(items: readonly PopmenuItem[]): number {
  const i = items.findIndex(isFocusable)
  return i < 0 ? 0 : i
}

export function Popmenu({
  open,
  onClose,
  ariaLabel,
  items = [],
  children,
  title,
  triggerRef,
  align = 'end',
  anchorClassName,
  width = DEFAULT_WIDTH,
  maxHeight = DEFAULT_MAX_HEIGHT,
  dim = true,
  id,
  className
}: PopmenuProps): React.ReactElement {
  const [frames, setFrames] = useState<Frame[]>([
    { node: null, key: 'root', fromIndex: null, anchor: { top: 0, left: 0 } }
  ])
  const [activeIndex, setActiveIndex] = useState(() => firstFocusable(items))

  const top = frames[frames.length - 1]!
  const topItems: readonly PopmenuItem[] = top.node ? top.node.items : items
  const depth = frames.length - 1

  const stackRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const pendingFocus = useRef<number | null>(null)
  itemRefs.current = []

  const fallbackId = useId()
  const popupId = id ?? fallbackId

  // 行把自己的 DOM 节点登记进来（焦点移动 / drill 几何测量都要拿真节点）。
  // 原实现是把 ref 对象直接传下去让子组件写，本仓 eslint `react-hooks/
  // immutability` 禁止子组件改 prop 上的 ref —— 换成回调，写发生在 owner 这边。
  const registerRow = useCallback((index: number, el: HTMLButtonElement | null) => {
    itemRefs.current[index] = el
  }, [])

  // 关菜单必清栈：留在二级面板的话，下次点触发器直接弹出子面板（用户看到的是
  // 「这颗钮有时候不是菜单」）。React 官方「adjusting state on prop change」：
  // 在 render 期做，比 effect 少一帧、也不触发级联渲染。
  const [lastOpen, setLastOpen] = useState(open)
  if (lastOpen !== open) {
    setLastOpen(open)
    if (!open) {
      setFrames([{ node: null, key: 'root', fromIndex: null, anchor: { top: 0, left: 0 } }])
      setActiveIndex(firstFocusable(items))
    }
  }

  const closeMenu = useCallback(
    (returnFocus: boolean) => {
      onClose()
      if (returnFocus) requestAnimationFrame(() => triggerRef?.current?.focus())
    },
    [onClose, triggerRef]
  )

  // 进一层分支：实测被点行的位置（子面板落在它正下方）和它标签的座位
  // （子面板的标题从那里 morph 出来）。
  const drill = useCallback(
    (item: PopmenuItem & { kind: 'submenu' }, index: number, el?: HTMLElement | null) => {
      if (item.items.length === 0) return
      const origin = stackRef.current
      const node = el ?? itemRefs.current[index]
      let anchor = { top: 0, left: 0 }
      let morph: { labelX: number; labelCY: number } | null = null
      if (origin && node) {
        const o = origin.getBoundingClientRect()
        const r = node.getBoundingClientRect()
        // left 取**父面板**的 left，让整个栈是一道干净的垂直楼梯。
        const panelEl = node.closest('[data-popmenu-panel]')
        const left = panelEl ? panelEl.getBoundingClientRect().left - o.left : 0
        anchor = { top: r.top - o.top, left }
        const labelEl = (node.querySelector('[data-popmenu-label]') ?? node) as HTMLElement
        const lr = labelEl.getBoundingClientRect()
        morph = {
          labelX: lr.left - (o.left + anchor.left),
          labelCY: lr.top + lr.height / 2 - (o.top + anchor.top)
        }
      }
      setFrames((f) => [
        ...f,
        { node: item, key: `${f.length}:${item.id}`, fromIndex: index, anchor, morph }
      ])
      const next = firstFocusable(item.items)
      setActiveIndex(next)
      pendingFocus.current = next
    },
    []
  )

  // 回到某一层（默认上一层）。AnimatePresence 负责把被移除的面板淡出 ——
  // 这里不需要维护任何「退场快照」。
  const popTo = useCallback(
    (target: number) => {
      if (target < 0 || target >= frames.length - 1) return
      const removed = frames[frames.length - 1]!
      setFrames((f) => f.slice(0, target + 1))
      const restore = target === frames.length - 2 ? (removed.fromIndex ?? 0) : 0
      setActiveIndex(restore)
      pendingFocus.current = restore
    },
    [frames]
  )

  const select = useCallback(
    (run: () => void, close: boolean) => {
      run()
      if (close) closeMenu(true)
    },
    [closeMenu]
  )

  const focusIndex = useCallback((index: number) => {
    setActiveIndex(index)
    itemRefs.current[index]?.focus()
  }, [])

  const nextEnabled = useCallback(
    (from: number, delta: number) => {
      const n = topItems.length
      if (n === 0) return from
      for (let step = 1; step <= n; step += 1) {
        const i = (from + delta * step + n * step) % n
        const it = topItems[i]
        if (it && isFocusable(it)) return i
      }
      return from
    },
    [topItems]
  )

  useLayoutEffect(() => {
    if (!open) return
    if (pendingFocus.current != null) {
      const i = pendingFocus.current
      pendingFocus.current = null
      requestAnimationFrame(() => itemRefs.current[i]?.focus())
    }
  }, [open, frames.length])

  // Outside-click。触发器不算「外面」—— 否则点它会「关了又开」。
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node | null
      if (!target) return
      if (stackRef.current?.contains(target)) return
      if (triggerRef?.current?.contains(target)) return
      closeMenu(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, closeMenu, triggerRef])

  // Esc 挂 document 而不是面板：逃生舱内容（自定义表单）里焦点可能不在任何
  // menuitem 上，挂面板会漏。子面板 Esc = 回上一层（下钻菜单里「返回」是最常用
  // 的动作，一路关掉会让用户丢失位置）。
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (depth > 0) popTo(depth - 1)
      else closeMenu(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, depth, popTo, closeMenu])

  // 让整个栈横向留在视口内：位移**原点**（而不是每个面板），楼梯整体滑动，
  // drill 的测量数学不受影响。
  useLayoutEffect(() => {
    if (!open) return undefined
    const el = stackRef.current
    if (!el) return undefined
    const GUTTER = 8
    let raf = 0
    const place = (): void => {
      raf = 0
      el.style.setProperty('--popmenu-shift-x', '0px')
      const rect = el.getBoundingClientRect()
      const vw = document.documentElement.clientWidth
      let shift = 0
      const overRight = rect.right - (vw - GUTTER)
      if (overRight > 0) shift = -overRight
      if (rect.left + shift < GUTTER) shift = GUTTER - rect.left
      el.style.setProperty('--popmenu-shift-x', `${Math.round(shift)}px`)
      // 纵向：从栈原点到视口底还剩多少。每个面板按自己的 anchor.top 再减一次，
      // 于是任何深度的面板都不会长到视口外面去（见 maxHeight 的注释）。
      const vh = document.documentElement.clientHeight
      el.style.setProperty(
        '--popmenu-avail-h',
        `${Math.max(0, Math.round(vh - rect.top - GUTTER))}px`
      )
    }
    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(place)
    }
    place()
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
  }, [open, frames.length])

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
    const item = topItems[activeIndex]
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        focusIndex(nextEnabled(activeIndex, 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        focusIndex(nextEnabled(activeIndex, -1))
        break
      case 'Home':
        e.preventDefault()
        focusIndex(nextEnabled(-1, 1))
        break
      case 'End':
        e.preventDefault()
        focusIndex(nextEnabled(0, -1))
        break
      case 'ArrowRight':
        if (item?.kind === 'submenu') {
          e.preventDefault()
          drill(item, activeIndex, itemRefs.current[activeIndex])
        }
        break
      case 'Enter':
      case ' ':
        if (!item) break
        e.preventDefault()
        if (item.kind === 'submenu') drill(item, activeIndex, itemRefs.current[activeIndex])
        else activate(item, activeIndex, itemRefs.current[activeIndex])
        break
      case 'ArrowLeft':
      case 'Backspace':
        if (depth > 0) {
          e.preventDefault()
          popTo(depth - 1)
        }
        break
      case 'Tab':
        closeMenu(false)
        break
      default:
        break
    }
  }

  function activate(item: PopmenuItem, index: number, el: HTMLElement | null): void {
    if (!isFocusable(item)) return
    switch (item.kind) {
      case 'submenu':
        drill(item, index, el)
        break
      case 'action':
        select(item.onSelect, item.keepOpen !== true)
        break
      case 'checkbox':
        select(item.onToggle, item.closeOnSelect === true)
        break
      case 'radio':
        select(item.onSelect, item.closeOnSelect === true)
        break
      default:
        break
    }
  }

  const defaultAnchor = align === 'end' ? 'right-0' : 'left-0'

  // 🔴 `open &&` 必须在 AnimatePresence **内部** —— 在它外面提前 return 会让整个
  // 栈在关闭时直接卸载，退场淡出一帧都跑不到（原实现的关闭手感就没了）。
  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence>
        {open && (
          <motion.div
            key="popup"
            id={popupId}
            ref={stackRef}
            initial={false}
            exit={{ opacity: 0, pointerEvents: 'none' }}
            transition={{ duration: EXIT_S, ease: EASE }}
            className={cn(
              'absolute z-40 [transform:translateX(var(--popmenu-shift-x,0px))]',
              anchorClassName ?? cn('top-[calc(100%+0.375rem)]', defaultAnchor),
              className
            )}
            style={{ width }}
            data-align={align}
          >
            <AnimatePresence>
              {frames.map((frame, d) => {
                const isTop = d === frames.length - 1
                const panelItems: readonly PopmenuItem[] = frame.node ? frame.node.items : items
                return (
                  <Panel
                    key={frame.key}
                    depth={d}
                    title={frame.node ? frame.node.label : title}
                    ariaLabel={frame.node ? frame.node.label : (title ?? ariaLabel)}
                    items={panelItems}
                    body={frame.node ? undefined : children}
                    anchor={frame.anchor}
                    morphFrom={frame.morph}
                    nodeIcon={frame.node?.icon}
                    isTop={isTop}
                    dim={dim}
                    width={width}
                    maxHeight={maxHeight}
                    activeIndex={isTop ? activeIndex : -1}
                    registerRow={isTop ? registerRow : undefined}
                    onItemEnter={
                      isTop
                        ? (i) => {
                            const it = panelItems[i]
                            if (it && isFocusable(it)) setActiveIndex(i)
                          }
                        : undefined
                    }
                    onItemActivate={isTop ? activate : undefined}
                    onBehindClick={!isTop ? () => popTo(d) : undefined}
                    onBack={isTop && d > 0 ? () => popTo(d - 1) : undefined}
                    onKeyDown={isTop ? onKeyDown : undefined}
                  />
                )
              })}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </MotionConfig>
  )
}

function Panel({
  depth,
  title,
  ariaLabel,
  items,
  body,
  anchor,
  morphFrom,
  nodeIcon,
  isTop,
  dim,
  width,
  maxHeight,
  activeIndex,
  registerRow,
  onItemEnter,
  onItemActivate,
  onBack,
  onBehindClick,
  onKeyDown
}: {
  depth: number
  title?: string
  ariaLabel: string
  items: readonly PopmenuItem[]
  body?: ReactNode
  anchor: { top: number; left: number }
  morphFrom?: { labelX: number; labelCY: number } | null
  nodeIcon?: ReactNode
  isTop: boolean
  dim: boolean
  width: number
  maxHeight: number
  activeIndex: number
  registerRow?: (index: number, el: HTMLButtonElement | null) => void
  onItemEnter?: (index: number) => void
  onItemActivate?: (item: PopmenuItem, index: number, el: HTMLElement | null) => void
  onBack?: () => void
  onBehindClick?: () => void
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void
}): React.ReactElement {
  const panelRef = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()
  // pop 之后 AnimatePresence 还留着这块做淡出 —— 此刻它是一张冻结的快照：
  // 不吃指针事件、从可及性树里摘掉。
  const present = useIsPresent()

  // shared-element morph。目标值依赖被点行的实测几何，所以是 imperative 的
  // animate()，且只在首帧绘制前跑一次：面板从那一行展开（clip 向下放开），标题
  // 从行标签的座位滑到位、字重 plain→bold 交叉淡入，列表与分割线在它下面淡入。
  useLayoutEffect(() => {
    const el = panelRef.current
    if (!el || !morphFrom || reduced) return
    const titleEl = el.querySelector<HTMLElement>('[data-popmenu-title]')
    const headEl = el.querySelector<HTMLElement>('[data-popmenu-header]')
    const plainEl = el.querySelector<HTMLElement>('[data-popmenu-title-plain]')
    const boldEl = el.querySelector<HTMLElement>('[data-popmenu-title-bold]')
    const listEl = el.querySelector<HTMLElement>('[data-popmenu-list]')
    const backEl = el.querySelector<HTMLElement>('[data-popmenu-back]')
    if (!titleEl || !headEl) return
    const p = el.getBoundingClientRect()
    const t = titleEl.getBoundingClientRect()
    const dx = morphFrom.labelX - (t.left - p.left)
    const dy = morphFrom.labelCY - (t.top + t.height / 2 - p.top)
    const clip = Math.max(0, p.height - headEl.getBoundingClientRect().height)
    // 圆角从实际计算值读，不手抄 --r-pop —— 换 token 时这里自动跟随。
    const radius = getComputedStyle(el).borderTopLeftRadius || '12px'
    const opts = { duration: POP_S, ease: EASE } as const
    animate(
      el,
      {
        clipPath: [
          `inset(0px 0px ${clip}px 0px round ${radius})`,
          `inset(${-CLIP_BLEED}px ${-CLIP_BLEED}px ${-CLIP_BLEED}px ${-CLIP_BLEED}px round ${radius})`
        ]
      },
      opts
    )
    animate(titleEl, { x: [dx, 0], y: [dy, 0] }, opts)
    if (plainEl) animate(plainEl, { opacity: [1, 0] }, opts)
    if (boldEl) animate(boldEl, { opacity: [0, 1] }, opts)
    if (listEl) animate(listEl, { opacity: [0, 1] }, opts)
    // 原实现把 header 下边框从透明淡到 rgba(0,0,0,.06)。硬编码黑在暗色主题下
    // 等于没有，故读元素**自己**的计算色作为终点（类名仍是原来的
    // `border-foreground/[0.06]`，两个主题各自解析）。
    const endBorder = getComputedStyle(headEl).borderBottomColor
    animate(headEl, { borderBottomColor: ['rgba(0,0,0,0)', endBorder] }, opts)
    // 原实现里 header 的图标位就是被点行自己的图标，所以 morph 全程不变。本仓的
    // 行不一定带图标（勾选框 / 空占位），返回箭头是新出现的元素 —— 不淡入的话它
    // 会在第 0 帧硬弹出来，正好破坏「这一行长成了标题」那个错觉。
    if (backEl && !nodeIcon) animate(backEl, { opacity: [0, 1] }, opts)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const positionStyle: CSSProperties =
    depth === 0
      ? { position: 'relative', zIndex: 10 }
      : { top: `${anchor.top}px`, left: `${anchor.left}px`, zIndex: 10 + depth }

  // 进场：根面板从触发器方向揭开；实测过的子面板走上面的 morph；没测到几何的
  // 子面板（极少见）退化成 pop-in。
  const enterProps = morphFrom
    ? { initial: false as const }
    : depth === 0
      ? {
          initial: { opacity: 0, scale: 0.96, y: -4 },
          animate: { opacity: 1, scale: 1, y: 0 }
        }
      : {
          initial: { opacity: 0, scale: 0.95, y: -6 },
          animate: { opacity: 1, scale: 1, y: 0 }
        }

  const hasHeader = depth > 0 || title !== undefined

  return (
    <motion.div
      ref={panelRef}
      data-popmenu-panel
      {...enterProps}
      exit={{ opacity: 0 }}
      transition={{
        duration: POP_S,
        ease: EASE,
        opacity: { duration: EXIT_S, ease: EASE }
      }}
      className={cn(
        'popmenu-panel absolute origin-top rounded-[var(--r-pop)] bg-popover',
        '[transition:box-shadow_220ms_var(--popmenu-ease)]',
        isTop ? 'popmenu-panel-elev' : 'popmenu-panel-behind cursor-pointer'
      )}
      data-active={isTop ? 'true' : 'false'}
      data-testid={isTop ? undefined : 'popmenu-panel-behind'}
      style={{ ...positionStyle, width, pointerEvents: present ? undefined : 'none' }}
      onClick={onBehindClick}
      aria-hidden={present && isTop ? undefined : 'true'}
    >
      {/* 不透明面板 + 一层遮罩：叠起来的层要压暗但**不能**透出来
          （直接给面板 opacity 会把它后面每一层都露出来）。 */}
      {!isTop && present && (
        <motion.span
          className="pointer-events-none absolute inset-0 z-[5] rounded-[inherit] bg-popover"
          initial={{ opacity: 0 }}
          animate={{ opacity: dim ? 0.62 : 0 }}
          transition={{ duration: POP_S, ease: EASE }}
          aria-hidden="true"
        />
      )}

      {/* 子面板的 header 逐像素复刻一行的几何（见文件头「几何契约」），所以
          morph 的起始帧**就是**被点的那一行 —— 变的只有标签的字重。图标位同时
          是返回按钮。 */}
      {hasHeader && (
        <div
          data-popmenu-header
          className={cn(
            'flex items-center border-b border-foreground/[0.06]',
            depth > 0 ? 'min-h-9 gap-2.5 px-[0.875rem]' : 'min-h-10 gap-1.5 py-1 pl-[0.875rem] pr-2'
          )}
        >
          {depth > 0 &&
            (onBack ? (
              <button
                type="button"
                data-popmenu-back
                className="relative inline-flex h-4 w-4 flex-none cursor-pointer items-center justify-center text-muted-foreground before:absolute before:-inset-1.5 before:rounded-lg before:content-[''] before:[transition:background-color_250ms_var(--popmenu-ease)] hover:text-foreground hover:before:bg-accent [&>svg]:relative"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation()
                  onBack()
                }}
                aria-label={title}
              >
                {nodeIcon ?? <ChevronLeftIcon />}
              </button>
            ) : (
              <span
                data-popmenu-back
                className="relative inline-flex h-4 w-4 flex-none items-center justify-center text-muted-foreground [&>svg]:relative"
                aria-hidden="true"
              >
                {nodeIcon ?? <ChevronLeftIcon />}
              </span>
            ))}
          <span
            data-popmenu-title
            className="relative min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-sm text-foreground"
          >
            {/* 两份叠放的副本：粗的是真正的标题，细的与行标签同字重。morph 交叉
                淡入它们 —— 比直接动 font-weight 平滑（无可变字体时那会跳档）。 */}
            <span
              data-popmenu-title-plain
              className="pointer-events-none absolute inset-0 font-normal opacity-0"
              aria-hidden="true"
            >
              {title}
            </span>
            <span data-popmenu-title-bold className="font-semibold tracking-[-0.006em]">
              {title}
            </span>
          </span>
        </div>
      )}

      <div
        data-popmenu-list
        className="flex flex-col gap-px overflow-y-auto overscroll-contain p-1.5"
        style={{
          // 原实现的 max-h-[18rem] 变成「硬上限 ∩ 该面板顶到视口底的可用空间」。
          // 减去 anchor.top（本面板在栈里的纵向偏移）与 header 高度，长菜单因此
          // 只会在**面板内部**滚，绝不会把行推到视口外去够不着。
          maxHeight: `min(${maxHeight}px, calc(var(--popmenu-avail-h, 100vh) - ${Math.round(anchor.top) + (hasHeader ? 44 : 0)}px))`
        }}
        role={isTop && present && body === undefined ? 'menu' : undefined}
        aria-label={isTop && present && body === undefined ? ariaLabel : undefined}
        onKeyDown={body === undefined ? onKeyDown : undefined}
      >
        {body !== undefined ? (
          <div
            role={isTop && present ? 'group' : undefined}
            aria-label={isTop && present ? ariaLabel : undefined}
          >
            {body}
          </div>
        ) : (
          items.map((item, index) => (
            <Row
              key={item.id}
              item={item}
              index={index}
              live={isTop && present}
              active={isTop && present && index === activeIndex}
              registerRow={registerRow}
              onItemEnter={onItemEnter}
              onItemActivate={onItemActivate}
            />
          ))
        )}
      </div>
    </motion.div>
  )
}

/** 行的几何是 morph 的成立条件 —— 见文件头「几何契约」，改前先读。 */
const ROW_CLASS =
  'group/item flex w-full min-h-9 items-center gap-2.5 rounded-lg px-2 text-left text-sm text-foreground [transition:background-color_250ms_var(--popmenu-ease)] [@media(pointer:coarse)]:min-h-11'
const ROW_INTERACTIVE =
  'hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring'

function Row({
  item,
  index,
  live,
  active,
  registerRow,
  onItemEnter,
  onItemActivate
}: {
  item: PopmenuItem
  index: number
  /** 顶层且未在退场 —— 只有这时行才是真正可交互的 menuitem。 */
  live: boolean
  active: boolean
  registerRow?: (index: number, el: HTMLButtonElement | null) => void
  onItemEnter?: (index: number) => void
  onItemActivate?: (item: PopmenuItem, index: number, el: HTMLElement | null) => void
}): React.ReactElement | null {
  if (item.kind === 'separator') {
    return <div className="my-1 h-px bg-foreground/[0.06]" role="separator" />
  }
  if (item.kind === 'label') {
    return (
      <div className="px-2 pb-0.5 pt-1.5 text-micro font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {item.label}
      </div>
    )
  }
  if (item.kind === 'custom') {
    return <div className="px-2 py-1">{item.content}</div>
  }

  const disabled = item.disabled === true
  const tone = item.kind === 'action' ? item.tone : undefined
  const checked = item.kind === 'checkbox' || item.kind === 'radio' ? item.checked : undefined

  const lead =
    item.kind === 'checkbox' ? (
      <CheckBox checked={item.checked} />
    ) : item.kind === 'radio' ? (
      <span className="inline-flex h-4 w-4 flex-none items-center justify-center">
        {item.checked && <CheckIcon />}
      </span>
    ) : (
      <span className="inline-flex h-4 w-4 flex-none items-center justify-center text-muted-foreground">
        {item.icon}
      </span>
    )

  const inner = (
    <>
      {lead}
      {item.kind === 'checkbox' && item.dotClassName !== undefined && (
        <span
          aria-hidden
          className={cn('-ml-1 size-1.5 flex-none rounded-full', item.dotClassName)}
        />
      )}
      <span
        data-popmenu-label
        className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
      >
        {item.label}
      </span>
      {item.hint !== undefined && (
        <span className="flex-none text-xs tabular-nums text-muted-foreground">{item.hint}</span>
      )}
      {'count' in item && item.count !== undefined && (
        <span className="flex-none font-mono text-micro tabular-nums text-muted-foreground">
          {item.count}
        </span>
      )}
      {item.shortcut !== undefined && (
        <kbd className="flex-none rounded bg-accent px-1 font-mono text-micro text-muted-foreground">
          {item.shortcut}
        </kbd>
      )}
      {item.kind === 'submenu' && (
        <span className="inline-flex flex-none text-muted-foreground" aria-hidden="true">
          <ChevronRightIcon />
        </span>
      )}
    </>
  )

  const className = cn(
    ROW_CLASS,
    disabled
      ? 'cursor-default text-muted-foreground/70'
      : cn(
          ROW_INTERACTIVE,
          tone === 'accent' && 'text-coral hover:bg-coral/10',
          tone === 'danger' && 'text-destructive hover:bg-destructive/10',
          checked === true && 'font-medium'
        )
  )

  // 后方 / 退场中的面板：行降级成纯展示 <div>（不可聚焦不可点，整块点击由外层
  // 代理 = 返回那一层）。button 套 button 是非法 DOM。
  if (!live) {
    return <div className={className}>{inner}</div>
  }

  const role =
    item.kind === 'checkbox'
      ? 'menuitemcheckbox'
      : item.kind === 'radio'
        ? 'menuitemradio'
        : 'menuitem'

  return (
    <button
      ref={(el) => registerRow?.(index, el)}
      type="button"
      role={role}
      data-popmenu-row
      className={className}
      data-highlighted={active ? 'true' : undefined}
      aria-checked={checked}
      aria-haspopup={item.kind === 'submenu' ? 'menu' : undefined}
      aria-expanded={item.kind === 'submenu' ? false : undefined}
      aria-disabled={disabled ? 'true' : undefined}
      tabIndex={active ? 0 : -1}
      onClick={(e) => {
        e.stopPropagation()
        if (disabled) return
        onItemActivate?.(item, index, e.currentTarget)
      }}
      onMouseEnter={() => onItemEnter?.(index)}
    >
      {inner}
    </button>
  )
}

function CheckBox({ checked }: { checked: boolean }): React.ReactElement {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex h-4 w-4 flex-none items-center justify-center rounded-[4px] border-[1.5px] [transition:background-color_250ms_var(--popmenu-ease),border-color_250ms_var(--popmenu-ease)]',
        checked ? 'border-coral bg-coral/100 text-accent-fg' : 'border-muted-foreground/60'
      )}
    >
      {checked && (
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )}
    </span>
  )
}

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

function ChevronRightIcon(): React.ReactElement {
  return (
    <Svg size={15}>
      <path d="m9 18 6-6-6-6" />
    </Svg>
  )
}
function ChevronLeftIcon(): React.ReactElement {
  return (
    <Svg>
      <path d="m15 18-6-6 6-6" />
    </Svg>
  )
}
function CheckIcon(): React.ReactElement {
  return (
    <span className="text-coral">
      <Svg size={13}>
        <path d="M20 6 9 17l-5-5" />
      </Svg>
    </span>
  )
}
