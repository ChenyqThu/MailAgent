// issue #61 Lane 3 (A2) — MailAgent AttachmentAdapter for the assistant-ui runtime.
//
// Replaces react-ai-sdk's default vercelAttachmentAdapter (which base64s EVERY file
// into the message) with a split policy that unifies the paperclip / paste / drop
// entry points onto ONE pipeline:
//
//   · image/*   → prepared into a bounded data URL at add() (guardrails below) and
//                 sent as a real file part → the model actually sees the image.
//                 This preserves what the built-in paste already did on the email
//                 composer — returning empty content here would be a regression.
//   · everything else → the Sprint-14 injectedContext path, byte-identical
//                 semantics: readAttachment (text read + 5000-char cap + 5MB
//                 oversized→null) feeds the PANEL state via the bridge, the panel's
//                 buildAttachmentBlock prepends the untrusted-framed block at send,
//                 and send() returns EMPTY content so nothing rides the parts.
//
// Guardrails (must ship with the UI — the gateway rejects bodies > 8 MiB
// (MAX_JSON_BODY_BYTES) with a 413, the data URL persists into CHAT_DB via
// ui_message_json, and a session reload re-sends every historical image each turn):
//   · at most CHAT_IMAGE_MAX_COUNT pending images per message (the built-in paste
//     handler Promise.all's every clipboard file with no cap),
//   · source file ≤ CHAT_IMAGE_MAX_SOURCE_BYTES (decode memory guard),
//   · long edge downscaled to CHAT_IMAGE_MAX_EDGE_PX / large sources re-encoded to
//     JPEG, with a final payload belt on the resulting data URL length.
//
// add() owns its failure surface (toast + rethrow): the built-in paste handler and
// the Dropzone primitive only console.error a rejected addAttachment, so without a
// toast here a failed read would be silent (regression face #8).

import type { AttachmentAdapter, CompleteAttachment, PendingAttachment } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import { readAttachment, type ChatAttachment } from '@shared/lib/chat-attachments'
import { toastError } from '@shared/state/toast'

/** Max pending image attachments per message. 4 × ~1 MB base64 leaves ample room
 *  under the gateway's 8 MiB body cap even with a few turns of image history. */
export const CHAT_IMAGE_MAX_COUNT = 4
/** Reject image sources above this before decoding (renderer memory guard). */
export const CHAT_IMAGE_MAX_SOURCE_BYTES = 10 * 1024 * 1024
/** Downscale target for the long edge (~Anthropic vision sweet spot). */
export const CHAT_IMAGE_MAX_EDGE_PX = 1568
/** Sources above this are re-encoded to JPEG even when the edge is small (a 1500px
 *  8 MB PNG would otherwise ship ~10.7 MB of base64 and 413 the gateway). */
export const CHAT_IMAGE_REENCODE_BYTES = 1 * 1024 * 1024
export const CHAT_IMAGE_JPEG_QUALITY = 0.85
/** Final belt on the prepared data URL length (chars ≈ bytes). Only reachable when
 *  canvas re-encode is unavailable (test envs / exotic formats) — the downscale
 *  path lands far below this. */
export const CHAT_IMAGE_MAX_PAYLOAD_CHARS = 3 * 1024 * 1024

/** Panel-state hookup: non-image attachments keep feeding the panel's
 *  ChatAttachment[] (the buildInjectedContext source). Same id on both sides, so a
 *  chip remove (adapter.remove) maps 1:1 onto the panel entry (regression face #5). */
export interface AttachmentPanelBridge {
  onAdd: (attachment: ChatAttachment) => void
  onRemove: (id: string) => void
}

