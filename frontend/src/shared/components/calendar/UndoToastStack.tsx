// Phase 2.5 §11.2 — Undo toast stack (1:1 mockup-calendar-ops §undo).
//
// 屏幕底部居中 stack, 每个 toast = glass-pop + 30px 圆 icon 区 + 多行文本 +
// [撤销] 按钮 + 底部 2.5px 进度条 (rAF 跑 scaleX 1→0 over durationMs linear).
//
// 跟普通 Toast (top-right 通用 toast store) 平行: 数据走 calendar-undo 独立
// store. CalendarLayout 内 mount 一次. fixed 定位脱离 layout flow, 无需嵌
// PageFrame 的 scroll container.

import { useEffect, useRef } from 'react'
import { Trash2 } from 'lucide-react'

import { useUndoToastStore, type UndoEntry } from '@shared/state/calendar-undo'

export function UndoToastStack(): React.ReactElement | null {
  const items = useUndoToastStore((s) => s.items)
  const undo = useUndoToastStore((s) => s.undo)
  if (items.length === 0) return null
  return (
    <div className="undo-stack" aria-live="polite" aria-label="待撤销操作">
      {items.map((item) => (
        <UndoToast key={item.id} item={item} onUndo={() => undo(item.id)} />
      ))}
    </div>
  )
}

function UndoToast({
  item,
  onUndo
}: {
  item: UndoEntry
  onUndo: () => void
}): React.ReactElement {
  const progRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = progRef.current
    if (!el) return
    // 立即设回 scaleX(1), 强制 reflow, 再 set scaleX(0) 让 transition 生效.
    // (mockup §undo requestAnimationFrame 思路).
    el.style.transition = 'none'
    el.style.transform = 'scaleX(1)'
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    el.offsetWidth // force reflow
    el.style.transition = `transform ${item.durationMs}ms linear`
    el.style.transform = 'scaleX(0)'
  }, [item.durationMs])

  return (
    <div className="undo-toast glass-pop" role="status">
      <span className="undo-ic" aria-hidden>
        <Trash2 size={15} strokeWidth={2} />
      </span>
      <div className="undo-txt">
        <div className="undo-t1">{item.title}</div>
        {item.subtitle && <div className="undo-t2">{item.subtitle}</div>}
      </div>
      <button type="button" className="undo-btn" onClick={onUndo}>
        撤销
      </button>
      <div ref={progRef} className="undo-prog" aria-hidden />
    </div>
  )
}
