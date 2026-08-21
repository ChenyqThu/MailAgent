// 事项页加载骨架屏（task 08-20 P0-2）。做法与措辞全部照通讯录的
// `contacts/ContactSkeleton.tsx` —— 同一套材质语言、同一条「几何对不上就是白闪一下再跳版」
// 的纪律，只是把行几何换成 `MatterList::MatterRow` 的。
//
// 🔴 骨架只吃**列表体 / 详情体 / 看板体**：头部 chrome（tab 条、搜索框、筛选按钮）在数据到
// 达前就能用，做成骨架等于把可用的东西藏起来（ContactSkeleton 的裁量 7 同款）。
//
// 🔴 动效纯 CSS：复用 index.css 已有的 `.shimmer`（`agents-shimmer` keyframes，
// background-position 位移，无 JS、无 rAF）。`prefers-reduced-motion` 的关停挂在本模块自己的
// `.matter-skel` 上，**不动全局 `.shimmer`**（那个类另有十几处消费方，本批无权替它们改行为）。
//
// 🔴 行数按可视高度算而不是固定值：高窗口下画 8 行会被读成「这个库只有 8 件事」。量不到高度
// （happy-dom / 首帧）时回落固定值。

import { useLayoutEffect, useRef, useState } from 'react'

import { cn } from '@shared/lib/cn'

import type { MatterTab } from './matterListQuery'

/**
 * 清单行的高度估值（px）。**两个消费方共用这一个数**，别在第二处手抄：
 *   1. 本文件的骨架行高 —— 骨架要跟真实行对齐，不然数据到达时会跳版；
 *   2. `MatterList` 虚拟列表的 `useDynamicRowHeight({ defaultRowHeight })` —— 行真实高度由
 *      ResizeObserver 量出来后覆盖，这个值只影响「还没量到的行」的滚动条长度与首帧窗口大小。
 *
 * 数值来源（`MatterRow` 的实际几何）：py-2.5(20) + border-b(1) + 行1(20) + mt-1.5(6) +
 * 行2(16) + mt-1.5(6) + 行3(22) ≈ 91；没有行 3 的两行行 ≈ 63。取中间的 80。
 */
export const MATTER_ROW_HEIGHT_ESTIMATE = 80

/** 量不到可视高度时的回落行数。 */
const FALLBACK_ROW_COUNT = 8

/** 行内条宽循环表（照 ContactSkeleton：固定表而不是 `Math.random()` —— render 期调随机数
 *  既违反纯度，也会让每次重渲染条宽跳动，把「安静地占位」变成「一屏抖动」）。 */
const ROW_BAR_WIDTHS: ReadonlyArray<{ title: number; next: number; type: number }> = [
  { title: 148, next: 176, type: 54 },
  { title: 112, next: 138, type: 68 },
  { title: 186, next: 152, type: 46 },
  { title: 132, next: 194, type: 62 },
  { title: 164, next: 124, type: 58 },
  { title: 120, next: 168, type: 72 },
  { title: 176, next: 146, type: 50 },
  { title: 140, next: 182, type: 64 }
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
      className={cn('matter-skel shimmer block rounded-[4px]', className)}
      style={{ width: w, height: h }}
    />
  )
}

