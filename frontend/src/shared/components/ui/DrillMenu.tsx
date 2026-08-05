// DrillMenu — 原地下钻堆叠菜单（iOS 风格，参考 lab.moumen.dev 的 nested-menu）。
//
// 为什么是**新原语**而不是又一个手搓弹层：本仓的菜单全是手搓的（ModelPicker /
// ComposerPlusMenu / 旧 .filter-pop 各写一份 outside-click + Esc + 焦点处理），
// owner 原话「我们目前整个的 popover 体验都很差」。这一版把「面板栈 + 下钻动效 +
// 键盘导航 + 受控项渲染」收敛成一个组件，本批只接进 EmailListHeader；其余弹层的
// 迁移留给后续（**不要**顺手改）。
//
// 与 hover flyout 的区别（设计取舍，不是省事）：子菜单**点击**才进，进去后父面板
// 退到后面变暗、点它即返回。hover flyout 在 360px 宽的列表面板里没有横向空间放第二
// 层，而且鼠标斜着划过去就会误关。
//
// 动效（§8 红线内，无 bounce/overshoot）：
//   进 = DUR.base(220ms) —— 子面板从「被点那一行的高度带」clip 展开 + 位移，使被点
//        行的位置读起来变成了新面板的标题；父面板同时变暗后退。
//   退 = DUR.fast(120ms)（「比进入快而安静」）。
//   壳体高度随当前面板 tween（§6 允许的 layout 动画：非列表、单实例、低频）。
//   reduced-motion → 全部瞬切（GSAP 绕过 CSS 媒体查询，必须在 JS 层短路）。
//
// a11y：role=menu + menuitemcheckbox / menuitemradio / menuitem(+aria-haspopup)，
// ↑↓ 移动、→/Enter 进子面板、←/Esc 返回上一层（根面板 Esc = 关），焦点落新面板首项。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { DUR, gsap } from '@shared/lib/gsap'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'

export type DrillMenuItem =
  /** 分节标题（不可聚焦、不可点）。 */
  | { kind: 'label'; id: string; label: string }
  | { kind: 'separator'; id: string }
  /** 独立开关轴 —— aria-checked，勾选框在左。 */
  | {
      kind: 'checkbox'
      id: string
      label: string
      checked: boolean
      count?: number
      shortcut?: string
      disabled?: boolean
      /** 标签前的一枚色点（Tailwind 背景类，如 `bg-crit`）。给「优先级」这类
       *  本身带颜色语义的项用 —— 纯文字列表会把 EmailRow 上的颜色编码丢掉。 */
      dotClassName?: string
      onToggle: () => void
    }
  /** 单选 —— 勾在左（同组内至多一个 checked）。 */
  | {
      kind: 'radio'
      id: string
      label: string
      checked: boolean
      count?: number
      shortcut?: string
      onSelect: () => void
    }
  /** 下钻一层。`hint` 显示在行尾（如「3 / 5」这种收窄提示）。 */
  | { kind: 'submenu'; id: string; label: string; hint?: string; items: DrillMenuItem[] }
  /** 普通动作行（点完通常关菜单）。 */
  | { kind: 'action'; id: string; label: string; tone?: 'accent'; onSelect: () => void }

interface PanelFrame {
  title: string | null
  items: ReadonlyArray<DrillMenuItem>
}

export interface DrillMenuProps {
  open: boolean
  onClose: () => void
  items: ReadonlyArray<DrillMenuItem>
  ariaLabel: string
  /** 触发按钮 —— outside-click 判定时排除它（否则点触发器会「关了又开」）。 */
  triggerRef?: React.RefObject<HTMLElement | null>
  /** 壳体定位类（默认锚在触发器下方、右对齐）。 */
  anchorClassName?: string
  id?: string
}

const PANEL_WIDTH = 272

const ROW_BASE =
  'flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2.5 py-[7px] text-left text-aux transition-colors duration-fast'
const ROW_INTERACTIVE =
  'hover:bg-ink-4 hover:text-ink-fg focus-visible:bg-ink-4 focus-visible:outline-none'

function isFocusable(item: DrillMenuItem): boolean {
  if (item.kind === 'label' || item.kind === 'separator') return false
  if (item.kind === 'checkbox' && item.disabled === true) return false
  return true
}

