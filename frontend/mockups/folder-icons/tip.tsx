// hover 气泡 —— mockup 专用。移植时换主仓 ui/HoverTip.tsx。

import type React from 'react'

export function Tip({
  label,
  className,
  children
}: {
  label: string
  className?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <span className={`mk-tip${className ? ` ${className}` : ''}`}>
      {children}
      <span className="mk-tip-bubble" role="tooltip">
        {label}
      </span>
    </span>
  )
}
