// mockup-calendar.html §shortcut help modal — sk-backdrop + sk-modal
// (glass-pop 420px) + 多 sk-row (label / keys). Esc 关闭由 useCalendar-
// Shortcuts hook 统一调 onEsc -> setOpen(false) 触发.

interface Props {
  open: boolean
  onClose: () => void
}

interface RowData {
  label: string
  keys: string[]
}

const ROWS: RowData[] = [
  { label: '日视图', keys: ['G', 'D'] },
  { label: '周视图', keys: ['G', 'W'] },
  { label: '月视图', keys: ['G', 'M'] },
  { label: 'Agenda 视图', keys: ['G', 'A'] },
  { label: '上一段 / 下一段', keys: ['←', '→'] },
  { label: '跳到今天', keys: ['T'] },
  { label: '同步', keys: ['⌘', 'R'] },
  { label: '关闭抽屉 / 弹层', keys: ['Esc'] },
  { label: '打开 / 关闭本帮助', keys: ['?'] }
]

export function CalendarShortcutModal({ open, onClose }: Props): React.ReactElement | null {
  if (!open) return null
  return (
    <div className="sk-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="sk-modal glass-pop" onClick={(e) => e.stopPropagation()}>
        <h3>键盘快捷键</h3>
        <div className="sk-sub">G 开头为视图跳转 (先按 G 再按视图键, 800ms 内有效)</div>
        {ROWS.map((r) => (
          <div key={r.label} className="sk-row">
            <span className="sk-label">{r.label}</span>
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
