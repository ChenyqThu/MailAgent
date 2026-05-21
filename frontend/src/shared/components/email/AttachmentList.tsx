// mockup-inbox.html line 2227-2254 / mockup-detail-window.html line 405-424.
// Section header `ATTACHMENTS · N` in English UPPERCASE mono; 2-col tile
// grid; each tile has a colour-toned type icon, filename + size meta,
// and a hover-reveal download chevron.
//
// Sprint 13 — handles derived attachments (docx → PDF / xlsx → CSV) inline.
// CLAUDE.md "Office 附件转换" pipeline writes a separate
// `email_attachment` row with `derived_from = <original_id>`. Rather than
// showing the derivative as a sibling tile (clutters the grid), the parent
// tile gets a secondary line:
//
//     → pdf · 142 KB    (click → opens the PDF)
//
// This stays mockup-faithful (the mockup only depicts one PDF per file)
// while exposing the conversion artefact when the user wants it.

import { useMemo, useState } from 'react'
import { Download, FileText, Image as ImageIcon, Paperclip } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { formatFileSize } from '@shared/format'
import { useMailApi } from '@shared/hooks/useMailApi'
import type { EmailDetail } from '@shared/api/types'

type Attachment = NonNullable<EmailDetail['attachments']>[number]

interface Props {
  /** Full attachment list from EmailDetail.get(). We filter inline +
   *  derived rows internally so callers don't have to track the two
   *  filtering rules. */
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

export function AttachmentList({ attachments }: Props): React.ReactElement | null {
  const mailApi = useMailApi()
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  // Bucket the rows: visible originals (non-inline, no `derived_from`)
  // become tiles; the rest get indexed by parent so the parent tile can
  // surface the derived child as a "→ pdf · 142 KB" pill.
  const { visible, derivedByParent } = useMemo(() => {
    const derivedByParent = new Map<number, Attachment[]>()
    for (const a of attachments) {
      const parent = typeof a.derived_from === 'number' ? a.derived_from : null
      if (parent !== null) {
        const arr = derivedByParent.get(parent) ?? []
        arr.push(a)
        derivedByParent.set(parent, arr)
      }
    }
    const visible = attachments.filter(
      (a) => !a.is_inline && (a.derived_from === null || a.derived_from === undefined)
    )
    return { visible, derivedByParent }
  }, [attachments])

  // EmailDetail used to gate `visibleAttachments.length > 0` before
  // mounting us; Sprint 13 moved the filter inside so it can also see the
  // derived children. Bail out cleanly when there's nothing to render so
  // the parent doesn't have to repeat the count logic.
  if (visible.length === 0) return null

  // Renderer can't navigate to `file://` from a `http://localhost:5173`
  // origin (Chromium "Not allowed to load local resource"). Round-trip
  // through the main process and copy the file into ~/Downloads instead —
  // matches the user's mental model of "download this attachment".
  async function download(id: number): Promise<void> {
    setNotice(null)
    try {
      const target = await mailApi.attachment.download(id)
      if (target === null) {
        setNotice({ tone: 'err', text: 'Attachment file is missing on disk.' })
        return
      }
      const basename = target.split('/').pop() ?? target
      setNotice({ tone: 'ok', text: `Saved to ~/Downloads/${basename}` })
    } catch (err) {
      setNotice({ tone: 'err', text: err instanceof Error ? err.message : String(err) })
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
          Attachments · {visible.length}
        </span>
      </div>

      {notice && (
        <div className={cn('mb-2 text-aux', notice.tone === 'ok' ? 'text-ok' : 'text-fail')}>
          {notice.text}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        {visible.map((a) => {
          const tone = pickIconTone(a)
          const I = tone.Icon
          const derivedKids = derivedByParent.get(a.id) ?? []
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => void download(a.id)}
              className={cn(
                'group flex items-start gap-3 px-3 py-2.5 rounded-md',
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
              <div className="min-w-0 flex-1 self-center">
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
                {derivedKids.length > 0 && (
                  // Office → PDF / xlsx → CSV conversion artefact. Backend
                  // wrote it as a sibling row; we surface it as a one-tap
                  // chip so the user doesn't have to open the original
                  // first. Stop propagation so the parent tile's click
                  // doesn't also fire (would open the original instead).
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-meta font-mono">
                    <span className="text-ink-fg-3">→</span>
                    {derivedKids.map((d) => (
                      <span
                        key={d.id}
                        role="link"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation()
                          void download(d.id)
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter' && e.key !== ' ') return
                          e.preventDefault()
                          e.stopPropagation()
                          void download(d.id)
                        }}
                        className={cn(
                          'inline-flex items-center gap-1 px-1.5 py-0.5 rounded',
                          'text-ok bg-ok/10 border border-ok/25',
                          'hover:bg-ok/15 cursor-pointer transition-colors duration-fast'
                        )}
                      >
                        <span className="uppercase">{d.derived_format ?? 'pdf'}</span>
                        {d.size_bytes != null && (
                          <span className="text-ok/70">{formatFileSize(d.size_bytes)}</span>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <Download
                size={13}
                strokeWidth={2}
                className="text-ink-fg-3 opacity-0 group-hover:opacity-100 transition-opacity self-center"
              />
            </button>
          )
        })}
      </div>
    </section>
  )
}
