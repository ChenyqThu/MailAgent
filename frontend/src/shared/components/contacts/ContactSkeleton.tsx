// 通讯录加载骨架屏（v2 任务 ③；原型 `mockups/contact-agent-v2/skeleton.tsx`）。
//
// 骨架的作用是「先把版式占住」，几何对不上就是白闪一下再跳版，比不做还差。所以行高 / 内边距
// / 头像槽全部取真实实现的同一个来源：行高走 `rowHeightFor`（密度档跟着变），头像槽与
// `ContactRow::monogramSlot` 同表，左右内边距与 `ContactRow` 的 `px-2` + `pl-[13px] pr-3` 同。
//
// 🔴 头部 chrome（标题 / 搜索框 / Agent 胶囊 / 视图分段）**不做骨架**：那些在数据到达前就
// 能用，做成骨架等于把可用的东西藏起来（原型裁量 7）。骨架只吃列表体与详情体。
//
// 🔴 动效纯 CSS：复用 index.css 已有的 `.shimmer`（`agents-shimmer` keyframes，
// background-position 位移，无 JS、无 rAF）。列表性能铁律 —— 骨架屏出现的时刻正是主线程最忙
// 的时刻（数据还没来），这时候更不能再挂 rAF。
// 🔴 `prefers-reduced-motion` 关停挂在本模块自己的 `.contact-skel` 上，**不动全局 `.shimmer`**
// （那个类另有十几处消费方，本批无权替它们改行为）。
//
// 🔴 行数按可视高度算而不是固定 8（原型 NOTES 裁量 7 的落地提醒）：高窗口下画 8 行会被读成
// 「这个库只有 8 个人」。量不到高度（happy-dom / 首帧）时回落 8。

import { useLayoutEffect, useRef, useState } from 'react'

import { cn } from '@shared/lib/cn'

import { contactRowHeight, type ContactDensity } from './contactListModel'

/** 量不到可视高度时的回落行数（原型固定值）。 */
const FALLBACK_ROW_COUNT = 8

/** 行内条宽循环表（原型 `data.ts::SKELETON_ROWS`）。
 *  🔴 固定表而不是 `Math.random()`：render 期调随机数既违反纯度，也会让每次重渲染条宽跳动，
 *  把「安静地占位」变成「一屏抖动」。 */
const ROW_BAR_WIDTHS: ReadonlyArray<{ name: number; sub: number }> = [
  { name: 96, sub: 138 },
  { name: 72, sub: 116 },
  { name: 110, sub: 152 },
  { name: 84, sub: 128 },
  { name: 64, sub: 104 },
  { name: 102, sub: 146 },
  { name: 78, sub: 122 },
  { name: 92, sub: 134 }
]

/** 一根骨架条。圆角固定 4 —— 骨架条不是控件，不占 v3 四档圆角的语义位（原型同款裁量）。 */
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
      className={cn('contact-skel shimmer block rounded-[4px]', className)}
      style={{ width: w, height: h }}
    />
  )
}

export function ContactListSkeleton({
  density
}: {
  density: ContactDensity
}): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const [rowCount, setRowCount] = useState(FALLBACK_ROW_COUNT)
  const rowHeight = contactRowHeight(density)
  const monogramSlot = density === 'comfortable' ? 34 : 30

  // 形态照 `ComposerToolsMenu` 的量法：layout effect 先量一次，再挂 ResizeObserver 跟着量；
  // happy-dom 没有 ResizeObserver → 只量那一次（回落值仍然可用）。
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const measure = (): void => {
      const height = host.clientHeight
      if (height > 0) setRowCount(Math.max(1, Math.ceil(height / rowHeight)))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return (): void => observer.disconnect()
  }, [rowHeight])

  return (
    <div
      ref={hostRef}
      aria-hidden
      className="h-full min-h-0 overflow-hidden pt-1"
      data-testid="contact-list-skeleton"
    >
      {Array.from({ length: rowCount }, (_unused, index) => {
        const bars = ROW_BAR_WIDTHS[index % ROW_BAR_WIDTHS.length]!
        return (
          <div key={`contact-skel-row-${index}`} className="px-2" style={{ height: rowHeight }}>
            <div className="flex h-full items-center gap-2.5 pl-[13px] pr-3">
              {/* 头像槽是正圆 —— person 行占多数，骨架跟随多数形态。 */}
              <span
                aria-hidden
                className="contact-skel shimmer block shrink-0 rounded-full"
                style={{ width: monogramSlot, height: monogramSlot }}
              />
              <span className="flex min-w-0 flex-1 flex-col gap-[5px]">
                <Bar w={bars.name} h={11} />
                <Bar w={bars.sub} h={9} className="opacity-70" />
              </span>
              <span className="flex shrink-0 flex-col items-end gap-[3px]">
                <Bar w={26} h={9} className="opacity-70" />
                <Bar w={34} h={3} className="opacity-70" />
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function ContactDetailSkeleton(): React.ReactElement {
  return (
    <div
      aria-hidden
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-testid="contact-detail-skeleton"
    >
      {/* 头部块：大头像 + 名字条 + 一行 pip 位 + 三个统计位。 */}
      <div className="shrink-0 border-b border-ink-border px-5 pb-4 pt-5">
        <div className="flex items-center gap-3.5">
          <span
            aria-hidden
            className="contact-skel shimmer block shrink-0 rounded-full"
            style={{ width: 56, height: 56 }}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Bar w={168} h={17} />
            <Bar w={232} h={11} className="opacity-70" />
            <span className="flex items-center gap-1.5">
              <Bar w={54} h={14} className="rounded-full opacity-70" />
              <Bar w={68} h={14} className="rounded-full opacity-70" />
            </span>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-6">
          {[0, 1, 2].map((index) => (
            <span key={`contact-skel-stat-${index}`} className="flex flex-col gap-1.5">
              <Bar w={40} h={9} className="opacity-70" />
              <Bar w={62} h={13} />
            </span>
          ))}
        </div>
      </div>

      {/* 正文两段：一段画像摘要（长短不一的行），一段往来账本（等宽行）。 */}
      <div className="min-h-0 flex-1 space-y-5 overflow-hidden px-5 pt-4">
        <div className="space-y-2.5">
          <span className="flex items-center gap-2">
            <Bar w={64} h={11} />
            <span aria-hidden className="h-px flex-1 bg-ink-border-soft" />
          </span>
          <Bar w="100%" h={10} />
          <Bar w="94%" h={10} />
          <Bar w="88%" h={10} />
          <Bar w="46%" h={10} />
        </div>
        <div className="space-y-2.5">
          <span className="flex items-center gap-2">
            <Bar w={80} h={11} />
            <span aria-hidden className="h-px flex-1 bg-ink-border-soft" />
          </span>
          {[0, 1, 2, 3].map((index) => (
            <span key={`contact-skel-mail-${index}`} className="flex items-center gap-3">
              <Bar w={52} h={9} className="opacity-70" />
              <Bar w="60%" h={10} />
              <span aria-hidden className="flex-1" />
              <Bar w={34} h={9} className="opacity-70" />
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
