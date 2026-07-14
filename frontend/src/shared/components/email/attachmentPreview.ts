// Shared attachment-preview helpers used by AttachmentList (per-message grid)
// and ThreadAttachmentBar (thread-wide strip). Kept in a plain module — not a
// component file — so exporting them doesn't trip react-refresh
// (only-export-components).

import type { ComponentType } from 'react'
import { FileText, Image as ImageIcon, Paperclip } from 'lucide-react'

import type { EmailDetail } from '@shared/api/types'

type Attachment = NonNullable<EmailDetail['attachments']>[number]

export interface IconTone {
  Icon: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>
  bg: string
  border: string
  text: string
}

// 1 MB cap on inline thumbnails: `readDataUrl` base64-inflates a file ~1.4× over
// the IPC boundary, so anything larger falls back to a type icon rather than
// ballooning memory/latency. Both attachment surfaces share the cutoff.
export const THUMBNAIL_MAX_BYTES = 1024 * 1024

// Preview opens the FULL file in the lightbox (readDataUrl → base64 over IPC),
// so it needs a much higher ceiling than the thumbnail cap but still a bounded
// one — a multi-hundred-MB image would OOM the renderer. Images above this, or
// whose size we don't know (can't bound the read), are not previewable and the
// user is pointed at download instead.
export const PREVIEW_MAX_BYTES = 25 * 1024 * 1024

// How many thumbnails one surface fetches eagerly. Beyond this, cards show the
// type icon and only read the data URL when the user clicks preview — caps the
// readDataUrl fan-out on very long threads / attachment-heavy mails.
export const THUMBNAIL_RENDER_LIMIT = 12

// What counts as an image: content-type first, then a filename-extension
// fallback for rows where the reader dropped content_type.
export function isImageAttachment(att: {
  content_type?: string | null
  filename: string
}): boolean {
  const ct = (att.content_type ?? '').toLowerCase()
  if (ct.startsWith('image/')) return true
  return /\.(png|jpe?g|gif|webp|heic|svg)$/.test(att.filename.toLowerCase())
}

// Can we safely open this image full-size in the lightbox? Requires a known
// size within PREVIEW_MAX_BYTES — unknown size is treated as un-previewable so
// we never issue an unbounded readDataUrl.
export function canPreviewImage(att: {
  content_type?: string | null
  filename: string
  size_bytes?: number | null
}): boolean {
  return (
    isImageAttachment(att) &&
    typeof att.size_bytes === 'number' &&
    att.size_bytes <= PREVIEW_MAX_BYTES
  )
}

// readDataUrl returns null when the file isn't on disk yet / a read blips.
// Treating that as a successful empty result lets React Query cache it forever
// (staleTime:Infinity), so the thumbnail never recovers once the file lands.
// Throw instead → the query becomes `error` (retryable), not a stuck success.
export async function readDataUrlOrThrow(
  read: (id: number) => Promise<string | null>,
  id: number
): Promise<string> {
  const url = await read(id)
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error(`attachment ${id}: no data url`)
  }
  return url
}

export function pickIconTone(att: Attachment): IconTone {
  const ct = (att.content_type ?? '').toLowerCase()
  const name = att.filename.toLowerCase()
  if (isImageAttachment(att)) {
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
