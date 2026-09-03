// 收编自 beui.dev `motion/shared-layout-bg.tsx`（MIT，许可原文见同目录 `LICENSE-beui`）。
// 它是「一枚 pill 在一列子元素之间做 shared-layout 位移」的原语，`ui/FileTree` 的选中
// 底色靠它。登记见 `docs/motion-gsap.md`「beui 收编组件登记表」。
//
// 相对上游改了三处：
//   ① 🔴 **剥掉两处 `filter: blur(6px)`**（initial 与 exit 各一处）—— DESIGN §8
//      「No blur — filter is never transitioned」是全仓红线，先例是 `RollSwap.tsx`。
//      剥完之后上游的 `variants` 与 `reducedVariants` 逐字相同，故合并成一份。
//   ② spring 单源 `@shared/lib/motion-tokens`（上游 `@/lib/ease`，值逐字相同），
//      `cn` 单源 `@shared/lib/cn`（上游 `@/lib/utils`）。
//   ③ 新增受控档 `activeIndex`：上游只有 hover 驱动，而资料库树要的是**选中**驱动
//      （design §2.2「选中 pill layoutId + SPRING_LAYOUT」）。受控时**整条 hover 通路
//      不接** —— 否则鼠标扫过一棵 500 行的树会把整列 cloneElement 重跑一遍（§7.1
//      列表性能铁律）。用下标而不是 key 作判据：`Children.toArray` 会给 key 加 `.$`
//      前缀，拿它跟调用方的 id 比对是个静默失配的陷阱。
//
// 未收：上游的 `as="ul"` 分支与 `forwardRef`（本仓无消费点；要用时照上游补回即可）。

import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type HTMLMotionProps,
  type Variants
} from 'motion/react'
import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  useState,
  type HTMLAttributes,
  type MouseEvent,
  type ReactElement,
  type ReactNode
} from 'react'

import { cn } from '@shared/lib/cn'
import { SPRING_LAYOUT } from '@shared/lib/motion-tokens'

export interface SharedLayoutBgProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  children: ReactNode
  /** pill 的类名（默认一层极淡的前景色调，调用方一般会换成自己的选中配方）。 */
  pillClassName?: string
  /** pill 相对每一行的水平外扩（px）。 */
  inset?: number
  /** pill 在行内的定位覆盖（默认贴满行高）。 */
  pillContainerClassName?: string
  /** 受控：pill 落在第 N 个子元素上；`null` = 不显示。不传 = 上游行为（跟 hover）。 */
  activeIndex?: number | null
  /** 透传 `data-*`（结构标记 / 测试锚点）—— `HTMLAttributes` 不含它们，自定义组件也
   *  不像内建元素那样被 TS 特判。 */
  [dataAttribute: `data-${string}`]: unknown
}

const variants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  // 仍有 active 时不淡出 —— pill 是「移过去」而不是「消失再出现」。
  exit: (hasActive: boolean) => (!hasActive ? { opacity: 0 } : {})
}

export function SharedLayoutBg({
  children,
  className,
  onMouseLeave,
  pillClassName,
  pillContainerClassName,
  inset = 20,
  activeIndex,
  ...props
}: SharedLayoutBgProps): ReactElement {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const uid = useId()
  const reduce = useReducedMotion()
  const controlled = activeIndex !== undefined
  const active: number | null = activeIndex !== undefined ? activeIndex : hoveredIndex

  const renderedChildren = Children.toArray(children)
    .filter(isValidElement)
    .map((child, index) => {
      const el = child as ReactElement<{
        className?: string
        onMouseEnter?: () => void
        children?: ReactNode
      }>
      return cloneElement(
        el,
        {
          className: cn('relative', el.props.className),
          ...(controlled
            ? {}
            : {
                onMouseEnter: (): void => {
                  el.props.onMouseEnter?.()
                  setHoveredIndex(index)
                }
              })
        },
        <>
          <AnimatePresence custom={active !== null}>
            {active !== null ? (
              <motion.div
                variants={variants}
                initial="initial"
                animate="animate"
                exit="exit"
                custom={active !== null}
                className={cn('pointer-events-none absolute inset-y-0', pillContainerClassName)}
                style={{ left: -inset, right: -inset }}
              >
                {active === index ? (
                  <motion.div
                    data-shared-layout-pill=""
                    layoutId={`shared-bg-${uid}`}
                    transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
                    className={cn(
                      'pointer-events-none h-full w-full rounded-[var(--r-ctl)] bg-ink-3',
                      pillClassName
                    )}
                  />
                ) : null}
              </motion.div>
            ) : null}
          </AnimatePresence>
          <div className="relative z-10">{el.props.children}</div>
        </>
      )
    })

  const handleMouseLeave = (event: MouseEvent<HTMLElement>): void => {
    if (!controlled) setHoveredIndex(null)
    onMouseLeave?.(event)
  }

  // layoutRoot 把 pill 的 layout 投影限制在这一列里，滚动祖先的偏移不会渗进它的位移。
  return (
    <motion.div
      {...(props as HTMLMotionProps<'div'>)}
      layoutRoot
      onMouseLeave={handleMouseLeave}
      className={cn('flex w-full flex-col', className)}
    >
      {renderedChildren}
    </motion.div>
  )
}
