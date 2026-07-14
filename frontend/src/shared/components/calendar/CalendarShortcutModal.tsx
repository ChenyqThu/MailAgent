// mockup-calendar.html §shortcut help modal — sk-backdrop + sk-modal
// (glass-pop 420px) + 多 sk-row (label / keys). Esc 关闭由 useCalendar-
// Shortcuts hook 统一调 onEsc -> setOpen(false) 触发.
//
// 阶段1·1.9 (F7/Q12) — 接 useExitAnimation (关闭有退场动画, 原 if(!open)
// return null 同步卸载) + useFocusTrap (照 KeyboardHelpModal 同一工具);
// 焦点在模态内时 Esc 就地关闭 + stopPropagation, 焦点逃逸时仍有
// useCalendarShortcuts 的 window listener 兜底 (onEsc), 两路一致.
//
// 阶段2·2.7 (ux-benchmark §五-5) — 行数据从 keymap.ts 'calendar' scope 派生
// (统一登记面, 不再本地维护 ROWS); display 按空格分段渲染成多枚 kbd
// ("G D" → [G][D]).

import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useFocusTrap } from '@shared/hooks/useFocusTrap'
import { SHORTCUTS } from '@shared/keymap'

interface Props {
  open: boolean
  onClose: () => void
}

const CAL_ROWS = SHORTCUTS.filter((s) => s.scope === 'calendar')

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
        {CAL_ROWS.map((r) => (
          <div key={r.id} className="sk-row">
            <span className="sk-label">{t(r.labelKey)}</span>
            <span className="sk-keys">
              {r.display.split(' ').map((k, i) => (
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
