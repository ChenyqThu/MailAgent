// 通知面板加载骨架屏。做法与措辞全部照 `contacts/ContactSkeleton.tsx` / `matters/
// MatterSkeleton.tsx` —— 同一套材质语言、同一条「几何对不上就是白闪一下再跳版」的纪律，
// 只是把行几何换成 `NotificationPanel::NotificationRow` 的。
//
// 🔴 骨架只吃**列表体**：头部（标题 / 未读 chip / 全部已读）与 tab 行在数据到达前就能用，
// 做成骨架等于把可用的东西藏起来。
//
// 🔴 动效纯 CSS：复用 index.css 已有的 `.shimmer`（`agents-shimmer` keyframes，
// background-position 位移，无 JS、无 rAF）。`prefers-reduced-motion` 的关停挂在本模块自己的
// `.notify-skel` 上，**不动全局 `.shimmer`**（那个类另有十几处消费方，本批无权替它们改行为）。
//
// 行数固定 4（不量可视高度）：面板是 380px 宽的定高浮层，列表体 `max-h-[420px]`，不像通讯录/
// 事项那样铺满整屏 —— 4 行（4×59 ≈ 236px）与空态的 `min-h-[180px]` 同量级，加载→空态/有数据
// 之间面板不会大跳。

import { cn } from '@shared/lib/cn'

/** 骨架行数。见文件头注：贴着空态的 min-h，不是「随手取个 8」。 */
const SKELETON_ROW_COUNT = 4

/** 行内条宽循环表。🔴 固定表而不是 `Math.random()` —— render 期调随机数既违反纯度，也会让
 *  每次重渲染条宽跳动，把「安静地占位」变成「一屏抖动」（ContactSkeleton 同款裁量）。 */
const ROW_BAR_WIDTHS: ReadonlyArray<{ title: number; time: number; body: number }> = [
  { title: 132, time: 34, body: 196 },
  { title: 108, time: 28, body: 164 },
  { title: 156, time: 38, body: 212 },
  { title: 120, time: 30, body: 180 }
]

/** 一根骨架条。圆角固定 4 —— 骨架条不是控件，不占 v3 四档圆角的语义位（同 ContactSkeleton）。 */
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

export function NotificationListSkeleton(): React.ReactElement {
  return (
    <div aria-hidden data-testid="notification-list-skeleton">
      {Array.from({ length: SKELETON_ROW_COUNT }, (_unused, index) => {
        const bars = ROW_BAR_WIDTHS[index % ROW_BAR_WIDTHS.length]!
        return (
          <div
            key={`notify-skel-row-${index}`}
            // 内边距 / 间距 / 分隔线与 `NotificationRow` 同：px-4 py-2.5 + gap-2.5 + 底 hairline。
            className={cn(
              'flex items-start gap-2.5 px-4 py-2.5',
              'border-b border-[var(--hairline)] last:border-b-0'
            )}
          >
            {/* 图标槽与真实行同尺寸同圆角（26px / rounded-lg），不是正圆。 */}
            <span
              aria-hidden
              className="notify-skel shimmer mt-px block size-[26px] shrink-0 rounded-lg"
            />
            {/* 🔴 高度由**行盒**占住、不由骨架条决定：h-5 / mt-0.5 + h-4 逐字对上真实行的
                text-aux(行高 20) 与 text-meta(行高 16, mt-0.5)。合计 10+20+2+16+10 = 58px，
                正是一条「标题 + 一行摘要」的真实行高 —— 数据到达时不跳版。 */}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex h-5 items-center justify-between gap-2">
                <Bar w={bars.title} h={11} />
                <Bar w={bars.time} h={9} className="shrink-0 opacity-70" />
              </span>
              <span className="mt-0.5 flex h-4 items-center">
                <Bar w={bars.body} h={9} className="opacity-70" />
              </span>
            </span>
            {/* 真实行尾部的 `⋯` 槽（hover 才显形，但**恒占宽**）。这里空着只占位 —— 少了它，
                时间条会比真实时间戳右出 ~26px，数据到达时右缘整体挪一下。 */}
            <span aria-hidden className="-mr-1 size-6 shrink-0" />
          </div>
        )
      })}
    </div>
  )
}
