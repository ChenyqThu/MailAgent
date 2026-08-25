// Lane C (#5) — timeline px↔时间换算 + 拖拽落点求解纯函数层。
//
// 这层是「预览位移」与「提交时间」的共同上游, 断言集中在三件事:
//   ① 15min 绝对网格吸附 (不是增量吸附, 结果时刻落在 :00/:15/:30/:45);
//   ② 当日边界 clamp —— 拖不出 00:00 / 24:00, 但本来就出界的块允许原地不动;
//   ③ resize 只动结束时间且不短于 15min。

import { describe, expect, test } from 'vitest'

import {
  DRAG_THRESHOLD_PX,
  HOUR_PX,
  MIN_EVENT_MINUTES,
  SNAP_MINUTES,
  computeDragResult,
  minutesToPx,
  pxToMinutes,
  snapMsToGrid
} from '../../src/shared/components/calendar/lib/timeGrid'

/** 该本地日 00:00 的 epoch (拖拽 clamp 以本地日为界)。 */
function localDay(y: number, m: number, d: number): number {
  return new Date(y, m - 1, d).getTime()
}

const DAY = localDay(2026, 8, 24)
const MIN = 60_000

function at(minutesFromDayStart: number): number {
  return DAY + minutesFromDayStart * MIN
}

/** 视图侧的 topPx 公式 (WeekView/DayView 逐字同款)。 */
function topPxOf(startMs: number): number {
  return ((startMs - DAY) / 3_600_000) * HOUR_PX
}

describe('px ↔ minutes 换算', () => {
  test('参数与视图网格一致: 1h=48px, 15min 一格=12px, 起手阈值 4px 小于一格', () => {
    expect(minutesToPx(60)).toBe(HOUR_PX)
    expect(minutesToPx(SNAP_MINUTES)).toBe(12)
    expect(pxToMinutes(HOUR_PX)).toBe(60)
    expect(DRAG_THRESHOLD_PX).toBeLessThan(minutesToPx(SNAP_MINUTES))
  })
})

describe('snapMsToGrid', () => {
  test('就近吸附到 15 分钟网格', () => {
    expect(snapMsToGrid(at(7))).toBe(at(0))
    expect(snapMsToGrid(at(8))).toBe(at(15))
    expect(snapMsToGrid(at(23))).toBe(at(30))
    expect(snapMsToGrid(at(30))).toBe(at(30))
  })
})

describe('computeDragResult — move', () => {
  const startMs = at(10 * 60) // 10:00
  const endMs = at(11 * 60) // 11:00
  const topPx = topPxOf(startMs)

  test('下拖 26px (=32.5min) → 吸附到 +30min, 时长不变', () => {
    const r = computeDragResult({ mode: 'move', startMs, endMs, topPx, dyPx: 26 })
    expect(r.startMs).toBe(at(10 * 60 + 30))
    expect(r.endMs - r.startMs).toBe(endMs - startMs)
    expect(r.changed).toBe(true)
  })

  test('正落两格中线 (30px = 37.5min) → 就近吸附取靠后的一格', () => {
    const r = computeDragResult({ mode: 'move', startMs, endMs, topPx, dyPx: 30 })
    expect(r.startMs).toBe(at(10 * 60 + 45))
  })

  test('上拖 12px (=一格) → 提前 15min', () => {
    const r = computeDragResult({ mode: 'move', startMs, endMs, topPx, dyPx: -12 })
    expect(r.startMs).toBe(at(10 * 60 - 15))
    expect(r.changed).toBe(true)
  })

  test('位移不足半格 → 吸附回原位, changed=false (不提交)', () => {
    const r = computeDragResult({ mode: 'move', startMs, endMs, topPx, dyPx: 5 })
    expect(r.startMs).toBe(startMs)
    expect(r.changed).toBe(false)
  })

  test('off-grid 起点 (10:07) 被吸附到网格而非平移 7 分', () => {
    const odd = at(10 * 60 + 7)
    const r = computeDragResult({
      mode: 'move',
      startMs: odd,
      endMs: odd + 30 * MIN,
      topPx: topPxOf(odd),
      dyPx: 12
    })
    expect(r.startMs).toBe(at(10 * 60 + 15))
  })

  test('往上拖出头 → clamp 到当日 00:00', () => {
    const early = at(30)
    const r = computeDragResult({
      mode: 'move',
      startMs: early,
      endMs: early + 60 * MIN,
      topPx: topPxOf(early),
      dyPx: -400
    })
    expect(r.startMs).toBe(DAY)
  })

  test('往下拖出尾 → clamp 到当日 24:00 (末端对齐)', () => {
    const late = at(22 * 60)
    const r = computeDragResult({
      mode: 'move',
      startMs: late,
      endMs: late + 60 * MIN,
      topPx: topPxOf(late),
      dyPx: 400
    })
    expect(r.endMs).toBe(DAY + 24 * 60 * MIN)
    expect(r.startMs).toBe(DAY + 23 * 60 * MIN)
  })

  test('跨午夜块 (topPx 为负) 不被 clamp 强行推进当日, 允许原地不动', () => {
    const beforeMidnight = DAY - 30 * MIN
    const r = computeDragResult({
      mode: 'move',
      startMs: beforeMidnight,
      endMs: beforeMidnight + 90 * MIN,
      topPx: topPxOf(beforeMidnight),
      dyPx: -2
    })
    expect(r.startMs).toBe(beforeMidnight)
    expect(r.changed).toBe(false)
  })
})

describe('computeDragResult — resize', () => {
  const startMs = at(10 * 60)
  const endMs = at(11 * 60)
  const topPx = topPxOf(startMs)

  test('下拖只动结束时间', () => {
    const r = computeDragResult({ mode: 'resize', startMs, endMs, topPx, dyPx: 24 })
    expect(r.startMs).toBe(startMs)
    expect(r.endMs).toBe(at(11 * 60 + 30))
    expect(r.changed).toBe(true)
  })

  test('上拖压过头 → 保底 15min 时长', () => {
    const r = computeDragResult({ mode: 'resize', startMs, endMs, topPx, dyPx: -200 })
    expect(r.endMs - r.startMs).toBe(MIN_EVENT_MINUTES * MIN)
  })

  test('下拖越午夜 → clamp 到当日 24:00', () => {
    const late = at(23 * 60)
    const r = computeDragResult({
      mode: 'resize',
      startMs: late,
      endMs: late + 30 * MIN,
      topPx: topPxOf(late),
      dyPx: 400
    })
    expect(r.endMs).toBe(DAY + 24 * 60 * MIN)
  })
})
