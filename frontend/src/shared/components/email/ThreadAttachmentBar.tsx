// Thread-wide attachment preview strip, mounted above the body in EmailDetail.
//
// The detail pane only shows ONE message (the thread is folded in the list, not
// stacked here — see EmailDetail's "ThreadBundle 撤出" note), so attachments
// scattered across older replies are otherwise invisible until you click each
// message. This strip aggregates every non-inline attachment across the whole
// thread into one horizontally-scrollable row:
//
//   - the active message's attachments come from props (already in hand);
//   - every other thread member is fetched lazily via `attachment.list(id)`
//     (metadata only, no body) and rendered incrementally as each resolves —
//     a long thread doesn't block the strip on its slowest member;
//   - image originals ≤ THUMBNAIL_MAX_BYTES show a real thumbnail (shared
//     `qk.attachment.dataUrl` cache); larger images / non-images show a type
//     icon;
//   - each card labels its source (sender · relative time), jumps to that
//     message on click, and offers persistent preview (lightbox) + download.
//
// Pure frontend: reuses the existing attachment IPC surface only.

import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Eye, Paperclip } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { formatFileSize, formatRelativeTime } from '@shared/format'
import { parseSender } from '@shared/lib/mail_parse'
import { useMailApi } from '@shared/hooks/useMailApi'
import { qk } from '@shared/lib/queryKeys'
import { useActiveEmail } from '@shared/state/active-email'
import { toastError, toastSuccess } from '@shared/state/toast'
import type { EmailDetail } from '@shared/api/types'

import { ImageLightbox } from './EmailBodyFrame'
import { isImageAttachment, pickIconTone, THUMBNAIL_MAX_BYTES } from './attachmentPreview'

type Attachment = NonNullable<EmailDetail['attachments']>[number]

interface Props {
  threadId: string | null
  activeInternalId: number
  activeSenderName: string | null
  activeSender: string
  activeDate: string | null
  activeAttachments: ReadonlyArray<Attachment>
}

interface CardItem {
  att: Attachment
  sourceId: number
}

// Same "real attachment" filter AttachmentList uses (non-inline, not a
// docx→PDF / xlsx→CSV derived row) so the strip and the per-message list agree
// on what's a user-facing attachment.
function isVisibleAttachment(a: Attachment): boolean {
  return !a.is_inline && (a.derived_from === null || a.derived_from === undefined)
}

function senderLabel(name: string | null, sender: string): string {
  const trimmed = (name ?? '').trim()
  if (trimmed) return trimmed
  const parsed = parseSender(sender)
  return parsed.name || parsed.email || sender
}

