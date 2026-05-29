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
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
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

  // 进出场：底部浮动条，进 y:16→0 + autoAlpha(DUR.base)，退反向(DUR.fast)。
  // 退场延迟卸载，index.css 已移除会瞬间隐藏的 display:none!important。
  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(mode !== 'off', {
    backdrop: false,
    from: { autoAlpha: 0, y: 16 }
  })

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

  if (!shouldRender || typeof document === 'undefined') return null

  const selected = selectedIds.length
  const empty = selected === 0
  const total = visibleIds.length

  // Sprint 15 D — replaced N×IPC fork loop with a single `email.flag(--ids)` call.
  // The CLI inserts N×2 outbox rows in one transaction; FanoutWorker on
  // mail-sync's side dispatches Mail.app + Notion async. Error aggregation
  // comes from the CLI's returned shape:
  //   {updated_ids: [...], not_found?: [...], outbox_entries: [...]}.
  async function runBulk(
    label: string,
    payload: { isRead?: boolean; isFlagged?: boolean; processingStatus?: string }
  ): Promise<void> {
    if (selectedIds.length === 0) return
    const ids = [...selectedIds]
    try {
      const result = (await mailApi.email.flag(null, { ids, ...payload })) as {
        updated_ids?: number[]
        not_found?: number[]
      }
      const ok = result?.updated_ids?.length ?? 0
      const failed = result?.not_found?.length ?? 0
      if (failed === 0) {
        toastSuccess(`${label}: ${ok} 封完成`)
      } else if (ok === 0) {
        toastError(`${label} 失败`, `${failed} 封未找到`)
      } else {
        toastError(`${label}: ${ok}/${ids.length}`, `${failed} 封未找到`)
      }
    } catch (err) {
      // Single CLI call → single failure surface (E_AUTH / E_PM2_RUNNING /
      // network). Whole batch failed; no partial state to report.
      const msg = err instanceof Error ? err.message : String(err)
      toastError(`${label} 失败`, msg)
    }
    await queryClient.invalidateQueries({ queryKey: ['emails'] })
  }

  return createPortal(
    <div
      ref={scopeRef}
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
        onClick={() => void runBulk(t('batchbar.markRead'), { isRead: true })}
      >
        <Mail size={13} strokeWidth={2} />
        <span>{t('batchbar.markRead')}</span>
      </button>
      <button
        type="button"
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-aux text-ink-fg-1 hover:text-ink-fg hover:bg-ink-3 transition-colors duration-fast"
        onClick={() => void runBulk(t('batchbar.toggleFlag'), { isFlagged: true })}
      >
        <Flag size={13} strokeWidth={2} />
        <span>{t('batchbar.toggleFlag')}</span>
      </button>
      <button
        type="button"
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-aux text-ink-fg-1 hover:text-ink-fg hover:bg-ink-3 transition-colors duration-fast"
        onClick={() =>
          void runBulk(t('batchbar.markDone'), {
            isFlagged: false,
            processingStatus: '已完成'
          })
        }
      >
        <CheckCircle2 size={13} strokeWidth={2} />
        <span>{t('batchbar.markDone')}</span>
      </button>
      <button
        type="button"
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-aux text-ink-fg-1 hover:text-ink-fg hover:bg-ink-3 transition-colors duration-fast"
        onClick={() =>
          void runBulk(t('batchbar.archive'), {
            isFlagged: false,
            processingStatus: '已完成'
          })
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