/** 清单体骨架：行几何（px-4 / py-2.5 / border-b / 三行）与 `MatterRow` 同。 */
export function MatterListSkeleton(): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const [rowCount, setRowCount] = useState(FALLBACK_ROW_COUNT)

  // 形态照 ContactListSkeleton：layout effect 先量一次，再挂 ResizeObserver 跟着量；
  // happy-dom 没有 ResizeObserver → 只量那一次（回落值仍然可用）。
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const measure = (): void => {
      const height = host.clientHeight
      if (height > 0) setRowCount(Math.max(1, Math.ceil(height / MATTER_ROW_HEIGHT_ESTIMATE)))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return (): void => observer.disconnect()
  }, [])

  return (
    <div
      ref={hostRef}
      aria-hidden
      className="h-full min-h-0 overflow-hidden"
      data-testid="matter-list-skeleton"
    >
      {Array.from({ length: rowCount }, (_unused, index) => {
        const bars = ROW_BAR_WIDTHS[index % ROW_BAR_WIDTHS.length]!
        return (
          <div
            key={`matter-skel-row-${index}`}
            className="border-b border-ink-border px-4 py-2.5"
            style={{ height: MATTER_ROW_HEIGHT_ESTIMATE }}
          >
            {/* 行 1 —— 标题 + 编号 + 右端状态 chip 位。 */}
            <span className="flex items-center gap-2">
              <Bar w={bars.title} h={12} />
              <Bar w={44} h={9} className="opacity-70" />
              <span aria-hidden className="flex-1" />
              <Bar w={52} h={14} className="rounded-full opacity-70" />
            </span>
            {/* 行 2 —— 下一步 + 更新时间。 */}
            <span className="mt-1.5 flex items-center gap-2">
              <Bar w={bars.next} h={10} className="opacity-70" />
              <span aria-hidden className="flex-1" />
              <Bar w={30} h={9} className="opacity-70" />
            </span>
            {/* 行 3 —— 事项类型徽标位。 */}
            <span className="mt-1.5 flex items-center gap-2">
              <Bar w={bars.type} h={12} className="rounded-full opacity-70" />
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** 详情体骨架：头部（标题 / 元信息 / 状态 chip 行）+ tab 条位 + 正文两段。 */
export function MatterDetailSkeleton(): React.ReactElement {
  return (
    <div
      aria-hidden
      className="flex h-full min-h-0 flex-col overflow-hidden bg-ink-0/35"
      data-testid="matter-detail-skeleton"
    >
      <div className="shrink-0 border-b border-ink-border px-5 py-4">
        <div className="flex items-center gap-1.5">
          <Bar w={62} h={10} className="opacity-70" />
          <Bar w={78} h={10} className="opacity-70" />
        </div>
        <Bar w={286} h={19} className="mt-2" />
        <div className="mt-3 flex items-center gap-1.5">
          <Bar w={64} h={16} className="rounded-full opacity-70" />
          <Bar w={48} h={16} className="rounded-full opacity-70" />
          <Bar w={72} h={16} className="rounded-full opacity-70" />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-4 border-b border-ink-border px-5 py-2.5">
        {[0, 1, 2].map((index) => (
          <Bar key={`matter-skel-tab-${index}`} w={index === 0 ? 40 : 52} h={11} />
        ))}
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-hidden px-5 pt-4">
        <div className="space-y-2.5">
          <Bar w={72} h={11} />
          <Bar w="100%" h={10} className="opacity-70" />
          <Bar w="92%" h={10} className="opacity-70" />
          <Bar w="54%" h={10} className="opacity-70" />
        </div>
        <div className="space-y-2.5">
          <Bar w={88} h={11} />
          {[0, 1, 2].map((index) => (
            <span key={`matter-skel-item-${index}`} className="flex items-center gap-3">
              <Bar w={14} h={14} className="rounded-full opacity-70" />
              <Bar w="62%" h={10} />
              <span aria-hidden className="flex-1" />
              <Bar w={40} h={9} className="opacity-70" />
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

/** 看板体骨架：标题 + 四个 tile + 两段列表（几何跟随 `MatterFocus`）。 */
export function MatterBoardSkeleton(): React.ReactElement {
  return (
    <div aria-hidden className="h-full overflow-hidden p-5" data-testid="matter-board-skeleton">
      <div className="mx-auto max-w-[880px] space-y-5">
        <div className="space-y-2">
          <Bar w={132} h={22} />
          <Bar w={268} h={11} className="opacity-70" />
        </div>
        <div className="grid grid-cols-4 gap-3 max-[1000px]:grid-cols-2">
          {[0, 1, 2, 3].map((index) => (
            <div
              key={`matter-skel-tile-${index}`}
              className="rounded-[var(--r-card)] border border-ink-border bg-ink-1/75 p-4"
            >
              <div className="flex items-center justify-between">
                <Bar w={28} h={22} />
                <Bar w={17} h={17} className="rounded-full opacity-70" />
              </div>
              <Bar w={64} h={10} className="mt-2 opacity-70" />
            </div>
          ))}
        </div>
        {[0, 1].map((section) => (
          <div key={`matter-skel-section-${section}`}>
            <Bar w={96} h={10} className="mb-2 opacity-70" />
            <div className="divide-y divide-ink-border rounded-[var(--r-card)] border border-ink-border bg-ink-1/75">
              {[0, 1, 2].map((index) => (
                <div
                  key={`matter-skel-section-${section}-row-${index}`}
                  className="flex items-center gap-3 px-3 py-3"
                >
                  <Bar w={22} h={22} className="shrink-0 opacity-70" />
                  <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <Bar w={index === 1 ? '48%' : '64%'} h={11} />
                    <Bar w={132} h={9} className="opacity-70" />
                  </span>
                  <Bar w={56} h={14} className="rounded-full opacity-70" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * 整页骨架 —— `/chat/config` 还没回来（事项总闸未知）时用它顶住那一屏。
 *
 * 🔴 只在**未知**时出；确定「事项已禁用」时仍然渲染 null（骨架的意思是「马上就有内容」，
 * 对一个关掉的模块永远等不到，那是欺骗）。判据在 MattersWorkspace。
 */
export function MattersWorkspaceSkeleton({ tab }: { tab: MatterTab }): React.ReactElement {
  return (
    <div aria-hidden className="flex h-full min-h-0 flex-col" data-testid="matters-skeleton">
      {/* 42px 模块 tab 栏的占位（几何同 MattersWorkspace 的真实那条）。 */}
      <div className="flex h-[42px] shrink-0 items-center gap-3 border-b border-ink-border bg-ink-1/45 pl-4 pr-3">
        <Bar w={48} h={12} />
        <Bar w={48} h={12} className="opacity-70" />
        <span aria-hidden className="flex-1" />
        <Bar w={84} h={26} className="rounded-[var(--r-ctl)] opacity-70" />
      </div>
      <div className="min-h-0 flex-1">
        {tab === 'board' ? (
          <MatterBoardSkeleton />
        ) : (
          <div className="grid h-full min-h-0 grid-cols-[336px_6px_minmax(420px,1fr)] max-[880px]:grid-cols-1">
            <div className="min-h-0 bg-ink-1/55">
              <MatterListSkeleton />
            </div>
            <span aria-hidden />
            <div className="min-h-0 max-[880px]:hidden">
              <MatterDetailSkeleton />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
