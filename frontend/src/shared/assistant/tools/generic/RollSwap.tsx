// beui `components/motion/action-swap-roll` 的收编，tool-result 专属（登记见 docs/motion-gsap.md
// 末尾「beui 收编组件登记表」）。同 slot 的内容变化时：旧的向上滚出、新的从下滚入。
//
// 🔴 与上游的两处**有意**偏差（都是本仓红线，不是漏抄）：
//   ① **无 blur。** 上游 roll 的 enter/exit 都带 `filter: blur(3px)`。DESIGN.md §8
//      「`.icon-swap` cross-fade … No blur — filter is never transitioned」是全仓红线
//      （motion-gsap.md §9.2 称其为「§1 的零 filter 红线」—— 连 `mask` 都要单独写一句
//      豁免才敢用）。所以这里只动 opacity + y，一个 filter 也不过渡。
//   ② **不测量宽度。** 上游 `ActionSwapText` 挂一个隐藏 span 量 offsetWidth、再把两层绝对
//      定位叠起来 + `width` 过渡。这里改用 `AnimatePresence mode="popLayout"`：进场层留在
//      正常流里决定盒子尺寸，退场层由 motion 自己提成 absolute —— 与本仓已收编的
//      `ui/animated-badge.tsx` 同款，少一个 useLayoutEffect，也不会把父级的
//      truncate / min-w-0 布局用写死的 px 宽度顶掉。
//
// spring 只从 `@shared/lib/motion-tokens` 取 `SPRING_SWAP`（§1 白名单里「控件内部标签/图标
// 切换」那一档），进退场同一条，不内联 stiffness/damping、不另立第四档时长。
//
// reduced-motion → **直接渲染 children**（不包装、不挂 AnimatePresence），即「直接替换」。
// 不是「duration:0 的 AnimatePresence」：那样退场层仍会短暂留在 DOM 里，而 reduce 用户要的
// 是结构上就没有第二层。

import { AnimatePresence, motion } from 'motion/react'

import { cn } from '@shared/lib/cn'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { SPRING_SWAP } from '@shared/lib/motion-tokens'

export interface RollSwapProps {
  /** slot 身份 —— 值变了才算「换了内容」，同值重渲不重放动画。 */
  value: string
  children: React.ReactNode
  /** 外层（裁剪盒）类名。 */
  className?: string
  /** 内层（滚动层）类名。 */
  layerClassName?: string
}

export function RollSwap({
  value,
  children,
  className,
  layerClassName
}: RollSwapProps): React.JSX.Element {
  const reduce = useReducedMotion()

  if (reduce) {
    return (
      <span data-roll-swap="off" className={className}>
        {children}
      </span>
    )
  }

  return (
    <span
      data-roll-swap="on"
      // overflow-hidden 是「roll」的裁剪盒：没有它滚入/滚出会溢出到相邻行。
      className={cn('relative inline-grid overflow-hidden align-bottom', className)}
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={value}
          data-roll-layer={value}
          initial={{ opacity: 0, y: '90%' }}
          animate={{ opacity: 1, y: '0%' }}
          exit={{ opacity: 0, y: '-90%' }}
          transition={SPRING_SWAP}
          className={cn(
            'col-start-1 row-start-1 inline-flex items-center will-change-[opacity,transform]',
            layerClassName
          )}
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}
