// 迷你折线（看板专用）。原本长在 KosIngestSection 里，task 08-20-perf-dashboards
// 给 /admin/kanban 的 v4 路由趋势要用第二次 —— 与其抄第三份 path 计算，不如在这里放
// 一份。纪律照旧：**手搓 SVG，不引 recharts / d3**。
//
// 空序列渲染一条基线（不是不渲染）——卡片高度稳定比「没数据就消失」重要。

import { cn } from '@shared/lib/cn'

export function Sparkline({
  points,
  className,
  width = 120,
  height = 28
}: {
  points: number[]
  className?: string
  width?: number
  height?: number
}): React.ReactElement {
  // max=0（全零序列）时除法会炸出 NaN → 兜底 1，画成贴底的一条线。
  const max = Math.max(1, ...points)
  const step = points.length > 1 ? width / (points.length - 1) : width
  const d =
    points.length === 0
      ? `M0 ${height} L${width} ${height}`
      : points
          .map(
            (v, i) =>
              `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)} ${(height - (v / max) * height).toFixed(1)}`
          )
          .join(' ')
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('overflow-visible', className)}
    >
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  )
}
