import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Save, Trash2, X } from 'lucide-react'

import { MATTER_TAG_COLORS, MATTER_TAG_SHAPES } from '@shared/api/types/matter'
import type { MatterTagColor, MatterTagDefinition, MatterTagShape } from '@shared/api/types/matter'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { Button } from '@shared/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { Input } from '@shared/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@shared/components/ui/popover'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError, toastSuccess } from '@shared/state/toast'

import { useMattersApi } from './hooks'
import { MatterTagMarker } from './MatterTagMarker'
import { normalizeMatterTagInput } from './matterTags'

interface MatterTagManagerModalProps {
  open: boolean
  tags: readonly MatterTagDefinition[]
  onOpenChange(open: boolean): void
}

function swatchStyle(color: MatterTagColor): React.CSSProperties {
  return { backgroundColor: `rgb(var(${color}))` }
}

export function MatterTagManagerModal({
  open,
  tags,
  onOpenChange
}: MatterTagManagerModalProps): React.ReactElement {
  const { t } = useTranslation()
  const api = useMattersApi()
  const queryClient = useQueryClient()
  const [renameDrafts, setRenameDrafts] = useState<Record<string, string>>({})
  const [pendingDeleteName, setPendingDeleteName] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setRenameDrafts({})
      setPendingDeleteName(null)
    }
  }, [open])

  const invalidateMatterTags = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: qk.matters.all() })
  }

  const styleMutation = useMutation({
    mutationFn: ({
      tag,
      color,
      shape
    }: {
      tag: MatterTagDefinition
      color: MatterTagColor
      shape: MatterTagShape
    }) => api.setTagStyle(tag.name, { color, shape }, { reason: 'user_updated_matter_tag_style' }),
    onSuccess: async () => {
      await invalidateMatterTags()
      toastSuccess(t('matters.tags.saved'))
    },
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  const renameMutation = useMutation({
    mutationFn: ({ name, nextName }: { name: string; nextName: string }) =>
      api.renameTag(name, nextName, { reason: 'user_renamed_matter_tag' }),
    onSuccess: async (_result, variables) => {
      setRenameDrafts((current) => {
        const next = { ...current }
        delete next[variables.name]
        return next
      })
      setPendingDeleteName(null)
      await invalidateMatterTags()
      toastSuccess(t('matters.tags.renameSaved'))
    },
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  const deleteMutation = useMutation({
    mutationFn: (name: string) => api.deleteTag(name, { reason: 'user_deleted_matter_tag' }),
    onSuccess: async () => {
      setPendingDeleteName(null)
      await invalidateMatterTags()
      toastSuccess(t('matters.tags.deleted'))
    },
    onError: (error) => toastError(t('matters.toast.deleteFailed'), errorMessage(error))
  })

  const saveRename = (tag: MatterTagDefinition): void => {
    const nextName = normalizeMatterTagInput(renameDrafts[tag.name] ?? tag.name)
    if (!nextName || nextName === tag.name) return
    renameMutation.mutate({ name: tag.name, nextName })
  }

  const setTagStyle = (
    tag: MatterTagDefinition,
    patch: Partial<Pick<MatterTagDefinition, 'color' | 'shape'>>
  ): void => {
    const color = patch.color ?? tag.color
    const shape = patch.shape ?? tag.shape
    if (color === tag.color && shape === tag.shape) return
    styleMutation.mutate({ tag, color, shape })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[84vh] max-w-2xl grid-rows-[auto_1fr_auto]">
        <DialogHeader>
          <DialogTitle>{t('matters.tags.managerTitle')}</DialogTitle>
          <DialogDescription>{t('matters.tags.managerDescription')}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto pr-1 scrollbar-thin">
          {tags.length === 0 ? (
            <EmptyState title={t('matters.tags.noTags')} />
          ) : (
            <div className="space-y-2">
              {tags.map((tag) => {
                const draft = renameDrafts[tag.name] ?? tag.name
                const nextName = normalizeMatterTagInput(draft)
                const renameDirty = nextName.length > 0 && nextName !== tag.name
                const confirmingDelete = pendingDeleteName === tag.name
                return (
                  <div
                    key={tag.name}
                    className="rounded-[var(--r-card)] border border-ink-border bg-ink-1/70 p-3"
                  >
                    <div className="flex items-center gap-3">
                      <TagStylePopover
                        tag={tag}
                        busy={styleMutation.isPending}
                        onChange={(patch) => setTagStyle(tag, patch)}
                      />
                      <Input
                        value={draft}
                        disabled={renameMutation.isPending}
                        onChange={(event) =>
                          setRenameDrafts((current) => ({
                            ...current,
                            [tag.name]: event.target.value
                          }))
                        }
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') saveRename(tag)
                          if (event.key === 'Escape')
                            setRenameDrafts((current) => {
                              const next = { ...current }
                              delete next[tag.name]
                              return next
                            })
                        }}
                        aria-label={t('matters.tags.renamePlaceholder')}
                        className="min-w-0 flex-1"
                      />
                      <span className="w-20 text-right font-mono text-meta text-ink-fg-2">
                        {t('matters.tags.usageCount', { count: tag.usage_count })}
                      </span>
                      <button
                        type="button"
                        disabled={!renameDirty || renameMutation.isPending}
                        onClick={() => saveRename(tag)}
                        aria-label={t('matters.tags.saveRename', { name: tag.name })}
                        className="rounded-[var(--r-ctl)] p-1.5 text-ok transition-colors duration-fast ease-standard hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-40"
                      >
                        <Save size={14} />
                      </button>
                      <button
                        type="button"
                        disabled={deleteMutation.isPending}
                        onClick={() => setPendingDeleteName(tag.name)}
                        aria-label={t('matters.tags.delete', { name: tag.name })}
                        className="rounded-[var(--r-ctl)] p-1.5 text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-fail/10 hover:text-fail focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-40"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    {confirmingDelete ? (
                      <div className="mt-3 flex flex-wrap items-center justify-end gap-2 rounded-[var(--r-ctl)] border border-fail/25 bg-fail/10 px-3 py-2">
                        <p className="mr-auto text-aux text-fail">
                          {t('matters.tags.deleteWarning', { count: tag.usage_count })}
                        </p>
                        <button
                          type="button"
                          onClick={() => setPendingDeleteName(null)}
                          className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] px-2 py-1 text-aux text-ink-fg-1 transition-colors duration-fast ease-standard hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
                        >
                          <X size={13} />
                          {t('matters.actions.cancel')}
                        </button>
                        <button
                          type="button"
                          disabled={deleteMutation.isPending}
                          onClick={() => deleteMutation.mutate(tag.name)}
                          className="rounded-[var(--r-ctl)] bg-fail px-2.5 py-1.5 text-aux font-medium text-accent-fg transition-[background-color,transform] duration-fast ease-standard hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 active:scale-[0.98] disabled:opacity-50"
                        >
                          {t('matters.tags.deleteConfirm')}
                        </button>
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface TagStylePopoverProps {
  tag: MatterTagDefinition
  busy: boolean
  onChange(patch: Partial<Pick<MatterTagDefinition, 'color' | 'shape'>>): void
}

function TagStylePopover({ tag, busy, onChange }: TagStylePopoverProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={busy}
          aria-label={t('matters.tags.style', { name: tag.name })}
          className="grid size-8 shrink-0 place-items-center rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 transition-[background-color,border-color,transform] duration-fast ease-standard hover:border-coral/40 hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 active:scale-[0.96] disabled:opacity-50"
        >
          <MatterTagMarker color={tag.color} shape={tag.shape} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3">
        <div>
          <p className="mb-2 text-meta font-medium text-ink-fg-2">{t('matters.tags.shape')}</p>
          <div className="grid grid-cols-5 gap-1">
            {MATTER_TAG_SHAPES.map((shape) => (
              <button
                key={shape}
                type="button"
                disabled={busy}
                aria-label={t(`matters.tags.shapes.${shape}`)}
                aria-pressed={tag.shape === shape}
                onClick={() => onChange({ shape })}
                className={cn(
                  'grid size-8 place-items-center rounded-[var(--r-ctl)] border transition-colors duration-fast ease-standard',
                  tag.shape === shape
                    ? 'border-coral/50 bg-coral/10'
                    : 'border-ink-border hover:bg-ink-3'
                )}
              >
                <MatterTagMarker color={tag.color} shape={shape} />
              </button>
            ))}
          </div>
        </div>
        <div className="mt-4">
          <p className="mb-2 text-meta font-medium text-ink-fg-2">{t('matters.tags.color')}</p>
          <div className="grid grid-cols-6 gap-1">
            {MATTER_TAG_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                disabled={busy}
                aria-label={t(`matters.tags.colors.${color}`)}
                aria-pressed={tag.color === color}
                onClick={() => onChange({ color })}
                className={cn(
                  'grid size-8 place-items-center rounded-[var(--r-ctl)] border transition-colors duration-fast ease-standard',
                  tag.color === color
                    ? 'border-coral/50 bg-coral/10'
                    : 'border-ink-border hover:bg-ink-3'
                )}
              >
                <span
                  aria-hidden="true"
                  className="h-4 w-4 rounded-full"
                  style={swatchStyle(color)}
                />
              </button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