export function DrillMenu({
  open,
  onClose,
  items,
  ariaLabel,
  triggerRef,
  anchorClassName,
  id
}: DrillMenuProps): React.ReactElement | null {
  const reduceMotion = useReducedMotion()
  const shellRef = useRef<HTMLDivElement>(null)
  const activePanelRef = useRef<HTMLDivElement>(null)
  const backPanelRef = useRef<HTMLDivElement>(null)
  // 栈里只存**路径**（submenu id 序列），内容在渲染时按路径从最新的 `items` 重新
  // 取 —— 调用方每次 render 都从 store 现算 items，存快照会让下钻后勾选不刷新。
  const [path, setPath] = useState<string[]>([])
  // 进场几何：push 时记下被点行相对壳体的 rect；pop / 首开为 null。
  const enterFromRef = useRef<{ top: number; height: number } | null>(null)

  // 关菜单必清栈：留在二级面板的话，下次点触发器直接弹出子面板
  // （用户看到的是「这颗钮有时候不是菜单」—— ComposerPlusMenu 同款教训）。
  // React 官方「adjusting state on prop change」：在 render 期做，比 effect 少一
  // 帧、也不触发级联渲染（useEmailListRows 的 lastView 同款写法）。
  const [lastOpen, setLastOpen] = useState(open)
  if (lastOpen !== open) {
    setLastOpen(open)
    if (!open) setPath([])
  }

  const frames: PanelFrame[] = [{ title: null, items }]
  {
    let cur = items
    for (const seg of path) {
      const hit = cur.find((it) => it.kind === 'submenu' && it.id === seg)
      if (!hit || hit.kind !== 'submenu') break
      frames.push({ title: hit.label, items: hit.items })
      cur = hit.items
    }
  }
  const active = frames[frames.length - 1]!
  const back = frames.length > 1 ? frames[frames.length - 2]! : null

  const push = useCallback((submenuId: string, rowEl: HTMLElement | null): void => {
    const shell = shellRef.current
    if (shell && rowEl) {
      const s = shell.getBoundingClientRect()
      const r = rowEl.getBoundingClientRect()
      enterFromRef.current = { top: r.top - s.top, height: r.height }
    } else {
      enterFromRef.current = null
    }
    setPath((p) => [...p, submenuId])
  }, [])

  const pop = useCallback((): void => {
    enterFromRef.current = null
    setPath((p) => (p.length === 0 ? p : p.slice(0, -1)))
  }, [])

  // Outside-click + Esc。Esc 在子面板 = 回上一层，在根面板 = 关整个菜单
  // （下钻菜单里「返回」是最常用的动作，一路关掉会让用户丢失位置）。
  useEffect(() => {
    if (!open) return undefined
    function onDown(ev: MouseEvent): void {
      const target = ev.target as Node | null
      if (!target) return
      if (shellRef.current?.contains(target)) return
      if (triggerRef?.current?.contains(target)) return
      onClose()
    }
    function onKey(ev: KeyboardEvent): void {
      if (ev.key !== 'Escape') return
      ev.stopPropagation()
      if (path.length > 0) pop()
      else onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, pop, path.length, triggerRef])

  const rowNodes = (): HTMLElement[] =>
    Array.from(activePanelRef.current?.querySelectorAll<HTMLElement>('[data-drill-row]') ?? [])

  const moveFocus = (delta: number): void => {
    const nodes = rowNodes()
    if (nodes.length === 0) return
    const cur = nodes.findIndex((n) => n === document.activeElement)
    const next =
      cur < 0 ? (delta > 0 ? 0 : nodes.length - 1) : (cur + delta + nodes.length) % nodes.length
    nodes[next]?.focus()
  }

  const onPanelKeyDown = (ev: React.KeyboardEvent): void => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault()
      moveFocus(1)
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault()
      moveFocus(-1)
    } else if (ev.key === 'ArrowLeft' && path.length > 0) {
      ev.preventDefault()
      pop()
    }
  }

  // 面板切换：壳体高度 tween + 当前面板进场 + 后方面板变暗后退。
  // useLayoutEffect：进场起始值必须在浏览器绘制前写下，否则会闪一帧全高。
  useLayoutEffect(() => {
    if (!open) return undefined
    const shell = shellRef.current
    const panel = activePanelRef.current
    if (!shell || !panel) return undefined
    const target = panel.offsetHeight
    const from = enterFromRef.current
    enterFromRef.current = null
    const backEl = backPanelRef.current

    if (reduceMotion) {
      gsap.set(shell, { height: target })
      gsap.set(panel, { clearProps: 'all' })
      if (backEl) gsap.set(backEl, { autoAlpha: 0.35, scale: 0.98 })
      return undefined
    }

    const tl = gsap.timeline()
    // 首次绘制（壳体还没有 inline height）直接落位，不从 0 撑开。
    if (shell.style.height === '') gsap.set(shell, { height: target })
    else tl.to(shell, { height: target, duration: DUR.base }, 0)

    if (from) {
      // 被点行 → 新面板标题的 morph：面板整体从「那一行的位置」上移到位，同时
      // clip 从那一行的高度带展开到全高，读起来就是这一行变成了标题。
      const bottom = Math.max(0, target - (from.top + from.height))
      tl.fromTo(
        panel,
        { y: from.top, clipPath: `inset(${from.top}px 0px ${bottom}px 0px)` },
        { y: 0, clipPath: 'inset(0px 0px 0px 0px)', duration: DUR.base, clearProps: 'transform' },
        0
      )
      const body = panel.querySelector<HTMLElement>('[data-drill-body]')
      if (body) tl.fromTo(body, { autoAlpha: 0 }, { autoAlpha: 1, duration: DUR.base }, 0)
    } else {
      // 首开 / 返回上一层：安静淡入，比进入快。
      tl.fromTo(panel, { autoAlpha: 0 }, { autoAlpha: 1, duration: DUR.fast }, 0)
    }
    if (backEl) tl.to(backEl, { autoAlpha: 0.35, scale: 0.98, duration: DUR.base }, 0)
    return () => {
      tl.kill()
    }
  }, [open, path.length, reduceMotion])

  // 🔴 壳体高度还要跟随**内容**变化，不只是面板切换：菜单开着的时候勾一个筛选，
  // 调用方会往 items 里加/去掉行（本仓第一个消费者就有「清除筛选」这么一行）。
  // 只在 push/pop 时量高度的话，多出来的那行会被 overflow:hidden 直接切掉 ——
  // 而且是「点了才出现问题」，肉眼看是「菜单缺了一项」。ResizeObserver 盯当前
  // 面板的自然高度，差了就补（不走 morph 那套，只是把壳体拉到位）。
  useEffect(() => {
    if (!open) return undefined
    const shell = shellRef.current
    const panel = activePanelRef.current
    if (!shell || !panel || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => {
      const next = panel.offsetHeight
      if (next === 0 || Math.abs(next - shell.offsetHeight) <= 0.5) return
      if (reduceMotion) gsap.set(shell, { height: next })
      else gsap.to(shell, { height: next, duration: DUR.fast, overwrite: 'auto' })
    })
    ro.observe(panel)
    return () => ro.disconnect()
  }, [open, path.length, reduceMotion])

  // 进新面板后焦点落首项（键盘用户不必再按一次 ↓ 才进得去）。根面板不抢焦点 ——
  // 那会在「点开菜单」时把焦点从触发器上夺走，鼠标用户看到一个莫名的高亮行。
  useEffect(() => {
    if (!open || path.length === 0) return
    rowNodes()[0]?.focus()
  }, [open, path.length])

  if (!open) return null

  return (
    <div
      ref={shellRef}
      id={id}
      className={cn('drill-shell', anchorClassName ?? 'right-2 top-[calc(100%+4px)]')}
      style={{ width: PANEL_WIDTH }}
    >
      {/* 后方父面板：只作背景，整块点击 = 返回上一层。里面的行是纯展示 <div>
          （不是 disabled 的 <button> —— button 套 button 是非法 DOM）。 */}
      {back && (
        <div
          ref={backPanelRef}
          aria-hidden="true"
          onClick={pop}
          className="drill-panel-back"
          data-testid="drill-panel-back"
        >
          <PanelRows items={back.items} inert />
        </div>
      )}
      <div
        ref={activePanelRef}
        role="menu"
        aria-label={active.title ?? ariaLabel}
        onKeyDown={onPanelKeyDown}
        className="drill-panel-front"
      >
        {active.title !== null && (
          <div className="mb-1 flex items-center gap-1 border-b border-ink-border-soft px-1 pb-1.5">
            <button
              type="button"
              data-drill-row
              onClick={pop}
              aria-label={active.title}
              className="grid size-5 shrink-0 place-items-center rounded-[var(--r-ctl)] text-ink-fg-3 transition-colors duration-fast hover:bg-ink-4 hover:text-ink-fg"
            >
              <ChevronLeft size={13} strokeWidth={2} />
            </button>
            <span className="truncate text-aux font-semibold text-ink-fg">{active.title}</span>
          </div>
        )}
        <div data-drill-body>
          <PanelRows items={active.items} onEnterSubmenu={push} />
        </div>
      </div>
    </div>
  )
}

