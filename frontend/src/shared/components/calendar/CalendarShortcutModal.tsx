// mockup-calendar.html §shortcut help modal — sk-backdrop + sk-modal
// (glass-pop 420px) + 多 sk-row (label / keys). Esc 关闭由 useCalendar-
// Shortcuts hook 统一调 onEsc -> setOpen(false) 触发.
//
// 阶段1·1.9 (F7/Q12) — 接 useExitAnimation (关闭有退场动画, 原 if(!open)
// return null 同步卸载) + useFocusTrap (照 KeyboardHelpModal 同一工具);
// 焦点在模态内时 Esc 就地关闭 + stopPropagation, 焦点逃逸时仍有
// useCalendarShortcuts 的 window listener 兜底 (onEsc), 两路一致.

import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useFocusTrap } from '@shared/hooks/useFocusTrap'

interface Props {
  open: boolean
  onClose: () => void
}

interface RowData {
  labelKey: string
  labelFallback: string
  keys: string[]
}

const ROWS: RowData[] = [
  { labelKey: 'calendar.shortcut.dayView', labelFallback: '日视图', keys: ['G', 'D'] },
  { labelKey: 'calendar.shortcut.weekView', labelFallback: '周视图', keys: ['G', 'W'] },
  { labelKey: 'calendar.shortcut.monthView', labelFallback: '月视图', keys: ['G', 'M'] },
  { labelKey: 'calendar.shortcut.agendaView', labelFallback: 'Agenda 视图', keys: ['G', 'A'] },
  // 阶段1·1.9 (F18/Q12) — recurring 视图此前无键达
  { labelKey: 'calendar.shortcut.recurringView', labelFallback: '定期邀请视图', keys: ['G', 'R'] },
  { labelKey: 'calendar.shortcut.prevNext', labelFallback: '上一段 / 下一段', keys: ['←', '→'] },
  { labelKey: 'calendar.shortcut.today', labelFallback: '跳到今天', keys: ['T'] },
  { labelKey: 'calendar.shortcut.sync', labelFallback: '同步', keys: ['⌘', 'R'] },
  { labelKey: 'calendar.shortcut.close', labelFallback: '关闭抽屉 / 弹层', keys: ['Esc'] },
  { labelKey: 'calendar.shortcut.help', labelFallback: '打开 / 关闭本帮助', keys: ['?'] }
]

export function CalendarShortcutModal({ open, onClose }: Props): React.ReactElement | null {
  const { t } = useTranslation()
  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, { card: '.sk-modal' })
  const { dialogRef, handleTab } = useFocusTrap({ open, fallbackRef: scopeRef })

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    handleTab(e)
  }

  if (!shouldRender) return null
  return (
    <div
      ref={scopeRef}
      className="sk-backdrop"
      onClick={onClose}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cal-sk-title"
    >
      <div ref={dialogRef} className="sk-modal glass-pop" onClick={(e) => e.stopPropagation()}>
        <div className="cal-sk-head">
          <h3 id="cal-sk-title">{t('calendar.shortcut.title', '键盘快捷键')}</h3>
          <button
            type="button"
            className="cal-sk-close"
            onClick={onClose}
            aria-label={t('calendar.shared.closeAria', '关闭')}
            title={t('calendar.shared.close', '关闭 (Esc)')}
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>
        <div className="sk-sub">
          {t('calendar.shortcut.subtitle', 'G 开头为视图跳转 (先按 G 再按视图键, 800ms 内有效)')}
        </div>
        {ROWS.map((r) => (
          <div key={r.labelKey} className="sk-row">
            <span className="sk-label">{t(r.labelKey, r.labelFallback)}</span>
            <span className="sk-keys">
              {r.keys.map((k, i) => (
                <kbd key={i} className="kbd">
                  {k}
                </kbd>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
