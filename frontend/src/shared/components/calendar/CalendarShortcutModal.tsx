// mockup-calendar.html §shortcut help modal — sk-backdrop + sk-modal
// (glass-pop 420px) + 多 sk-row (label / keys). Esc 关闭由 useCalendar-
// Shortcuts hook 统一调 onEsc -> setOpen(false) 触发.

import { useTranslation } from 'react-i18next'

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
  { labelKey: 'calendar.shortcut.prevNext', labelFallback: '上一段 / 下一段', keys: ['←', '→'] },
  { labelKey: 'calendar.shortcut.today', labelFallback: '跳到今天', keys: ['T'] },
  { labelKey: 'calendar.shortcut.sync', labelFallback: '同步', keys: ['⌘', 'R'] },
  { labelKey: 'calendar.shortcut.close', labelFallback: '关闭抽屉 / 弹层', keys: ['Esc'] },
  { labelKey: 'calendar.shortcut.help', labelFallback: '打开 / 关闭本帮助', keys: ['?'] }
]

export function CalendarShortcutModal({ open, onClose }: Props): React.ReactElement | null {
  const { t } = useTranslation()
  if (!open) return null
  return (
    <div className="sk-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="sk-modal glass-pop" onClick={(e) => e.stopPropagation()}>
        <h3>{t('calendar.shortcut.title', '键盘快捷键')}</h3>
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
