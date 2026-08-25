// Phase 2.5 §11.2 — Undo toast stack (1:1 mockup-calendar-ops §undo).
//
// 屏幕底部居中 stack, 每个 toast = glass-pop + 30px 圆 icon 区 + 多行文本 +
// [撤销] 按钮 + 底部 2.5px 进度条 (rAF 跑 scaleX 1→0 over durationMs linear).
//
// 跟普通 Toast (top-right 通用 toast store) 平行: 数据走 calendar-undo 独立
// store. CalendarLayout 内 mount 一次. fixed 定位脱离 layout flow, 无需嵌
// PageFrame 的 scroll container.

import { useRef } from 'react'
import { CalendarClock, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { DUR, gsap, useGSAP } from '@shared/lib/gsap'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { useUndoToastStore, type UndoEntry } from '@shared/state/calendar-undo'

export function UndoToastStack(): React.ReactElement | null {
  const { t } = useTranslation()
  const items = useUndoToastStore((s) => s.items)
  const undo = useUndoToastStore((s) => s.undo)
  if (items.length === 0) return null
  return (
    <div
      className="undo-stack"
      aria-live="polite"
      aria-label={t('calendar.undo.aria', '待撤销操作')}
    >
      {items.map((item) => (
        <UndoToast key={item.id} item={item} onUndo={() => undo(item.id)} />
      ))}
    </div>
  )
}

function UndoToast({ item, onUndo }: { item: UndoEntry; onUndo: () => void }): React.ReactElement {
  const { t } = useTranslation()
  const rootRef = useRef<HTMLDivElement>(null)
  const progRef = useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion()
  useGSAP(
    () => {
      // 进场: y:14→0 + scale:0.98→1 + autoAlpha(DUR.base)。reduced-motion 跳过。
      if (!reduceMotion && rootRef.current) {
        gsap.from(rootRef.current, { autoAlpha: 0, y: 14, scale: 0.98, duration: DUR.base })
      }
      // 进度条倒计时: scaleX 1→0 over durationMs，linear。点撤销/超时 → 组件
      // unmount，useGSAP scope 自动 revert kill 此 tween（替代旧 .kill()）。是功能性
      // 计时指示而非 UI 装饰，故 reduced-motion 下仍保留（与原行为一致）。
      if (progRef.current) {
        gsap.fromTo(
          progRef.current,
          { scaleX: 1 },
          { scaleX: 0, duration: item.durationMs / 1000, ease: 'none' }
        )
      }
    },
    { scope: rootRef, dependencies: [item.id, item.durationMs, reduceMotion] }
  )

  return (
    <div ref={rootRef} className="undo-toast glass-pop" role="status">
      <span className="undo-ic" aria-hidden>
        {item.kind === 'reschedule' ? (
          <CalendarClock size={15} strokeWidth={2} />
        ) : (
          <Trash2 size={15} strokeWidth={2} />
        )}
      </span>
      <div className="undo-txt">
        <div className="undo-t1">{item.title}</div>
        {item.subtitle && <div className="undo-t2">{item.subtitle}</div>}
      </div>
      <button type="button" className="undo-btn" onClick={onUndo}>
        {t('calendar.undo.undo', '撤销')}
      </button>
      <div ref={progRef} className="undo-prog" aria-hidden />
    </div>
  )
}
