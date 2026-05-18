// Sprint 5 §2.2 / DESIGN.md §5.4 — 52px batch action bar.
//
// Appears when `selectedIds.length > 0`. The three coral AI ops are the
// headline:
//   - `AI 批量分类`  → loops `llm:run` per id (force=true, no-overwrite=false)
//   - `AI 批量起草`  → V1.5 placeholder; toast "coming soon" so the user
//                      doesn't think the button is broken
//   - `批量翻译`     → loops `ai.translate` per id with targetLang='zh'
//
// Maintenance ops (right of the AI cluster):
//   - `标已读`       → loops `notion.updateFlag(id, { isRead: true })`
//   - `归档`         → V1.5 (no backend write yet)
//   - `重传 Notion`  → loops `email.resync(id, { replaceExisting: true })`
//
// Right edge:
//   - cost estimate + queue size
//   - Esc / X to exit batch mode
//
// Visual: DESIGN.md §5.4 — coral text + coral/10 fill on AI ops, ghost on
// maintenance ops. Bar bg `ink-1`, top border `ink-border`.

import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Archive,
  CheckCheck,
  FileEdit,
  Languages,
  Loader2,
  RefreshCcw,
  Sparkles,
  X
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useBatch } from '@shared/state/batch'
import { useBatchOps } from '@shared/hooks/useBatchOps'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useShortcut } from '@shared/hooks/useShortcut'
import { toastInfo } from '@shared/state/toast'

interface AIChipProps {
  icon: React.ReactNode
  label: string
  onClick(): void
  disabled?: boolean
  running?: boolean
}

function AIChip({ icon, label, onClick, disabled, running }: AIChipProps): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-aux font-medium',
        'text-coral bg-coral/10 border border-coral/30',
        'hover:bg-coral/15 transition-colors duration-fast',
        'disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:bg-coral/10'
      )}
    >
      <span className="grid place-items-center w-[13px] h-[13px] shrink-0">
        {running ? <Loader2 size={13} strokeWidth={2} className="animate-spin" /> : icon}
      </span>
      <span>{label}</span>
    </button>
  )
}

interface GhostChipProps {
  icon: React.ReactNode
  label: string
  onClick(): void
  disabled?: boolean
}

function GhostChip({ icon, label, onClick, disabled }: GhostChipProps): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-1.5 rounded-md text-aux',
        'text-ink-fg-1 hover:text-ink-fg hover:bg-ink-4',
        'transition-colors duration-fast',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-fg-1'
      )}
    >
      <span className="grid place-items-center w-[13px] h-[13px] shrink-0">{icon}</span>
      <span>{label}</span>
    </button>
  )
}

function Divider(): React.ReactElement {
  return <div className="w-px h-5 bg-ink-border mx-1 shrink-0" aria-hidden />
}

export function BatchActionBar(): React.ReactElement | null {
  const { t } = useTranslation()
  const selectedIds = useBatch((s) => s.selectedIds)
  const clear = useBatch((s) => s.clear)
  const mailApi = useMailApi()
  const ops = useBatchOps()

  // Esc to exit batch mode (DESIGN.md §9.5 row label).
  useShortcut('escape', () => {
    if (selectedIds.length === 0 || ops.running) return false
    clear()
    return true
  })

  const total = selectedIds.length
  const disabled = ops.running || total === 0

  const runAiClassify = useCallback(async (): Promise<void> => {
    await ops.run({
      ids: selectedIds,
      opLabel: t('batchbar.aiClassify'),
      unit: (id) => mailApi.llm.run(id, { force: true })
    })
  }, [ops, selectedIds, mailApi, t])

  const runTranslate = useCallback(async (): Promise<void> => {
    await ops.run({
      ids: selectedIds,
      opLabel: t('batchbar.translate'),
      unit: (id) => mailApi.ai.translate(id, 'zh')
    })
  }, [ops, selectedIds, mailApi, t])

  const runMarkRead = useCallback(async (): Promise<void> => {
    await ops.run({
      ids: selectedIds,
      opLabel: t('batchbar.markRead'),
      unit: (id) => mailApi.notion.updateFlag(id, { isRead: true })
    })
  }, [ops, selectedIds, mailApi, t])

  const runResync = useCallback(async (): Promise<void> => {
    await ops.run({
      ids: selectedIds,
      opLabel: t('batchbar.resync'),
      unit: (id) => mailApi.email.resync(id, { replaceExisting: true })
    })
  }, [ops, selectedIds, mailApi, t])

  const stubAiDraft = useCallback(() => {
    toastInfo(t('batchToast.comingSoon'))
  }, [t])

  if (total === 0) return null

  return (
    <div
      role="region"
      aria-label="batch-action-bar"
      className={cn(
        'h-batchbar bg-ink-1 border-t border-ink-border',
        'flex items-center px-3 gap-2 shrink-0'
      )}
    >
      <span
        className={cn(
          'inline-flex items-center gap-1.5 px-2 py-1 rounded-md',
          'text-aux text-coral bg-coral/10 border border-coral/30 font-medium'
        )}
      >
        {t('batchbar.selection', { n: total })}
      </span>

      <Divider />

      <AIChip
        icon={<Sparkles size={13} strokeWidth={2} className="fill-current" />}
        label={t('batchbar.aiClassify')}
        onClick={runAiClassify}
        disabled={disabled}
        running={ops.running}
      />
      <AIChip
        icon={<FileEdit size={13} strokeWidth={2} />}
        label={t('batchbar.aiDraft')}
        onClick={stubAiDraft}
        disabled={disabled}
      />
      <AIChip
        icon={<Languages size={13} strokeWidth={2} />}
        label={t('batchbar.translate')}
        onClick={runTranslate}
        disabled={disabled}
      />

      <Divider />

      <GhostChip
        icon={<CheckCheck size={13} strokeWidth={2} />}
        label={t('batchbar.markRead')}
        onClick={runMarkRead}
        disabled={disabled}
      />
      <GhostChip
        icon={<Archive size={13} strokeWidth={2} />}
        label={t('batchbar.archive')}
        onClick={() => toastInfo(t('batchToast.comingSoon'))}
        disabled={disabled}
      />
      <GhostChip
        icon={<RefreshCcw size={13} strokeWidth={2} />}
        label={t('batchbar.resync')}
        onClick={runResync}
        disabled={disabled}
      />

      <div className="ml-auto flex items-center gap-2">
        {ops.running ? (
          <button
            type="button"
            onClick={ops.cancel}
            className={cn(
              'text-aux text-fail hover:bg-fail/10 px-2 py-1 rounded transition-colors duration-fast'
            )}
          >
            {/* Sprint 5 ship-review (opus LOW): the two cancelStage>=1
                branches both surfaced `cancelForce` — visible UX dead zone.
                Until stage 2's force-stop is wired (Sprint 5.5: renderer-side
                Promise.race against the in-flight unit), collapse to a binary
                state. */}
            {ops.cancelStage === 0 ? t('batchToast.cancelStop') : t('batchToast.cancelForce')}
          </button>
        ) : (
          <button
            type="button"
            onClick={clear}
            title={t('batchbar.exit')}
            className="ml-2 text-ink-fg-2 hover:text-ink-fg p-1.5 rounded hover:bg-ink-3 transition-colors duration-fast"
            aria-label={t('batchbar.exit')}
          >
            <X size={14} strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  )
}
