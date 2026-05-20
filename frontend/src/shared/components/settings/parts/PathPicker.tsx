// Sprint 18 §PR F — folder-picker row backed by settings.json (NOT .env).
//
// dbPath / attachmentDir are persisted on the Electron side as JSON fields
// (`<userData>/settings.json`) because Python reads them from the env via
// SYNC_STORE_DB_PATH / ATTACHMENT_STORAGE_DIR but the renderer-side
// override path is settings.json (Sprint 8 db_settings_wire). PathPicker
// is the UI for those settings.json fields — env:set is NOT involved.
//
// Flow:
//   1. Click button → mailApi.settings.pickFolder() (native macOS dialog)
//   2. User confirms → IPC returns absolute path or null on cancel
//   3. mailApi.settings.set({ [key]: path }) persists settings.json
//   4. Refresh useEnvStore so subsequent renders see the new value (but
//      really this lives in settings store, not env store; the source-of-
//      truth for the rendered value is the result of api.settings.get())

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen, Loader2 } from 'lucide-react'

import { Button } from '@shared/components/ui/button'
import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { toastError, toastSuccess } from '@shared/state/toast'

import { Row } from './Row'

interface PathPickerProps {
  /** settings.json key name — must match `PersistentSettings` shape. */
  settingsKey: 'dbPath' | 'attachmentDir'
  label: React.ReactNode
  helper?: React.ReactNode
  /** Native picker dialog title; defaults to label if omitted. */
  pickerTitle?: string
  /** Success toast title; defaults to label. */
  savedToastTitle?: string
  /** Current value (read by caller via api.settings.get / cached); null
   *  means "default" — the picker shows a "default" hint in lieu of path. */
  currentPath: string | null
  /** Called after a successful settings:set so the caller can refresh
   *  its cached settings snapshot. */
  onPersisted: (next: string | null) => void
}

export function PathPicker({
  settingsKey,
  label,
  helper,
  pickerTitle,
  savedToastTitle,
  currentPath,
  onPersisted
}: PathPickerProps): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const [busy, setBusy] = React.useState(false)

  async function handlePick(): Promise<void> {
    setBusy(true)
    try {
      const picked = await api.settings.pickFolder(
        pickerTitle ?? (typeof label === 'string' ? label : settingsKey)
      )
      if (picked === null) return // user cancelled
      const next = await api.settings.set({ [settingsKey]: picked })
      onPersisted(next[settingsKey])
      toastSuccess(savedToastTitle ?? (typeof label === 'string' ? label : settingsKey), picked)
    } catch (err) {
      toastError(typeof label === 'string' ? label : settingsKey, (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Row label={label} helper={helper}>
      <div className="flex items-center gap-2">
        <div
          className={cn(
            'w-[260px] rounded-md bg-ink-3 border border-ink-border px-2.5 py-1.5',
            'text-aux text-ink-fg font-mono truncate'
          )}
          title={currentPath ?? t('settings.advanced.path.default', { defaultValue: '默认路径' })}
        >
          {currentPath ?? (
            <span className="text-ink-fg-3">
              {t('settings.advanced.path.default', { defaultValue: '默认路径' })}
            </span>
          )}
        </div>
        <Button onClick={() => void handlePick()} variant="outline" size="sm" disabled={busy}>
          {busy ? <Loader2 className="size-3 animate-spin" /> : <FolderOpen className="size-3" />}
          {t('settings.advanced.path.choose', { defaultValue: '选择…' })}
        </Button>
      </div>
    </Row>
  )
}
