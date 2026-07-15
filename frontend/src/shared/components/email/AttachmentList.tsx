// mockup-inbox.html line 2227-2254 / mockup-detail-window.html line 405-424.
// Section header `ATTACHMENTS · N` in English UPPERCASE mono; 2-col tile
// grid; each tile has a colour-toned type icon (or a thumbnail for small
// images), filename + size meta, and persistent preview / download controls.
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
import { useTranslation } from 'react-i18next'
import { Download, Eye, Paperclip } from 'lucide-react'
import { useQueries, useQueryClient } from '@tanstack/react-query'

import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { formatFileSize } from '@shared/format'
import { useMailApi } from '@shared/hooks/useMailApi'
import { qk } from '@shared/lib/queryKeys'
import type { EmailDetail } from '@shared/api/types'

import { ImageLightbox } from './EmailBodyFrame'
import {
  canPreviewImage,
  isImageAttachment,
  pickIconTone,
  readDataUrlOrThrow,
  THUMBNAIL_MAX_BYTES,
  THUMBNAIL_RENDER_LIMIT
} from './attachmentPreview'

type Attachment = NonNullable<EmailDetail['attachments']>[number]

interface Props {
  /** Full attachment list from EmailDetail.get(). We filter inline +
   *  derived rows internally so callers don't have to track the two
   *  filtering rules. */
  attachments: ReadonlyArray<Attachment>
}

export function AttachmentList({ attachments }: Props): React.ReactElement | null {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const queryClient = useQueryClient()
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  // Thumbnails that failed to decode fall back to the type icon so a broken
  // image never ships in the tile.
  const [thumbFailed, setThumbFailed] = useState<ReadonlySet<number>>(() => new Set())

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

  // Prefetch thumbnails for the first N image originals under the size cap.
  // Non-images / oversized / the overflow render the type icon (no fetch),
  // bounding the readDataUrl fan-out. `qk.attachment.dataUrl` + staleTime:
  // Infinity shares the cache with EmailBodyFrame and ThreadAttachmentBar;
  // `readDataUrlOrThrow` makes a null read a retryable error (not a stuck
  // success) so a late-landing file recovers.
  const thumbTargets = useMemo(
    () =>
      visible
        .filter((a) => isImageAttachment(a) && (a.size_bytes ?? Infinity) <= THUMBNAIL_MAX_BYTES)
        .slice(0, THUMBNAIL_RENDER_LIMIT),
    [visible]
  )
  const thumbQueries = useQueries({
    queries: thumbTargets.map((a) => ({
      queryKey: qk.attachment.dataUrl(a.id),
      queryFn: () => readDataUrlOrThrow((i) => mailApi.attachment.readDataUrl(i), a.id),
      staleTime: Infinity
    }))
  })
  const thumbById = useMemo(() => {
    const m = new Map<number, string>()
    thumbTargets.forEach((a, i) => {
      const url = thumbQueries[i]?.data
      if (typeof url === 'string' && url.length > 0) m.set(a.id, url)
    })
    return m
  }, [thumbTargets, thumbQueries])

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
        setNotice({ tone: 'err', text: t('emailDetail.attachmentBar.missing') })
        return
      }
      const basename = target.split('/').pop() ?? target
      setNotice({ tone: 'ok', text: t('emailDetail.attachmentBar.savedTo', { name: basename }) })
    } catch (err) {
      setNotice({ tone: 'err', text: errorMessage(err) })
    }
  }

  // Open the zoom/rotate lightbox (shared with EmailBodyFrame). Guards:
  //   - a thumbnail that failed to decode won't preview the same broken bytes;
  //   - only images with a known size within the preview cap are read (never an
  //     unbounded full-file read for a huge / unknown-size image).
  // Reuse the cached thumbnail when present; otherwise read on demand.
  async function preview(a: Attachment): Promise<void> {
    setNotice(null)
    if (thumbFailed.has(a.id)) {
      setNotice({ tone: 'err', text: t('emailDetail.attachmentBar.previewFailed') })
      return
    }
    if (!canPreviewImage(a)) {
      setNotice({ tone: 'err', text: t('emailDetail.attachmentBar.tooLarge') })
      return
    }
    const cached = thumbById.get(a.id)
    if (cached) {
      setPreviewSrc(cached)
      return
    }
    try {
      const url = await queryClient.fetchQuery({
        queryKey: qk.attachment.dataUrl(a.id),
        queryFn: () => readDataUrlOrThrow((i) => mailApi.attachment.readDataUrl(i), a.id),
        staleTime: Infinity
      })
      setPreviewSrc(url)
    } catch {
      setNotice({ tone: 'err', text: t('emailDetail.attachmentBar.previewFailed') })
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
          const isImage = isImageAttachment(a)
          const thumbUrl = thumbFailed.has(a.id) ? undefined : thumbById.get(a.id)
          return (
            // Non-interactive container: the tile is NOT a button, so the
            // explicit preview / download / derived controls below are real,
            // non-nested <button>s (valid DOM + one Tab stop each).
            <div
              key={a.id}
              className={cn(
                'flex items-start gap-3 px-3 py-2.5 rounded-md',
                'border border-ink-border bg-ink-2'
              )}
            >
              {thumbUrl ? (
                <img
                  src={thumbUrl}
                  alt=""
                  loading="lazy"
                  onError={() =>
                    setThumbFailed((prev) => {
                      const next = new Set(prev)
                      next.add(a.id)
                      return next
                    })
                  }
                  className="w-9 h-9 rounded-md object-cover shrink-0 border border-ink-border bg-ink-1"
                />
              ) : (
                <div
                  className={cn(
                    'w-9 h-9 rounded-md grid place-items-center shrink-0 border',
                    tone.bg,
                    tone.border
                  )}
                >
                  <I size={16} strokeWidth={2} className={tone.text} />
                </div>
              )}
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
                  // chip so the user doesn't have to open the original first.
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-meta font-mono">
                    <span className="text-ink-fg-3">→</span>
                    {derivedKids.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => void download(d.id)}
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
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {/* Persistent (no longer hover-only) actions — real, non-nested
                  buttons: preview images in the lightbox, download anything. */}
              <div className="flex items-center gap-0.5 self-center shrink-0">
                {isImage && (
                  <button
                    type="button"
                    aria-label={t('emailDetail.attachmentBar.preview')}
                    title={t('emailDetail.attachmentBar.preview')}
                    onClick={() => void preview(a)}
                    className={cn(
                      'grid place-items-center w-6 h-6 rounded cursor-pointer',
                      'text-ink-fg-3 hover:text-ink-fg-1 hover:bg-ink-4',
                      'transition-colors duration-fast'
                    )}
                  >
                    <Eye size={13} strokeWidth={2} />
                  </button>
                )}
                <button
                  type="button"
                  aria-label={t('emailDetail.attachmentBar.download')}
                  title={t('emailDetail.attachmentBar.download')}
                  onClick={() => void download(a.id)}
                  className={cn(
                    'grid place-items-center w-6 h-6 rounded cursor-pointer',
                    'text-ink-fg-3 hover:text-ink-fg-1 hover:bg-ink-4',
                    'transition-colors duration-fast'
                  )}
                >
                  <Download size={13} strokeWidth={2} />
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {previewSrc !== null && (
        <ImageLightbox src={previewSrc} onClose={() => setPreviewSrc(null)} />
      )}
    </section>
  )
}