export interface PreparedImagePayload {
  dataUrl: string
  mediaType: string
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

/** Decode + downscale/re-encode when needed. Returns null to mean "pass the original
 *  bytes through" — either the image is already small (edge ≤ max AND bytes ≤
 *  re-encode threshold) or this environment can't decode it (no createImageBitmap /
 *  no canvas, e.g. happy-dom tests). Animated GIFs above the thresholds flatten to a
 *  static JPEG — models only ever see one frame anyway. */
export async function renderDownscaledImage(file: File): Promise<PreparedImagePayload | null> {
  try {
    if (typeof createImageBitmap !== 'function') return null
    const bmp = await createImageBitmap(file)
    try {
      const edge = Math.max(bmp.width, bmp.height)
      if (edge <= CHAT_IMAGE_MAX_EDGE_PX && file.size <= CHAT_IMAGE_REENCODE_BYTES) return null
      const scale = Math.min(1, CHAT_IMAGE_MAX_EDGE_PX / edge)
      const w = Math.max(1, Math.round(bmp.width * scale))
      const h = Math.max(1, Math.round(bmp.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      // JPEG has no alpha channel — matte transparent PNGs on white, not black. (CSS keyword —
      // canvas pixel matte, not a themed surface; keeps mailagent/no-raw-hex clean.)
      ctx.fillStyle = 'white'
      ctx.fillRect(0, 0, w, h)
      ctx.drawImage(bmp, 0, 0, w, h)
      return {
        dataUrl: canvas.toDataURL('image/jpeg', CHAT_IMAGE_JPEG_QUALITY),
        mediaType: 'image/jpeg'
      }
    } finally {
      bmp.close?.()
    }
  } catch {
    return null
  }
}

/** IO seams injectable for tests (happy-dom has neither createImageBitmap nor canvas). */
export interface PrepareImageIo {
  renderDownscaledImage: (file: File) => Promise<PreparedImagePayload | null>
  fileToDataUrl: (file: File) => Promise<string>
}

const defaultIo: PrepareImageIo = { renderDownscaledImage, fileToDataUrl }

export async function prepareImagePayload(
  file: File,
  io: PrepareImageIo = defaultIo
): Promise<PreparedImagePayload> {
  const scaled = await io.renderDownscaledImage(file)
  if (scaled) return scaled
  // Pass-through: original bytes as a data URL (small images keep exact fidelity —
  // pinned by composer_paste_image.test.tsx's byte-equality assertion).
  return { dataUrl: await io.fileToDataUrl(file), mediaType: file.type || 'image/png' }
}

function newAttachmentId(file: File): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${file.name}-${file.size}-${Date.now()}`
}

/** Error subtype for guardrail rejections that already surfaced their own toast —
 *  add() must not double-toast them under the generic read-failed catch. */
class AttachmentGuardrailError extends Error {}

function guardrailFail(key: string, fallback: string, options?: Record<string, unknown>): never {
  const message = i18n.t(key, { defaultValue: fallback, ...options })
  toastError(message)
  throw new AttachmentGuardrailError(message)
}

/**
 * Build the MailAgent attachment adapter. `getBridge` is a live getter (the runtime
 * holds the panel callbacks in a ref) so chip add/remove never rebuilds the adapter.
 */
export function createMailAgentAttachmentAdapter(
  getBridge: () => AttachmentPanelBridge | null,
  io: PrepareImageIo = defaultIo
): AttachmentAdapter {
  // Prepared image payloads keyed by attachment id. Doubles as the pending-image
  // counter for the count guardrail: send()/remove() (incl. composer reset, which
  // calls remove for every pending attachment) delete their entry.
  const preparedImages = new Map<string, PreparedImagePayload>()

  return {
    accept: '*',

    async add({ file }): Promise<PendingAttachment> {
      if (isImageFile(file)) {
        if (preparedImages.size >= CHAT_IMAGE_MAX_COUNT) {
          // ICU interpolation (i18next-icu) — single-brace {max}.
          guardrailFail('chat.attachment.tooManyImages', '一次最多附 {max} 张图片', {
            max: CHAT_IMAGE_MAX_COUNT
          })
        }
        if (file.size > CHAT_IMAGE_MAX_SOURCE_BYTES) {
          guardrailFail('chat.attachment.imageTooLarge', '图片过大，无法发送')
        }
        let payload: PreparedImagePayload
        try {
          payload = await prepareImagePayload(file, io)
        } catch (e) {
          toastError(i18n.t('chat.attachment.readFailed', { defaultValue: '无法读取附件' }))
          throw e
        }
        if (payload.dataUrl.length > CHAT_IMAGE_MAX_PAYLOAD_CHARS) {
          guardrailFail('chat.attachment.imageTooLarge', '图片过大，无法发送')
        }
        const id = newAttachmentId(file)
        preparedImages.set(id, payload)
        return {
          id,
          type: 'image',
          name: file.name,
          contentType: file.type || payload.mediaType,
          file,
          status: { type: 'requires-action', reason: 'composer-send' }
        }
      }

      // Text / non-image binary — the Sprint-14 pipeline, unchanged semantics.
      let chatAttachment: ChatAttachment
      try {
        chatAttachment = await readAttachment(file)
      } catch (e) {
        toastError(i18n.t('chat.attachment.readFailed', { defaultValue: '无法读取附件' }))
        throw e
      }
      getBridge()?.onAdd(chatAttachment)
      return {
        id: chatAttachment.id,
        type: 'file',
        name: file.name,
        contentType: file.type,
        file,
        status: { type: 'requires-action', reason: 'composer-send' }
      }
    },

    async remove(attachment): Promise<void> {
      preparedImages.delete(attachment.id)
      // No-op for image ids (never bridged) — harmless filter miss.
      getBridge()?.onRemove(attachment.id)
    },

    async send(attachment): Promise<CompleteAttachment> {
      const prepared = preparedImages.get(attachment.id)
      if (prepared) {
        preparedImages.delete(attachment.id)
        return {
          ...attachment,
          status: { type: 'complete' },
          // toCreateMessage maps {type:'file', data, mimeType, filename} → a
          // FileUIPart {type:'file', url, mediaType, filename} → gateway
          // convertToModelMessages → model image content.
          content: [
            {
              type: 'file',
              mimeType: prepared.mediaType,
              filename: attachment.name,
              data: prepared.dataUrl
            }
          ]
        }
      }
      // Panel-state entries ride body.injectedContext (buildAttachmentBlock →
      // untrusted-framed text block); empty content keeps the parts clean. The panel
      // clears its list via onConsumeInjected after the transport captured the block.
      return { ...attachment, status: { type: 'complete' }, content: [] }
    }
  }
}
