// mockup-inbox.html line 1045+. Section header `ATTACHMENTS · N` in English
// UPPERCASE mono. 2-col card grid; each card has a colored type-icon, name
// + size meta, hover-reveal download/preview button.

import { useState } from 'react'
import { Download, FileText, Image as ImageIcon, Paperclip } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { formatFileSize } from '@shared/format'
import { useMailApi } from '@shared/hooks/useMailApi'
import type { EmailDetail } from '@shared/api/types'

type Attachment = NonNullable<EmailDetail['attachments']>[number]

interface Props {
  attachments: ReadonlyArray<Attachment>
}

interface IconTone {
  Icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>
  bg: string
  border: string
  text: string
}

function pickIconTone(att: Attachment): IconTone {
  const ct = (att.content_type ?? '').toLowerCase()
  const name = att.filename.toLowerCase()
  if (ct.startsWith('image/') || /\.(png|jpe?g|gif|webp|heic|svg)$/.test(name)) {
    return { Icon: ImageIcon, bg: 'bg-info/10', border: 'border-info/25', text: 'text-info' }
  }
  if (ct === 'application/pdf' || name.endsWith('.pdf')) {
    return { Icon: FileText, bg: 'bg-fail/10', border: 'border-fail/25', text: 'text-fail' }
  }
  if (ct.startsWith('application/vnd.openxmlformats') || /\.(docx?|xlsx?|pptx?|csv)$/.test(name)) {
    return { Icon: FileText, bg: 'bg-impt/10', border: 'border-impt/25', text: 'text-impt' }
  }
  return { Icon: Paperclip, bg: 'bg-ink-4', border: 'border-ink-border', text: 'text-ink-fg-2' }
}

export function AttachmentList({ attachments }: Props): React.ReactElement {
  const mailApi = useMailApi()
  const [error, setError] = useState<string | null>(null)

  async function open(id: number): Promise<void> {
    setError(null)
    try {
      const path = await mailApi.attachment.localPath(id)
      if (!path) {
        setError('Attachment not yet downloaded.')
        return
      }
      window.open(`file://${encodeURI(path)}`, '_blank', 'noopener')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <section aria-label="attachments">
      <div className="flex items-center gap-2 mb-3">
        <Paperclip size={13} strokeWidth={2} className="text-ink-fg-2" />
        <span
          className="text-meta font-mono uppercase text-ink-fg-1"
          style={{ letterSpacing: '0.06em' }}
        >
          Attachments · {attachments.length}
        </span>
      </div>

      {error && <div className="mb-2 text-aux text-fail">{error}</div>}

      <div className="grid grid-cols-2 gap-2">
        {attachments.map((a) => {
          const tone = pickIconTone(a)
          const I = tone.Icon
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => open(a.id)}
              className={cn(
                'group flex items-center gap-3 px-3 py-2.5 rounded-md',
                'border border-ink-border bg-ink-2',
                'hover:bg-ink-4 hover:border-ink-fg-3',
                'transition-colors duration-fast text-left'
              )}
            >
              <div
                className={cn(
                  'w-9 h-9 rounded-md grid place-items-center shrink-0 border',
                  tone.bg,
                  tone.border
                )}
              >
                <I size={16} strokeWidth={2} className={tone.text} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-aux text-ink-fg font-medium truncate">{a.filename}</div>
                <div className="text-meta font-mono text-ink-fg-2 tabular-nums">
                  {a.size_bytes != null ? formatFileSize(a.size_bytes) : '—'}
                  {a.content_type && (
                    <>
                      <span className="mx-1 text-ink-fg-3">·</span>
                      <span className="text-ink-fg-2">{a.content_type}</span>
                    </>
                  )}
                </div>
              </div>
              <Download
                size={13}
                strokeWidth={2}
                className="text-ink-fg-3 opacity-0 group-hover:opacity-100 transition-opacity"
              />
            </button>
          )
        })}
      </div>
    </section>
  )
}
