// Sprint 18 §PR E — floating "unsaved changes" pill scaffold.
//
// Sprint 18 commits on blur (every EnvField writes env:set as the user
// leaves the input), so we never accumulate "dirty" state between fields.
// The batch-save flow this component encodes is scoped for Sprint 19+
// where Tab-level save lets the user revert / apply multiple changes as
// one. The file lives now so the design contract is stable: anyone
// reaching for a save-bar UX in Settings should mount THIS component
// instead of inventing a new pill style.
//
// 视觉:fixed bottom-[var(--save-bar-bottom)] glass-pop 居中 — mockup-
// settings.html line 826-834 same pattern. Not mounted from
// SettingsShell yet; flip the export to default-mounted when Sprint 19
// hands off batch-save semantics.

import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@shared/components/ui/button'
import { cn } from '@shared/lib/cn'

export interface UnsavedBarProps {
  /** Number of pending changes — drives the count badge. */
  count: number
  /** Save callback; the parent owns the actual flush mechanic. */
  onSave: () => void | Promise<void>
  /** Discard callback; revert pending changes back to .env values. */
  onDiscard: () => void
  /** Disable both buttons (e.g. while a parent save is in-flight). */
  busy?: boolean
}

export function UnsavedBar({
  count,
  onSave,
  onDiscard,
  busy = false
}: UnsavedBarProps): React.ReactElement | null {
  const { t } = useTranslation()
  if (count === 0) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'fixed left-1/2 -translate-x-1/2 z-40',
        // 主题 v3 C8/批 4: glass-pop 浮动操作条 rounded-lg(8) → --r-pop(14)
        'glass-pop flex items-center gap-3 px-4 py-2.5 rounded-[var(--r-pop)]'
      )}
      style={{ bottom: 'var(--save-bar-bottom, 2rem)' }}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-coral/100" aria-hidden="true" />
      <span className="text-aux text-ink-fg">
        {t('settings.unsavedBar.message', {
          defaultValue: `有未保存的更改 · ${count} 项`,
          count
        })}
      </span>
      <span className="w-px h-4 bg-ink-border-soft" aria-hidden="true" />
      <Button variant="ghost" size="sm" onClick={onDiscard} disabled={busy}>
        {t('settings.unsavedBar.discard', { defaultValue: '放弃' })}
      </Button>
      <Button size="sm" onClick={() => void onSave()} disabled={busy}>
        {t('settings.unsavedBar.save', { defaultValue: '保存' })}
      </Button>
    </div>
  )
}
