// Detail-pane attachment list. Per DESIGN.md §5 the section header reads
// `ATTACHMENTS · N` (English UPPERCASE mono). Each row: filename + size +
// optional "preview" button. Caller filters out inline + derived siblings;
// this component renders what it's given.

import { useState } from 'react'
import { Paperclip, ExternalLink } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { formatFileSize } from '@shared/format'
import { useMailApi } from '@shared/hooks/useMailApi'
import type { EmailDetail } from '@shared/api/types'

type Attachment = NonNullable<EmailDetail['attachments']>[number]

interface Props {
  attachments: ReadonlyArray<Attachment>
}

export function AttachmentList({ attachments }: Props): React.ReactElement {
  const mailApi = useMailApi()
  // Tracks which attachment opens errored so we can show a inline hint.
  const [error, setError] = useState<string | null>(null)

  async function open(id: number): Promise<void> {
    setError(null)
    try {
      const path = await mailApi.attachment.localPath(id)
      if (!path) {
        setError('Attachment not yet downloaded to disk.')
        return
      }
      // Open via the system handler. Renderer has `webPreferences.sandbox:
      // false`, so `window.open(file://...)` is legal — but the new-window
      // hook in main/index.ts forwards file:// to shell.openExternal for us.
      window.open(`file://${encodeURI(path)}`, '_blank', 'noopener')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <section aria-label="attachments">
      <header className="flex items-center justify-between mb-3">
        <h3 className="text-micro font-mono uppercase tracking-widest text-ink-fg-2">
          Attachments
          <span className="ml-2 text-ink-fg-3 tabular-nums">{attachments.length}</span>
        </h3>
      </header>

      {error && <div className="mb-2 text-aux text-fail">{error}</div>}

      <ul role="list" className="space-y-1.5">
        {attachments.map((a) => (
          <li key={a.id}>
            <button
              onClick={() => open(a.id)}
              className={cn(
                'group w-full flex items-center justify-between px-3 py-2 rounded-md border border-ink-border',
                'bg-ink-1 hover:bg-ink-3 transition-colors duration-fast text-left'
              )}
            >
              <span className="flex items-center gap-2 min-w-0">
                <Paperclip size={13} className="text-ink-fg-2 shrink-0" />
                <span className="text-aux text-ink-fg truncate">{a.filename}</span>
              </span>
              <span className="flex items-center gap-2 shrink-0 ml-3">
                <span className="text-meta font-mono text-ink-fg-3 tabular-nums">
                  {a.size_bytes != null ? formatFileSize(a.size_bytes) : '—'}
                </span>
                <ExternalLink
                  size={12}
                  className="text-ink-fg-3 opacity-0 group-hover:opacity-100 transition-opacity"
                />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
