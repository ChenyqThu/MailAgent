// Thread-wide attachment preview strip, mounted above the body in EmailDetail.
//
// The detail pane only shows ONE message (the thread is folded in the list, not
// stacked here — see EmailDetail's "ThreadBundle 撤出" note), so attachments
// scattered across older replies are otherwise invisible until you click each
// message. This strip aggregates the non-inline attachments the open message
// could actually have known about into one horizontally-scrollable row:
//
//   - scope = the active message + every thread member dated at or before it.
//     A later reply was not part of this message's context, so its attachments
//     must NOT show up here (reading the 4/22 mail never surfaces the 5/21
//     file). See `priorSiblingIds` for the rule + its unknown-date edges;
//   - cards run newest message first (left) → oldest last (right);
//   - the active message's attachments come from props (already in hand);
//   - each in-scope sibling is fetched lazily via `attachment.list(id)`
//     (metadata only, no body) and rendered incrementally as each resolves —
//     a long thread doesn't block the strip on its slowest member;
//   - image originals ≤ THUMBNAIL_MAX_BYTES show a real thumbnail (the first
//     THUMBNAIL_RENDER_LIMIT of them, to bound the readDataUrl fan-out); larger
//     images / the rest / non-images show a type icon and read on preview-click;
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

// `date_received` is ISO 8601 (tz-aware preferred) or bare "YYYY-MM-DD HH:MM:SS".
// Parse to epoch ms so mixed shapes order correctly — a raw string compare would
// mis-rank a tz-suffixed stamp against a bare one. Unparseable → null.
function toTime(iso: string | null): number | null {
  if (iso == null || iso === '') return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

// THE scope rule — the render path and "Download all" both call this, because if
// they disagreed the strip would download files it never showed (an H1-class
// "what you see ≠ what you get" bug).
//
// Scope = active message + every sibling dated at or before it; equal timestamps
// count as "current and past" (<=). Edges:
//   - active date unknown → we can't order the thread at all, so keep every
//     sibling (prior behaviour) rather than blanking the strip;
//   - sibling date unknown → it can't be placed on the timeline, so exclude it
//     rather than risk surfacing a future reply's attachment.
function priorSiblingIds(
  members: ReadonlyArray<{ internal_id: number; date_received?: string | null }>,
  activeInternalId: number,
  activeDate: string | null
): number[] {
  const activeTime = toTime(activeDate)
  const out: number[] = []
  for (const m of members) {
    if (m.internal_id === activeInternalId) continue
    if (activeTime === null) {
      out.push(m.internal_id)
      continue
    }
    const t = toTime(m.date_received ?? null)
    if (t === null || t > activeTime) continue
    out.push(m.internal_id)
  }
  return out
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
  // Filtering to in-scope siblings HERE (not at render) means a future reply's
  // attachment list is never even fetched — fewer requests, and the M3 thumbnail
  // fan-out narrows naturally.
  const siblingIds = useMemo(
    () => priorSiblingIds(members, activeInternalId, activeDate),
    [members, activeInternalId, activeDate]
  )

  // internal_id → source label + date + parsed time (drives card ordering),
  // covering the active message and every sibling. Active is set LAST so its
  // props (from the authoritative detail record) win over the thread-list row.
  const sourceById = useMemo(() => {
    const map = new Map<number, { label: string; date: string | null; time: number | null }>()
    for (const m of members) {
      map.set(m.internal_id, {
        label: senderLabel(m.sender_name ?? null, m.sender),
        date: m.date_received ?? null,
        time: toTime(m.date_received ?? null)
      })
    }
    map.set(activeInternalId, {
      label: senderLabel(activeSenderName, activeSender),
      date: activeDate,
      time: toTime(activeDate)
    })
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

  // Everything settled? (thread list + every sibling list resolved or errored).
  // Gates "Download all" so it never treats a mid-load snapshot as the full set.
  const fullyLoaded =
    (!threadEnabled || threadQ.isSuccess || threadQ.isError) &&
    siblingAttQueries.every((q) => !q.isPending)

  // Active message's attachments (in hand) + each in-scope sibling as its list
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
    // Newest message first (left) → oldest last (right). Ties broken by newer
    // internal_id; within one message, attachment id ascending so a message's
    // own files keep a stable order as other members stream in.
    return out.sort((x, y) => {
      if (x.sourceId === y.sourceId) return x.att.id - y.att.id
      // Undated sources sort last — only reachable via the activeDate-null
      // fallback, where the thread can't be ordered at all.
      const tx = sourceById.get(x.sourceId)?.time ?? -Infinity
      const ty = sourceById.get(y.sourceId)?.time ?? -Infinity
      if (tx !== ty) return ty - tx
      return y.sourceId - x.sourceId
    })
  }, [activeAttachments, activeInternalId, siblingIds, siblingAttQueries, sourceById])

  // Thumbnails for the first N image originals under the cap (M3 — bound the
  // readDataUrl fan-out). The rest keep the type icon; preview still reads on
  // demand. `readDataUrlOrThrow` makes a null read a retryable error, not a
  // stuck success (M5); a decode failure falls the card back to its icon (M4).
  const thumbTargets = useMemo(
    () =>
      cards
        .filter(
          (c) => isImageAttachment(c.att) && (c.att.size_bytes ?? Infinity) <= THUMBNAIL_MAX_BYTES
        )
        .slice(0, THUMBNAIL_RENDER_LIMIT),
    [cards]
  )
  const thumbQueries = useQueries({
    queries: thumbTargets.map((c) => ({
      queryKey: qk.attachment.dataUrl(c.att.id),
      queryFn: () => readDataUrlOrThrow((i) => mailApi.attachment.readDataUrl(i), c.att.id),
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

  // Returns whether the save succeeded so bulk download can summarise. `silent`
  // suppresses the per-file success toast during "Download all" (one summary
  // toast instead of N).
  const download = useCallback(
    async (id: number, opts?: { silent?: boolean }): Promise<boolean> => {
      try {
        const target = await mailApi.attachment.download(id)
        if (target === null) {
          toastError(t('emailDetail.attachmentBar.missing'))
          return false
        }
        if (!opts?.silent) {
          const basename = target.split('/').pop() ?? target
          toastSuccess(t('emailDetail.attachmentBar.savedTo', { name: basename }))
        }
        return true
      } catch (err) {
        toastError(errorMessage(err))
        return false
      }
    },
    [mailApi, t]
  )

  const preview = useCallback(
    async (a: Attachment): Promise<void> => {
      // A thumbnail that failed to decode (HEIC / corrupt) already fell back to
      // its icon — don't open the lightbox on the same broken bytes (M4).
      if (thumbFailed.has(a.id)) {
        toastError(t('emailDetail.attachmentBar.previewFailed'))
        return
      }
      // Never issue an unbounded full-file read for a huge / unknown-size image
      // (H2) — point the user at download instead.
      if (!canPreviewImage(a)) {
        toastError(t('emailDetail.attachmentBar.tooLarge'))
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
        toastError(t('emailDetail.attachmentBar.previewFailed'))
      }
    },
    [thumbFailed, thumbById, queryClient, mailApi, t]
  )

  // "Download all" resolves the COMPLETE thread first (thread list + every
  // sibling's attachment.list via fetchQuery), then downloads — so nothing that
  // was still loading (or errored) at click time is silently dropped (H1). The
  // trigger button is also disabled until `fullyLoaded`, so this is belt +
  // suspenders; if any fetch fails the user gets an explicit partial warning.
  const downloadAll = useCallback(async (): Promise<void> => {
    let failed = false
    let sibIds = siblingIds
    if (threadEnabled) {
      try {
        const rows = await queryClient.fetchQuery({
          queryKey: qk.email.thread(threadId),
          queryFn: () => mailApi.email.listByThread(threadId),
          staleTime: 60_000
        })
        // Same scope rule as the render path — otherwise "Download all" would
        // save attachments from future replies the strip never displayed.
        sibIds = priorSiblingIds(rows ?? [], activeInternalId, activeDate)
      } catch {
        failed = true
      }
    }
    const ids: number[] = []
    for (const a of activeAttachments) {
      if (isVisibleAttachment(a)) ids.push(a.id)
    }
    const results = await Promise.allSettled(
      sibIds.map((id) =>
        queryClient.fetchQuery({
          queryKey: qk.attachment.list(id),
          queryFn: () => mailApi.attachment.list(id),
          staleTime: 60_000
        })
      )
    )
    results.forEach((r) => {
      if (r.status === 'rejected') {
        failed = true
        return
      }
      for (const a of r.value ?? []) {
        if (isVisibleAttachment(a)) ids.push(a.id)
      }
    })
    // Sequential: keeps the ~/Downloads collision-rename deterministic; there's
    // no bulk/zip IPC. Silent per file → one summary toast, not N.
    let saved = 0
    for (const id of ids) {
      if (await download(id, { silent: true })) saved += 1
    }
    if (failed || saved < ids.length) toastError(t('emailDetail.attachmentBar.partialFailed'))
    else if (saved > 0) toastSuccess(t('emailDetail.attachmentBar.savedAll', { n: saved }))
  }, [
    siblingIds,
    threadEnabled,
    threadId,
    queryClient,
    mailApi,
    activeInternalId,
    activeDate,
    activeAttachments,
    download,
    t
  ])

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
          {!fullyLoaded && <span className="text-ink-fg-3"> …</span>}
        </span>
        <button
          type="button"
          onClick={() => void downloadAll()}
          disabled={!fullyLoaded}
          className={cn(
            'ml-auto inline-flex items-center gap-1 px-2 py-1 rounded',
            'text-meta text-ink-fg-2 hover:text-ink-fg-1 hover:bg-ink-4',
            'transition-colors duration-fast',
            'disabled:opacity-50 disabled:cursor-wait disabled:hover:bg-transparent disabled:hover:text-ink-fg-2'
          )}
        >
          <Download size={12} strokeWidth={2} />
          {fullyLoaded
            ? t('emailDetail.attachmentBar.downloadAll')
            : t('emailDetail.attachmentBar.loading')}
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
          // The open message's own files vs. everything inherited from earlier
          // replies. Marked with the accent border + a "this message" source
          // label (theme v3: accent reads from --c-accent, so both themes and
          // every accent swap follow for free). Deliberately NOT --sel-wash —
          // that token is the *selection* signature (rows / nav), and these
          // cards aren't selectable; reusing it would blur the vocabulary.
          // Past cards keep their existing neutral treatment untouched.
          const isActiveSource = c.sourceId === activeInternalId
          return (
            <div
              key={`${c.sourceId}-${a.id}`}
              className={cn(
                'group relative flex flex-col w-44 shrink-0 overflow-hidden bg-ink-2',
                // Card tier radius (§18.3 --r-card = tile/card).
                'rounded-[var(--r-card)] border',
                isActiveSource ? 'border-coral/45' : 'border-ink-border'
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
                  {/* Source line. For the open message, sender · date is
                      redundant (the detail header right above already shows
                      From / Date), so it's replaced by the explicit marker. */}
                  {isActiveSource ? (
                    <div className="mt-0.5 text-meta text-coral truncate">
                      {t('emailDetail.attachmentBar.thisMessage')}
                    </div>
                  ) : (
                    src && (
                      <div className="mt-0.5 text-meta text-ink-fg-3 truncate">
                        {src.label}
                        {src.date && <span> · {formatRelativeTime(src.date)}</span>}
                      </div>
                    )
                  )}
                </div>
              </button>
              <div className="flex items-center gap-0.5 px-2 pb-1.5 pt-1">
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
