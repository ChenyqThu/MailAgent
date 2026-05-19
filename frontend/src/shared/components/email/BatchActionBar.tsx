// Sprint 12 — floating batch action bar per mockup-inbox.html lines 2547-2596.
// Portaled to document.body so it can use position:fixed without inheriting
// the inbox layout's stacking context (the nav + status bar sit on z-40, so
// the bar's z-40 keeps it above content + below modal overlays).
//
// Visibility is gated entirely on `batch.mode === 'on'` — the bar stays
// mounted (with .hidden class for the fade-out CSS) once the user has
// entered batch mode, even if selection drops to 0. Esc exits.

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { Archive, CheckCircle2, Flag, Mail, X } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useBatch } from '@shared/state/batch'
import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError, toastSuccess } from '@shared/state/toast'

interface Props {
  /** Live ids on the current view — feeds "select all N" and clamps clears. */
  visibleIds: ReadonlyArray<number>
}

export function BatchActionBar({ visibleIds }: Props): React.ReactElement | null {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const queryClient = useQueryClient()

  const mode = useBatch((s) => s.mode)
  const exit = useBatch((s) => s.exit)
  const clear = useBatch((s) => s.clear)
  const selectAll = useBatch((s) => s.selectAll)
  const selectedIds = useBatch((s) => s.selectedIds)

  // Esc exits batch mode entirely (mockup contract).
  useEffect(() => {
    if (mode === 'off') return
    function onKey(ev: KeyboardEvent): void {
      if (ev.key === 'Escape') {
        ev.preventDefault()
        exit()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [mode, exit])

  if (mode === 'off' || typeof document === 'undefined') return null

  const selected = selectedIds.length
  const empty = selected === 0
  const total = visibleIds.length

  async function runBulk(label: string, op: (id: number) => Promise<unknown>): Promise<void> {
    if (selectedIds.length === 0) return
    const ids = [...selectedIds]
    let ok = 0
    let failed = 0
    // Run in parallel — single-row notion.updateFlag calls are cheap.
    // Each rejection lands in `failed`; we report the aggregate.
    await Promise.all(
      ids.map((id) =>
        op(id).then(
          () => {
            ok += 1
          },
          () => {
            failed += 1
          }
        )
      )
    )
    if (failed === 0) {
      toastSuccess(`${label}: ${ok} 封完成`)
    } else if (ok === 0) {
      toastError(`${label} 失败`, `${failed} 封失败`)
    } else {
      toastError(`${label}: ${ok}/${ids.length}`, `${failed} 封失败`)
    }
    await queryClient.invalidateQueries({ queryKey: ['emails'] })
  }

  return createPortal(
    <div
      id="batch-bar"
      className={cn('floating flex items-center gap-2 whitespace-nowrap', empty && 'batch-empty')}
      role="toolbar"
      aria-label={t('batchbar.aria')}
    >
      <div className="flex items-center gap-2">
        <span className="w-7 h-7 rounded-md bg-coral/15 border border-coral/30 grid place-items-center">
          <span className="text-meta font-mono font-semibold text-coral tabular-nums">
            {selected}
          </span>
        </span>
        <span className="text-aux text-ink-fg">{t('batchbar.selection', { n: selected })}</span>
        <button
          type="button"
          className="text-aux text-ink-fg-2 hover:text-ink-fg transition-colors duration-fast px-1"
          onClick={() => selectAll(visibleIds)}
        >
          {t('batchbar.selectAll', { n: total })}
        </button>
        <button
          type="button"
          className="text-aux text-ink-fg-2 hover:text-ink-fg transition-colors duration-fast px-1"
          onClick={() => clear()}
        >
          {t('batchbar.clear')}
        </button>
      </div>

      <div className="w-px h-5 bg-ink-border mx-1" />

      <button
        type="button"
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-aux text-ink-fg-1 hover:text-ink-fg hover:bg-ink-3 transition-colors duration-fast"
        onClick={() =>
          void runBulk(t('batchbar.markRead'), (id) =>
            mailApi.notion.updateFlag(id, { isRead: true })
          )
        }
      >
        <Mail size={13} strokeWidth={2} />
        <span>{t('batchbar.markRead')}</span>
      </button>
      <button
        type="button"
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-aux text-ink-fg-1 hover:text-ink-fg hover:bg-ink-3 transition-colors duration-fast"
        onClick={() =>
          void runBulk(t('batchbar.toggleFlag'), (id) =>
            mailApi.notion.updateFlag(id, { isFlagged: true })
          )
        }
      >
        <Flag size={13} strokeWidth={2} />
        <span>{t('batchbar.toggleFlag')}</span>
      </button>
      <button
        type="button"
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-aux text-ink-fg-1 hover:text-ink-fg hover:bg-ink-3 transition-colors duration-fast"
        onClick={() =>
          void runBulk(t('batchbar.markDone'), (id) =>
            mailApi.notion.updateFlag(id, {
              isFlagged: false,
              processingStatus: '已完成'
            })
          )
        }
      >
        <CheckCircle2 size={13} strokeWidth={2} />
        <span>{t('batchbar.markDone')}</span>
      </button>
      <button
        type="button"
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-aux text-ink-fg-1 hover:text-ink-fg hover:bg-ink-3 transition-colors duration-fast"
        onClick={() =>
          void runBulk(t('batchbar.archive'), (id) =>
            mailApi.notion.updateFlag(id, {
              isFlagged: false,
              processingStatus: '已完成'
            })
          )
        }
      >
        <Archive size={13} strokeWidth={2} />
        <span>{t('batchbar.archive')}</span>
      </button>

      <div className="w-px h-5 bg-ink-border mx-1 ml-auto" />

      <kbd>Esc</kbd>
      <button
        type="button"
        className="text-ink-fg-2 hover:text-ink-fg p-1.5 rounded transition-colors duration-fast hover:bg-ink-3 grid place-items-center"
        title={t('batchbar.exitTooltip')}
        aria-label={t('batchbar.exitTooltip')}
        onClick={() => exit()}
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>,
    document.body
  )
}
