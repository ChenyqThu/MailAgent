// F23/S7 — Week/Day 结构化加载骨架.
//
// 替代通用 Skeleton 灰条: 复用 .cal-week 的真实网格结构 (表头 + hour-gutter
// + 日列), 加载→内容的形态跳变最小. 纯 CSS 骨架 (bone 走 tailwind pulse,
// 同 MonthView 网格骨架惯例; ghost 事件块 = index.css .cal-skel-evt).
//
// 只画 12 行小时格 (非 24h + scroll): 骨架不承载真实时刻, 12×48px 已填满
// 常规视口高度, 免去 scroll-to-8AM 的空夜区.

import { cn } from '@shared/lib/cn'

interface Props {
  /** 7 = WeekView, 1 = DayView 主 timeline. */
  cols: 7 | 1
}

const SKELETON_HOURS = 12
const PULSE = 'animate-pulse motion-reduce:animate-none'

/** ghost 事件块位形 — 确定性伪随机 (列索引取模), 无渲染间抖动. */
function ghostBlocks(col: number): Array<{ top: number; height: number }> {
  const blocks = [{ top: ((col * 5) % 7) * 48 + 56, height: 76 }]
  if (col % 2 === 0) {
    blocks.push({ top: blocks[0].top + 172, height: 52 })
  }
  return blocks
}

export function TimelineSkeleton({ cols }: Props): React.ReactElement {
  const gridCols = cols === 7 ? '56px repeat(7, 1fr)' : '56px 1fr'
  return (
    <div className="cal-week" aria-busy="true">
      <div className="wk-headrow" style={{ gridTemplateColumns: gridCols }}>
        <div className="wk-corner" />
        {Array.from({ length: cols }, (_, i) => (
          <div key={i} className="wk-dayhead">
            <span className={cn('block h-2.5 w-8 mx-auto rounded bg-ink-3', PULSE)} />
            <span className={cn('block h-4 w-5 mx-auto mt-1.5 rounded bg-ink-3', PULSE)} />
          </div>
        ))}
      </div>
      {/* scrollbar-thin 与真实视图一致 — wk-body 的 scrollbar-gutter 预留
          宽度相同, 骨架→内容切换时列基准不漂移 (F2 invariant). */}
      <div className="wk-body scrollbar-thin">
        <div className="wk-grid" style={{ gridTemplateColumns: gridCols }}>
          <div className="hour-gutter">
            {Array.from({ length: SKELETON_HOURS }, (_, h) => (
              <div key={h} className="hour-label">
                <span>
                  <span className={cn('inline-block h-2 w-8 rounded bg-ink-3', PULSE)} />
                </span>
              </div>
            ))}
          </div>
          {Array.from({ length: cols }, (_, c) => (
            <div key={c} className="day-col">
              {Array.from({ length: SKELETON_HOURS }, (_, h) => (
                <div key={h} className="hour-cell" />
              ))}
              {ghostBlocks(c).map((b, bi) => (
                <span
                  key={bi}
                  className={cn('cal-skel-evt', PULSE)}
                  style={{ top: b.top, height: b.height }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
