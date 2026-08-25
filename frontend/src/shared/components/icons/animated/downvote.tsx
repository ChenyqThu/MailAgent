// lucide-animated · downvote。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1。
import * as React from 'react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function DownvoteIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={{
        normal: { translateX: '0px', translateY: '0px', rotate: '0deg' },
        animate: { translateX: '-1px', translateY: '2px', rotate: '-12deg' }
      }}
      svgTransition={{ type: 'tween' as const, duration: 0.4, ease: ICON_EASE }}
    >
      <path d="M17 14V2" />
      <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
    </IconShell>
  )
}
