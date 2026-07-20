// 折叠区统一原语（2026-07-20 owner 反馈「展开/折叠是不是统一组件？动效有点差」）。
//
// 此前全仓有两套折叠写法并存：
//   · AdvancedDisclosure / EmailDetail「更多属性」—— grid-rows 0fr↔1fr 纯 CSS 高度
//     过渡，各自手抄一遍；
//   · AIFieldsBlock Reply Suggestion / ThreadAttachmentBar —— 裸 `{cond && <div/>}`，
//     **零动效**，展开是硬切。
//
// 这里把 grid-rows 那套抽成单源。DESIGN §4.1 的优先级是「能 grid-rows 解决不上
// GSAP」，所以是纯 CSS：0fr→1fr 让浏览器插值行高，内层 overflow-hidden 裁剪，
// 无需测量真实高度、无 rAF、无 JS。时长走 --dur-base(220ms) + standard 曲线。
//
// 顺手修掉手抄版共有的一个真问题：折叠态的子元素仍在 tab 序里（height:0 不影响
// 可聚焦性），键盘用户会 tab 进一个看不见的区域。React 19 的 `inert` 一次解决
// —— 它同时管焦点、点击和 AT 树，比单独挂 aria-hidden 严谨。

import { ChevronDown } from 'lucide-react'

import { cn } from '@shared/lib/cn'

interface ChevronProps {
  expanded: boolean
  size?: number
  strokeWidth?: number
  className?: string
}

/** 折叠标识 —— 全仓统一「ChevronDown + 折叠态 -rotate-90」。
 *
 *  旋转而非换 ChevronRight/ChevronDown 两个图标：同一个 svg 做 transform，
 *  两态的垂直度量完全一致（换图标会有亚像素级抖动），也才有得转。
 */
export function CollapseChevron({
  expanded,
  size = 12,
  strokeWidth = 2,
  className
}: ChevronProps): React.ReactElement {
  return (
    <ChevronDown
      size={size}
      strokeWidth={strokeWidth}
      aria-hidden
      className={cn(
        'shrink-0 transition-transform duration-base ease-standard',
        'motion-reduce:transition-none',
        !expanded && '-rotate-90',
        className
      )}
    />
  )
}

interface RegionProps {
  expanded: boolean
  children: React.ReactNode
  /** 挂到 toggle 按钮的 aria-controls 上。 */
  id?: string
  /** 外层 grid 容器（一般不用传）。 */
  className?: string
  /** 内容间距（padding）放这里 —— **不要**放在折叠区的兄弟节点上，
   *  margin 没法跟着高度过渡，展开瞬间会硬跳。 */
  bodyClassName?: string
  /** 独立内容块（如设置页 Advanced 面板）可传 'region' 补语义；
   *  传了就要一并给 aria-label / aria-labelledby，否则无名 region 反而是噪音。 */
  role?: string
  'aria-labelledby'?: string
  'aria-label'?: string
}

/** 折叠区正文 —— 高度 + 透明度过渡，reduced-motion 下自动归零。
 *
 *  内容**恒挂载**（不是 `{cond && ...}`）—— 卸载的子树没法做退场动画。想省
 *  掉展开才需要的开销（例如缩略图 IPC）请在数据层用 `expanded` 门控，别靠
 *  卸载 DOM。
 */
export function CollapsibleRegion({
  expanded,
  children,
  id,
  className,
  bodyClassName,
  role,
  'aria-labelledby': ariaLabelledBy,
  'aria-label': ariaLabel
}: RegionProps): React.ReactElement {
  return (
    <div
      id={id}
      role={role}
      aria-labelledby={ariaLabelledBy}
      aria-label={ariaLabel}
      // React 19 boolean prop；false 要传 undefined 才不会渲染出 inert="false"
      // （HTML 里任何值都算 true）。
      inert={!expanded || undefined}
      className={cn(
        'grid transition-[grid-template-rows] duration-base ease-standard',
        'motion-reduce:transition-none',
        expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        className
      )}
    >
      {/* min-h-0 让这一行能收缩到 0 以下（grid item 默认 min-height:auto，
          不写就永远塌不下去）。
          🔴 这一层**不能有 padding** —— 它是被 0fr 收缩的 grid item, padding
          属于盒模型最小占用, 不随内容高度归零。实测: pt-1 折叠后残留 4px、
          pt-2 残留 8px, 区块闭不拢 (codex review MEDIUM-4, 浏览器实测确认)。
          所以 bodyClassName 落到再内一层, 那层的高度是内容撑出来的, 被外层
          裁掉后不留痕。 */}
      <div
        className={cn(
          'overflow-hidden min-h-0 transition-opacity duration-base ease-standard',
          'motion-reduce:transition-none',
          expanded ? 'opacity-100' : 'opacity-0'
        )}
      >
        <div className={bodyClassName}>{children}</div>
      </div>
    </div>
  )
}
