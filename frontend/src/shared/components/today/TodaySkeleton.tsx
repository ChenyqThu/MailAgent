// 例外面加载骨架屏。做法照 `notifications/NotificationSkeleton.tsx`（同一套材质语言、同一条
// 「几何对不上就是白闪一下再跳版」的纪律），只是把行几何换成 `TodayItemRow` 的。
//
// 🔴 骨架只吃**列表体**：页头（标题 / 副标题）在数据到达前就能显示，做成骨架等于把已经
// 可用的东西藏起来。
//
// 🔴 动效纯 CSS：复用 index.css 已有的 `.shimmer`（`agents-shimmer` keyframes，无 JS 无 rAF）。
// `prefers-reduced-motion` 的关停沿用 `.notify-skel`（该类只做关停，不带几何）。
//
// 两组 × 3 行：贴着「等我处理 + 一个别的组」这个最常见的落地形状，加载 → 有数据之间不大跳。

import { cn } from '@shared/lib/cn'

const SKELETON_GROUPS = 2
const SKELETON_ROWS_PER_GROUP = 3

/** 行内条宽循环表。🔴 固定表而不是 `Math.random()` —— render 期调随机数既违反纯度，也会让
 *  每次重渲染条宽跳动，把「安静地占位」变成「一屏抖动」（NotificationSkeleton 同款裁量）。 */
const ROW_BAR_WIDTHS: ReadonlyArray<{ title: number; time: number; triage: number }> = [
  { title: 148, time: 36, triage: 262 },
  { title: 116, time: 30, triage: 198 },
  { title: 172, time: 42, triage: 236 }
]

function Bar({
  w,
  h = 10,
  className
}: {
  w: number | string
  h?: number
  className?: string
}): React.ReactElement {
  return (
    <span
      aria-hidden
      className={cn('notify-skel shimmer block rounded-[4px]', className)}
      style={{ width: w, height: h }}
    />
  )
}

export function TodayListSkeleton(): React.ReactElement {
  return (
    <div aria-hidden data-testid="today-list-skeleton">
      {Array.from({ length: SKELETON_GROUPS }, (_unused, groupIndex) => (
        <section key={`today-skel-group-${groupIndex}`} className="mb-5">
          {/* 组头几何与真实组头同：图标 20px + 标签 + 发丝线 + 条数。 */}
          <div className="flex items-center gap-2 pb-1.5">
            <span aria-hidden className="notify-skel shimmer block size-5 shrink-0 rounded-md" />
            <Bar w={72} h={11} />
            <span aria-hidden className="h-px flex-1 bg-ink-border-soft" />
            <Bar w={24} h={9} className="shrink-0 opacity-70" />
          </div>
          {Array.from({ length: SKELETON_ROWS_PER_GROUP }, (_ignored, rowIndex) => {
            const bars = ROW_BAR_WIDTHS[rowIndex % ROW_BAR_WIDTHS.length]!
            return (
              <div
                key={`today-skel-row-${groupIndex}-${rowIndex}`}
                // 内边距 / 间距 / 分隔线与 `TodayItemRow` 同：px-3 py-2.5 + gap-2.5 + 底 hairline。
                className={cn(
                  'flex items-start gap-2.5 px-3 py-2.5',
                  'border-b border-[var(--hairline)] last:border-b-0'
                )}
              >
                <span
                  aria-hidden
                  className="notify-skel shimmer mt-px block size-[26px] shrink-0 rounded-lg"
                />
                {/* 高度由**行盒**占住、不由骨架条决定：h-5 / mt-0.5 + h-4 逐字对上真实行的
                    text-aux(行高 20) 与 text-meta(行高 16, mt-0.5)。 */}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex h-5 items-center justify-between gap-2">
                    <Bar w={bars.title} h={11} />
                    <Bar w={bars.time} h={9} className="shrink-0 opacity-70" />
                  </span>
                  <span className="mt-0.5 flex h-4 items-center">
                    <Bar w={bars.triage} h={9} className="opacity-70" />
                  </span>
                </span>
                {/* 真实行尾部的 `⋯` 槽（hover 才显形，但**恒占宽**）。 */}
                <span aria-hidden className="-mr-1 size-6 shrink-0" />
              </div>
            )
          })}
        </section>
      ))}
    </div>
  )
}
