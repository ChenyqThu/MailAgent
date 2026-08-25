// Lane C (#5) — 日/周 timeline 的 px ↔ 时间换算单源 + 拖拽落点求解。
//
// 此前 HOUR_PX=48 在 WeekView / DayView 各写一遍; 拖拽会引入第三、第四处换算
// (预览位移与提交时间), 所以先把换算收敛到这里: 预览 px 与提交 ISO 都由同一个
// computeDragResult 产出, 结构上不可能出现「看到的落点」与「发出去的时间」不一致。
//
// 交互参数按批次 PRD 取值 (4px 起手阈值 / 15min 吸附 / 最短 15min)。
// 吸附是**绝对网格**吸附 (结果时刻落在 :00/:15/:30/:45), 不是增量吸附 —— 与
// 系统日历一致, 顺带把 10:07 这类历史脏时间在拖动时清干净。

export const HOUR_PX = 48
export const SNAP_MINUTES = 15
/** 指针纵向位移超过它才算真拖拽 (以下都当点击, 照常开抽屉)。 */
export const DRAG_THRESHOLD_PX = 4
/** 拖拽能把事件压到的最短时长。 */
export const MIN_EVENT_MINUTES = 15

const MINUTES_PER_DAY = 1440
const MS_PER_MINUTE = 60_000
const SNAP_MS = SNAP_MINUTES * MS_PER_MINUTE

export function minutesToPx(minutes: number): number {
  return (minutes / 60) * HOUR_PX
}

export function pxToMinutes(px: number): number {
  return (px / HOUR_PX) * 60
}

/** 吸附到 15 分钟网格。
 *  直接对 epoch 取模即可对齐本地时钟网格 —— 现实里的时区偏移 (含 +5:45 /
 *  +12:45 / Lord Howe 的半小时 DST) 全是 15 分钟的整数倍。 */
export function snapMsToGrid(ms: number): number {
  return Math.round(ms / SNAP_MS) * SNAP_MS
}

export type DragMode = 'move' | 'resize'

export interface DragInput {
  mode: DragMode
  /** 拖拽起手时块的起止 (毫秒)。 */
  startMs: number
  endMs: number
  /** 块顶相对当日 00:00 的 px 偏移 —— 用它还原当日边界, 拖拽不跨日。 */
  topPx: number
  /** 指针纵向位移 px (调用方已把容器 scrollTop 变化并进来)。 */
  dyPx: number
}

export interface DragResult {
  startMs: number
  endMs: number
  /** false = 吸附后落回原位, 不必提交。 */
  changed: boolean
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

/** 拖拽落点求解: move 平移整块, resize 只动结束时间。
 *  clamp 区间恒包含原位置 —— 跨午夜等本来就在当日窗口外的块允许「不动」,
 *  但不许被拖得更出界。 */
export function computeDragResult({ mode, startMs, endMs, topPx, dyPx }: DragInput): DragResult {
  const dayStartMs = startMs - Math.round(pxToMinutes(topPx)) * MS_PER_MINUTE
  const dayEndMs = dayStartMs + MINUTES_PER_DAY * MS_PER_MINUTE
  const dyMs = pxToMinutes(dyPx) * MS_PER_MINUTE

  if (mode === 'move') {
    const durationMs = endMs - startMs
    const lo = Math.min(dayStartMs, startMs)
    const hi = Math.max(dayEndMs - durationMs, startMs)
    const nextStart = clamp(snapMsToGrid(startMs + dyMs), lo, hi)
    return {
      startMs: nextStart,
      endMs: nextStart + durationMs,
      changed: nextStart !== startMs
    }
  }

  const lo = Math.min(startMs + MIN_EVENT_MINUTES * MS_PER_MINUTE, endMs)
  const hi = Math.max(dayEndMs, endMs)
  const nextEnd = clamp(snapMsToGrid(endMs + dyMs), lo, hi)
  return { startMs, endMs: nextEnd, changed: nextEnd !== endMs }
}
