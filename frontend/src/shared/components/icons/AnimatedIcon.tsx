// 动画图标统一外壳（lucide-animated / pqoqubbw 改造落地）。
//
// 设计见 frontend/docs/motion-gsap.md §10：motion 只用于图标级微交互，必须显式
// tween + 复刻 §8 standard 曲线（禁 spring/bounce）。图标静止态 = lucide-react
// 原 path，所以「部分图标有 hover 动画、部分静态」是无割裂的渐进增强。
//
// 渲染 motion.svg 作为根 —— svg 是 <a>/<button> 的直接（或经普通 DOM 透传的）
// 后代，满足 Sidebar §2.11 收起态 size-swap 选择器（index.css `nav … svg`）。
//
// 触发两种：
//   · trigger='parent'：图标自身不挂 whileHover，靠父级 motion 元素（如
//     motion.button whileHover="animate"）的 variant 传播驱动 —— Sidebar 整行 hover。
//   · trigger='self'：图标 motion.svg 自挂 whileHover —— SettingsRail（Radix
//     TabsTrigger 非 motion，无法传播）。
//
// reduced-motion：不挂 whileHover（self），父侧降级普通元素后也无传播（parent）→
// motion 元素无 hover 源即停在 normal 静止态，等价旧 lucide-react。配合 NavRow 在
// reduce 时渲染普通 button，传播链彻底断开。

import * as React from 'react'
import { motion, useReducedMotion, type Variants, type Transition } from 'motion/react'

import { cn } from '@shared/lib/cn'

/** 复刻 DESIGN.md §8 / gsap.ts standard 曲线。motion 默认 spring 违 §8 红线，
 *  所有图标动画显式传 `{ type: 'tween', ease: ICON_EASE }`。 */
export const ICON_EASE = [0.4, 0, 0.2, 1] as const

/** 图标级微交互默认时长（standard 曲线下）。比 UI 过渡略长以让 path 形变看清，
 *  但远短于装饰动画；keyframe 序列类（bell 摇摆）可在各自 variants 覆盖。 */
export const ICON_DUR = 0.4

export interface AnimatedIconProps {
  /** 像素尺寸（width=height）。主菜单 15，设置菜单 14。 */
  size?: number
  strokeWidth?: number
  className?: string
  /**
   * 'self'（默认）：图标自身 hover 触发 —— standalone / SettingsRail（Radix
   *   TabsTrigger 非 motion，无法传播）/ compose 按钮。
   * 'parent'：图标不挂 whileHover，靠父级 motion 元素（如 NavRow 的 motion.button
   *   whileHover="animate"）的 variant 传播驱动 —— Sidebar 整行 hover。
   */
  trigger?: 'parent' | 'self'
}

interface IconShellProps extends AnimatedIconProps {
  /** 整体动的图标（settings 旋转 / refresh-cw 转）传 svg 级 variants；
   *  部分 path 动的图标（sparkles）不传，由 children 的 motion.path 自带 variants。 */
  svgVariants?: Variants
  /** 仅 svgVariants 存在时生效，控制整体动画时长/曲线。 */
  svgTransition?: Transition
  children: React.ReactNode
}

/** 动画图标外壳 —— 收口 lucide 标准 svg 属性 + size/strokeWidth/className 透传 +
 *  reduce 降级 + hover 触发模式。各具体图标只提供 path / motion.path children。 */
export function IconShell({
  size = 15,
  strokeWidth = 1.75,
  className,
  trigger = 'self',
  svgVariants,
  svgTransition,
  children
}: IconShellProps): React.ReactElement {
  const reduce = useReducedMotion()
  const selfHover = !reduce && trigger === 'self'
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
      variants={svgVariants}
      transition={svgTransition}
      {...(selfHover ? { whileHover: 'animate' as const } : {})}
    >
      {children}
    </motion.svg>
  )
}
