// Markdown prompt editor — shown when the user clicks "编辑" next to either
// inbox or sent prompt row in AiTab. Loads content on open via
// mailApi.prompts.read, saves through mailApi.prompts.write. The textarea is
// monospace so users can see the markdown structure raw — preview rendering
// would add a markdown lib for a one-off use case.

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { Button } from '@shared/components/ui/button'
import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError, toastSuccess } from '@shared/state/toast'
import type { PromptSlot } from '@shared/api/types'

interface Props {
  slot: PromptSlot | null
  open: boolean
  onClose(): void
}

export function PromptEditorDialog({ slot, open, onClose }: Props): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const [content, setContent] = React.useState('')
  const [path, setPath] = React.useState('')
  const [exists, setExists] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [dirty, setDirty] = React.useState(false)

  // Load whenever (open, slot) flips on.
  React.useEffect(() => {
    if (!open || slot === null) return
    setLoading(true)
    setDirty(false)
    api.prompts
      .read(slot)
      .then((r) => {
        setContent(r.content)
        setPath(r.path)
        setExists(r.exists)
      })
      .catch((err: Error) => {
        toastError(t('settings.ai.prompts.loadFailed'), err.message)
      })
      .finally(() => setLoading(false))
  }, [open, slot, api.prompts, t])

  async function handleSave(): Promise<void> {
    if (slot === null) return
    setSaving(true)
    const r = await api.prompts.write(slot, content)
    setSaving(false)
    if (!r.ok) {
      toastError(t('settings.ai.prompts.saveFailed'), `${r.code}: ${r.message}`)
      return
    }
    toastSuccess(t('settings.ai.prompts.saved'), r.info.path)
    setExists(true)
    setDirty(false)
    onClose()
  }

  const title =
    slot === 'inbox'
      ? t('settings.ai.prompts.inbox.editTitle')
      : slot === 'sent'
        ? t('settings.ai.prompts.sent.editTitle')
        : ''

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {exists
              ? t('settings.ai.prompts.pathHint', { path })
              : t('settings.ai.prompts.willCreate', { path })}
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center gap-2 text-aux text-ink-fg-2 py-12 justify-center">
            <Loader2 className="size-4 animate-spin" />
            {t('settings.ai.prompts.loading')}
          </div>
        ) : (
          <textarea
            value={content}
            onChange={(e) => {
              setContent(e.target.value)
              setDirty(true)
            }}
            spellCheck={false}
            className="w-full min-h-[480px] max-h-[60vh] resize-y rounded-md border border-ink-border-soft bg-ink-2/40 p-3 font-mono text-aux text-ink-fg leading-relaxed focus:outline-none focus:ring-1 focus:ring-coral/40"
            placeholder={t('settings.ai.prompts.placeholder')}
          />
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('common.cancel', { defaultValue: '取消' })}
          </Button>
          <Button onClick={() => void handleSave()} disabled={loading || saving || !dirty}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t('settings.ai.prompts.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
