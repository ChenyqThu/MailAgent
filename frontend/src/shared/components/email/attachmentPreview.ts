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