function PanelRows({
  items,
  onEnterSubmenu,
  inert = false
}: {
  items: ReadonlyArray<DrillMenuItem>
  /** inert 面板不需要（它的行不可点），故可选。 */
  onEnterSubmenu?: (id: string, row: HTMLElement | null) => void
  /** 后方父面板的复制品：纯 <div>，不可聚焦不可点（点击由外层代理 = 返回）。 */
  inert?: boolean
}): React.ReactElement {
  const firstFocusableId = items.find(isFocusable)?.id
  return (
    <>
      {items.map((item) => {
        if (item.kind === 'separator') {
          return <div key={item.id} className="my-1 h-px bg-ink-border-soft" role="separator" />
        }
        if (item.kind === 'label') {
          return (
            <div
              key={item.id}
              className="px-2.5 pb-0.5 pt-1.5 text-micro font-medium uppercase tracking-[0.08em] text-ink-fg-3"
            >
              {item.label}
            </div>
          )
        }
        // roving tabindex：整块菜单只有一个 tab stop，方向键在内部移动。
        // disabled 行不打 data-drill-row —— 否则 ↑↓ 会停在一个点不动的行上。
        const rowProps =
          inert || !isFocusable(item)
            ? {}
            : { 'data-drill-row': '', tabIndex: item.id === firstFocusableId ? 0 : -1 }
        const Tag = (inert ? 'div' : 'button') as 'div'
        const common = inert ? {} : ({ type: 'button' } as Record<string, unknown>)

        switch (item.kind) {
          case 'checkbox':
            return (
              <Tag
                key={item.id}
                {...common}
                {...rowProps}
                role="menuitemcheckbox"
                aria-checked={item.checked}
                aria-disabled={item.disabled === true}
                onClick={inert || item.disabled === true ? undefined : item.onToggle}
                className={cn(
                  ROW_BASE,
                  item.disabled === true
                    ? 'cursor-not-allowed text-ink-fg-3 opacity-60'
                    : cn(ROW_INTERACTIVE, item.checked ? 'text-ink-fg' : 'text-ink-fg-1')
                )}
              >
                <CheckBox checked={item.checked} />
                {item.dotClassName !== undefined && (
                  <span
                    aria-hidden
                    className={cn('size-1.5 shrink-0 rounded-full', item.dotClassName)}
                  />
                )}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                <RowTail count={item.count} shortcut={item.shortcut} />
              </Tag>
            )
          case 'radio':
            return (
              <Tag
                key={item.id}
                {...common}
                {...rowProps}
                role="menuitemradio"
                aria-checked={item.checked}
                onClick={inert ? undefined : item.onSelect}
                className={cn(
                  ROW_BASE,
                  ROW_INTERACTIVE,
                  item.checked ? 'font-medium text-ink-fg' : 'text-ink-fg-1'
                )}
              >
                <span className="grid size-[13px] shrink-0 place-items-center">
                  {item.checked && <Check size={12} strokeWidth={2.5} className="text-accent" />}
                </span>
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                <RowTail count={item.count} shortcut={item.shortcut} />
              </Tag>
            )
          case 'submenu':
            return (
              <Tag
                key={item.id}
                {...common}
                {...rowProps}
                role="menuitem"
                aria-haspopup="menu"
                onClick={
                  inert
                    ? undefined
                    : (e: React.MouseEvent<HTMLElement>) =>
                        onEnterSubmenu?.(item.id, e.currentTarget as HTMLElement)
                }
                onKeyDown={
                  inert
                    ? undefined
                    : (e: React.KeyboardEvent<HTMLElement>) => {
                        if (e.key === 'ArrowRight' || e.key === 'Enter') {
                          e.preventDefault()
                          onEnterSubmenu?.(item.id, e.currentTarget as HTMLElement)
                        }
                      }
                }
                className={cn(ROW_BASE, ROW_INTERACTIVE, 'text-ink-fg-1')}
              >
                <span className="size-[13px] shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.hint !== undefined && (
                  <span className="shrink-0 font-mono text-micro text-ink-fg-3">{item.hint}</span>
                )}
                <ChevronRight size={13} strokeWidth={2} className="shrink-0 text-ink-fg-3" />
              </Tag>
            )
          case 'action':
            return (
              <Tag
                key={item.id}
                {...common}
                {...rowProps}
                role="menuitem"
                onClick={inert ? undefined : item.onSelect}
                className={cn(
                  ROW_BASE,
                  'focus-visible:outline-none',
                  item.tone === 'accent'
                    ? 'text-coral hover:bg-coral/10 focus-visible:bg-coral/10'
                    : cn(ROW_INTERACTIVE, 'text-ink-fg-1')
                )}
              >
                <span className="size-[13px] shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </Tag>
            )
        }
      })}
    </>
  )
}

function CheckBox({ checked }: { checked: boolean }): React.ReactElement {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-[13px] shrink-0 place-items-center rounded-[3px] border-[1.5px] transition-colors duration-fast',
        checked ? 'border-accent bg-accent text-white' : 'border-ink-fg-3'
      )}
    >
      {checked && <Check size={9} strokeWidth={3.5} />}
    </span>
  )
}

function RowTail({
  count,
  shortcut
}: {
  count?: number
  shortcut?: string
}): React.ReactElement | null {
  if (count === undefined && shortcut === undefined) return null
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {count !== undefined && (
        <span className="font-mono text-micro tabular-nums text-ink-fg-2">{count}</span>
      )}
      {shortcut !== undefined && (
        <kbd className="rounded bg-ink-3 px-1 font-mono text-micro text-ink-fg-3">{shortcut}</kbd>
      )}
    </span>
  )
}