export function ThreadAttachmentBar({
  threadId,
  activeInternalId,
  activeSenderName,
  activeSender,
  activeDate,
  activeAttachments
}: Props): React.ReactElement | null {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const queryClient = useQueryClient()
  const setActive = useActiveEmail((s) => s.setActive)
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const [thumbFailed, setThumbFailed] = useState<ReadonlySet<number>>(() => new Set())

  // Thread members. `EmailMeta` carries no attachment info (research §2), so the
  // list only tells us WHICH siblings to probe, plus their sender/date for the
  // source label.
  const threadEnabled = threadId != null && threadId !== ''
  const threadQ = useQuery({
    queryKey: qk.email.thread(threadId),
    queryFn: () => mailApi.email.listByThread(threadId),
    enabled: threadEnabled,
    staleTime: 60_000
  })

  const members = useMemo(() => threadQ.data ?? [], [threadQ.data])
  const siblingIds = useMemo(
    () => members.map((m) => m.internal_id).filter((id) => id !== activeInternalId),
    [members, activeInternalId]
  )

  // internal_id → source label + date, covering the active message (from props)
  // and every sibling (from the thread list).
  const sourceById = useMemo(() => {
    const map = new Map<number, { label: string; date: string | null }>()
    map.set(activeInternalId, {
      label: senderLabel(activeSenderName, activeSender),
      date: activeDate
    })
    for (const m of members) {
      map.set(m.internal_id, {
        label: senderLabel(m.sender_name ?? null, m.sender),
        date: m.date_received ?? null
      })
    }
    return map
  }, [members, activeInternalId, activeSenderName, activeSender, activeDate])

  // One lazy attachment.list per sibling. `useQueries` over a growing array is
  // fine — each entry resolves independently, giving us the incremental render.
  const siblingAttQueries = useQueries({
    queries: siblingIds.map((id) => ({
      queryKey: qk.attachment.list(id),
      queryFn: () => mailApi.attachment.list(id),
      staleTime: 60_000
    }))
  })

  // Active message's attachments first (in hand), then each sibling as its list
  // resolves — siblings still loading are simply skipped this render.
  const cards = useMemo(() => {
    const out: CardItem[] = []
    for (const a of activeAttachments) {
      if (isVisibleAttachment(a)) out.push({ att: a, sourceId: activeInternalId })
    }
    siblingIds.forEach((id, i) => {
      const q = siblingAttQueries[i]
      if (!q || !q.isSuccess || q.data == null) return
      for (const a of q.data) {
        if (isVisibleAttachment(a)) out.push({ att: a, sourceId: id })
      }
    })
    return out
  }, [activeAttachments, activeInternalId, siblingIds, siblingAttQueries])

  // Thumbnails for image originals under the cap (same rule as AttachmentList).
  const thumbTargets = useMemo(
    () =>
      cards.filter(
        (c) => isImageAttachment(c.att) && (c.att.size_bytes ?? Infinity) <= THUMBNAIL_MAX_BYTES
      ),
    [cards]
  )
  const thumbQueries = useQueries({
    queries: thumbTargets.map((c) => ({
      queryKey: qk.attachment.dataUrl(c.att.id),
      queryFn: () => mailApi.attachment.readDataUrl(c.att.id),
      staleTime: Infinity
    }))
  })
  const thumbById = useMemo(() => {
    const m = new Map<number, string>()
    thumbTargets.forEach((c, i) => {
      const url = thumbQueries[i]?.data
      if (typeof url === 'string' && url.length > 0) m.set(c.att.id, url)
    })
    return m
  }, [thumbTargets, thumbQueries])

  const download = useCallback(
    async (id: number): Promise<void> => {
      try {
        const target = await mailApi.attachment.download(id)
        if (target === null) {
          toastError(t('emailDetail.attachmentBar.missing'))
          return
        }
        const basename = target.split('/').pop() ?? target
        toastSuccess(t('emailDetail.attachmentBar.savedTo', { name: basename }))
      } catch (err) {
        toastError(errorMessage(err))
      }
    },
    [mailApi, t]
  )

  const preview = useCallback(
    async (id: number): Promise<void> => {
      const cached = thumbById.get(id)
      if (cached) {
        setPreviewSrc(cached)
        return
      }
      try {
        const url = await queryClient.fetchQuery({
          queryKey: qk.attachment.dataUrl(id),
          queryFn: () => mailApi.attachment.readDataUrl(id),
          staleTime: Infinity
        })
        if (typeof url === 'string' && url.length > 0) setPreviewSrc(url)
        else toastError(t('emailDetail.attachmentBar.previewFailed'))
      } catch {
        toastError(t('emailDetail.attachmentBar.previewFailed'))
      }
    },
    [thumbById, queryClient, mailApi, t]
  )

  const downloadAll = useCallback(async (): Promise<void> => {
    // Sequential on purpose: keeps the ~/Downloads collision-rename
    // deterministic; there's no bulk/zip IPC.
    for (const c of cards) {
      await download(c.att.id)
    }
  }, [cards, download])

  if (cards.length === 0) return null

  return (
    <section
      aria-label="thread-attachments"
      className="mt-6 rounded-lg border border-ink-border bg-ink-2/40 px-3 py-2.5"
    >
      <div className="flex items-center gap-2 mb-2">
        <Paperclip size={13} strokeWidth={2} className="text-ink-fg-2" />
        <span
          className="text-meta font-mono uppercase text-ink-fg-1"
          style={{ letterSpacing: '0.06em' }}
        >
          {t('emailDetail.attachmentBar.title')} · {cards.length}
        </span>
        <button
          type="button"
          onClick={() => void downloadAll()}
          className={cn(
            'ml-auto inline-flex items-center gap-1 px-2 py-1 rounded',
            'text-meta text-ink-fg-2 hover:text-ink-fg-1 hover:bg-ink-4',
            'transition-colors duration-fast'
          )}
        >
          <Download size={12} strokeWidth={2} />
          {t('emailDetail.attachmentBar.downloadAll')}
        </button>
      </div>

      <div className="flex gap-2 overflow-x-auto scrollbar-thin pb-1">
        {cards.map((c) => {
          const a = c.att
          const src = sourceById.get(c.sourceId)
          const isImage = isImageAttachment(a)
          const thumbUrl = thumbFailed.has(a.id) ? undefined : thumbById.get(a.id)
          const tone = pickIconTone(a)
          const I = tone.Icon
          return (
            <div
              key={`${c.sourceId}-${a.id}`}
              className={cn(
                'group relative flex flex-col w-44 shrink-0 rounded-md overflow-hidden',
                'border border-ink-border bg-ink-2'
              )}
            >
              <button
                type="button"
                onClick={() => setActive(c.sourceId, { navTarget: true })}
                title={a.filename}
                className={cn(
                  'flex flex-col text-left w-full',
                  'hover:bg-ink-4 transition-colors duration-fast'
                )}
              >
                <div className="h-20 w-full bg-ink-1/60 grid place-items-center overflow-hidden">
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
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div
                      className={cn(
                        'w-10 h-10 rounded-md grid place-items-center border',
                        tone.bg,
                        tone.border
                      )}
                    >
                      <I size={18} strokeWidth={2} className={tone.text} />
                    </div>
                  )}
                </div>
                <div className="px-2 pt-1.5">
                  <div className="text-aux text-ink-fg font-medium truncate">{a.filename}</div>
                  <div className="text-meta font-mono text-ink-fg-2 tabular-nums truncate">
                    {a.size_bytes != null ? formatFileSize(a.size_bytes) : '—'}
                  </div>
                  {src && (
                    <div className="mt-0.5 text-meta text-ink-fg-3 truncate">
                      {src.label}
                      {src.date && <span> · {formatRelativeTime(src.date)}</span>}
                    </div>
                  )}
                </div>
              </button>
              <div className="flex items-center gap-0.5 px-2 pb-1.5 pt-1">
                {isImage && (
                  <button
                    type="button"
                    aria-label={t('emailDetail.attachmentBar.preview')}
                    title={t('emailDetail.attachmentBar.preview')}
                    onClick={() => void preview(a.id)}
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
