// 动画图标统一外壳（lucide-animated / pqoqubbw 改造落地）。
//
// 设计见 frontend/docs/motion-gsap.md §10：motion 只用于图标级微交互，必须显式
// tween + 复刻 §8 standard 曲线（禁 spring/bounce）。图标静止态 = lucide-react
// 原 path，所以「部分图标有 hover 动画、部分静态」是无割裂的渐进增强。
//
// ── 触发机制（受控 active 通道，不靠 motion variant 传播）──────────────────
// 历史教训（Playwright 实测 + codex 复盘）：曾用「父 motion.button whileHover=
// 'animate' → 子 motion.svg variant 传播」驱动整行 hover，但 **完全不生效**。
// 根因：Motion 12 里 `initial` 也是 variant prop，IconShell 写了 `initial=
// "normal"` → 被判定为 isControllingVariants=true 的「控制型节点」，控制型节点
// 不会注册进父级 variantChildren，所以父 button 的 hover active state 永远到不了
// 这棵 svg。（self 模式能动只是因为 whileHover 挂在 svg 自己身上。）
//
// 现方案：IconShell 内部用 useAnimationControls()，svg 挂 `animate={controls}`
// 成为 variant root；由 useEffect 按「是否 active」显式 controls.start('animate'
// |'normal')。controls 会递归驱动内部 motion.path/g/line/circle 的同名 variants
// —— 所以 11 个 path 级图标无需逐个接 controls。
//
// active 来源（优先级 active prop > Context > 自身 hover）：
//   · <AnimatedIconActiveProvider active={rowHovered}>：父行/父 tab 把「整行/整
//     tab 是否 hover/focus」经 zero-DOM Context 下发（Provider 不渲染 DOM，svg
//     仍是 <button>/<a> 的直接子元素，满足 Sidebar §2.11 收起态 size-swap 选择器）。
//   · trigger='self'（默认，无 Provider 时）：图标自身 onPointerEnter/Leave 驱动
//     —— standalone 用法（如 compose 按钮）。
//
// reduced-motion：controls.set('normal') 瞬时定格静止态，不挂任何 hover 监听，
// 等价旧 lucide-react。测试环境 tests/setup.ts 全局强制 reduce → 自动 no-op。

import * as React from 'react'
import {
  motion,
  useAnimationControls,
  useReducedMotion,
  type Transition,
  type Variants
} from 'motion/react'

import { cn } from '@shared/lib/cn'

/** 复刻 DESIGN.md §8 / gsap.ts standard 曲线。motion 默认 spring 违 §8 红线，
 *  所有图标动画显式 tween + 该 ease。 */
export const ICON_EASE = [0.4, 0, 0.2, 1] as const

/** 图标级微交互默认时长（standard 曲线下）。比 UI 过渡略长以让 path 形变看清，
 *  但远短于装饰动画；keyframe 序列类（bell 摇摆）可在各自 variants 覆盖。 */
export const ICON_DUR = 0.4

/** 统一 tween override —— 回 normal 时强制走它，防 motion 默认 spring（§8）。进入
 *  animate 时不 override（传 undefined），让各图标 variant 自带的 per-path
 *  duration/delay/keyframe 生效。 */
const ICON_TWEEN: Transition = { type: 'tween', duration: ICON_DUR, ease: ICON_EASE }

/** zero-DOM active 通道：父行/父 tab 把 hover/focus 状态经 Context 下发给后代
 *  AnimatedIcon。Provider 不渲染任何 DOM 节点，因此不影响 §2.11 的
 *  svg-as-direct-child 契约。静态 lucide 图标（非 AnimatedIcon）在 Provider 内
 *  不读 context，无副作用。 */
const IconActiveContext = React.createContext<boolean | null>(null)

export function AnimatedIconActiveProvider({
  active,
  children
}: {
  active: boolean
  children: React.ReactNode
}): React.ReactElement {
  return <IconActiveContext.Provider value={active}>{children}</IconActiveContext.Provider>
}

export interface AnimatedIconProps {
  /** 像素尺寸（width=height）。主菜单 15，设置菜单 14。 */
  size?: number
  strokeWidth?: number
  className?: string
  /**
   * 'self'（默认）：无 Provider 时图标自身 hover 触发 —— standalone / compose 按钮。
   * 'parent'：保留向后兼容的标注语义；实际由 AnimatedIconActiveProvider 的 Context
   *   驱动（NavRow / SettingsTabTrigger 整行整 tab hover），trigger 值不再影响行为。
   */
  trigger?: 'parent' | 'self'
  /** 受控激活态（优先级高于 Context）：显式 true/false 直接驱动 animate/normal。
   *  一般留空，由父级 AnimatedIconActiveProvider 经 Context 下发。 */
  active?: boolean
}

interface IconShellProps extends AnimatedIconProps {
  /** 整体动的图标（settings 旋转 / refresh-cw 转）传 svg 级 variants；
   *  部分 path 动的图标（sparkles）不传，由 children 的 motion.path 自带 variants
   *  —— controls 作为 variant root 会递归驱动它们。 */
  svgVariants?: Variants
  /** 仅 svgVariants 存在时生效，控制整体动画时长/曲线。 */
  svgTransition?: Transition
  children: React.ReactNode
}

/** 动画图标外壳 —— 收口 lucide 标准 svg 属性 + size/strokeWidth/className 透传 +
 *  reduce 降级 + 受控 active 触发。各具体图标只提供 path / motion.path children。 */
export function IconShell({
  size = 15,
  strokeWidth = 1.75,
  className,
  trigger = 'self',
  active,
  svgVariants,
  svgTransition,
  children
}: IconShellProps): React.ReactElement {
  const reduce = useReducedMotion()
  const controls = useAnimationControls()
  const contextActive = React.useContext(IconActiveContext)
  const [selfActive, setSelfActive] = React.useState(false)

  // 优先级：显式 active prop > Provider Context > 自身 hover（仅 self 且无上游信号）。
  const controlledActive = active ?? contextActive
  const shouldAnimate = !reduce && (controlledActive ?? (trigger === 'self' && selfActive))

  React.useEffect(() => {
    if (reduce) {
      controls.set('normal')
      return
    }
    // animate：不 override transition（用各图标 variant 自带的 per-path 时序）。
    // normal：强制 ICON_TWEEN，防 motion 默认 spring（§8）。
    void controls.start(
      shouldAnimate ? 'animate' : 'normal',
      shouldAnimate ? undefined : ICON_TWEEN
    )
  }, [controls, reduce, shouldAnimate])

  // 仅 standalone self 图标（无 Provider/无受控 active）自挂 hover 监听。
  const selfHandlers =
    !reduce && controlledActive == null && trigger === 'self'
      ? {
          onPointerEnter: () => setSelfActive(true),
          onPointerLeave: () => setSelfActive(false)
        }
      : {}

  return (
    <motion.svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn('shrink-0', className)}
      initial="normal"
      animate={controls}
      variants={svgVariants}
      transition={svgTransition ?? ICON_TWEEN}
      {...selfHandlers}
    >
      {children}
    </motion.svg>
  )
}
