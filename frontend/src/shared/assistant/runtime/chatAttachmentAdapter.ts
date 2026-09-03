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
//
// P2-L5（design §1.4）—— send() 现在还多做一件事：**发送即入库**。两条分支都先把原字节写进
// 资料库的 `chat-attachments/{YYYY-MM}/`，再在 content 里并列挂一个 `data-library` part
// （气泡据此画 chip）。三条边界：
//   · 入库能力是**注入**的（`archiveIo`）。不传 = 一个字节都不上传、content 与本 lane 之前
//     逐字相同 —— 群聊 composer（GroupComposer，落法另有 lane）和既有单测走的就是这条。
//   · 入库失败**不阻断发送**：data part 照挂但 `archived:false`，气泡画「未归档」，文本预置
//     那条老路一点没动，模型看到的内容不变。
//   · `data-library` 不塞进封闭的 `FileUIPart`，走 assistant-ui 的 `{type:'data', name}`
//     —— react-ai-sdk 的 `toCreateMessage` 把它转成 UIMessage 的 `data-library` part
//     （仓里 `ai-gateway/compact.ts` 的 `data-compact` 是同款先例），零 CHAT_DB 迁移。

import type { AttachmentAdapter, CompleteAttachment, PendingAttachment } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import {
  readAttachment,
  type ChatAttachment,
  type ChatAttachmentArchiver
} from '@shared/lib/chat-attachments'
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

/** `data-library` part 的 data 载荷。气泡 chip 与深链 `/library?file={fileId}` 全靠它。
 *
 *  🔴 `archived:false` 是**一等状态**，不是「缺字段」：入库失败时这个 part 照挂，chip 画
 *  「未归档」告诉用户这份文件只在这一轮的上下文里、资料库里找不到。少了它，失败就是静默的。 */
export interface ChatLibraryPartData {
  /** 用户看到的文件名（入库改过名时是**库里那个**名字，chip 与磁盘一致）。 */
  name: string
  archived: boolean
  /** `library_file.id`，仅 `archived` 时有。 */
  fileId?: number
  /** 虚拟路径 `chat-attachments/{YYYY-MM}/{name}`，仅 `archived` 时有。 */
  path?: string
}

/** send() 时入库这一步的注入点。 */
export interface ChatAttachmentArchiveIo {
  archive: ChatAttachmentArchiver
  /** 当前会话 id。**新会话的第一条消息拿不到**（session 由 transport 在发送时懒创建），
   *  这时 `source_ref` 的会话段是空串 —— uiMessageId 本身是 uuid，反查照样唯一。 */
  getSessionId: () => number | null
}

/** 本批发送将要落到的 UIMessage id。
 *
 *  🔴 为什么要自己发这个 id：`source_ref='{sessionId}:{uiMessageId}'` 只有在等于持久化下来的
 *  `ui_message_json.$.id` 时才反查得到（`chat_db/messages.ts::findMessageRowIdByUiId` 就是按
 *  这个键查的）。而 assistant-ui 的调用次序是「先 send() 每个附件 → 再造消息」，等消息造好
 *  id 才由 AI SDK 生成，那时上传早发出去了。所以 id 在**第一个** send() 里现铸，随后由
 *  `useMailAgentAiSdkRuntime` 的 `toCreateMessage` 取走盖在消息上（AI SDK 的 `sendMessage`
 *  认 `uiMessage.id ?? generateId()`，给了就用给的）。
 *
 *  一批 = 一次 composer 发送：`base-composer-runtime-core` 用 `Promise.all` 把本次所有附件的
 *  send() 同步启动，`??=` 在第一个 await 之前跑完，所以同批共享一个 id、跨批不会串。 */
interface OutgoingMessageId {
  id: string
  /** 只有真入库成功过才盖 —— 全批都失败时消息 id 交回 AI SDK 生成，不留一个没人用的 uuid。 */
  used: boolean
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

/** 本批发送的 UIMessage id。uuid 而不是递增数：它要和 AI SDK 自己生成的 id 共处一个命名
 *  空间（同一会话里两种来源的消息交替出现），撞了就会把两条消息认成一条。 */
function newMessageId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** Error subtype for guardrail rejections that already surfaced their own toast —
 *  add() must not double-toast them under the generic read-failed catch. */
class AttachmentGuardrailError extends Error {}

function guardrailFail(key: string, fallback: string, options?: Record<string, unknown>): never {
  const message = i18n.t(key, { defaultValue: fallback, ...options })
  toastError(message)
  throw new AttachmentGuardrailError(message)
}

export interface MailAgentAttachmentAdapter extends AttachmentAdapter {
  /** 取走本批入库用的 UIMessage id 并清空（一次消费）。返回 null = 这批没有任何附件真的
   *  入库成功，消息 id 交回 AI SDK 生成。由 `useMailAgentAiSdkRuntime` 的
   *  `toCreateMessage` 在 send() 批次结束后立刻调用。 */
  takeArchivedMessageId(): string | null
}

/**
 * Build the MailAgent attachment adapter. `getBridge` is a live getter (the runtime
 * holds the panel callbacks in a ref) so chip add/remove never rebuilds the adapter.
 * `archiveIo` 缺省 = 不入库（行为与 P2-L5 之前逐字相同）。
 */
export function createMailAgentAttachmentAdapter(
  getBridge: () => AttachmentPanelBridge | null,
  io: PrepareImageIo = defaultIo,
  archiveIo: ChatAttachmentArchiveIo | null = null
): MailAgentAttachmentAdapter {
  // Prepared image payloads keyed by attachment id. Doubles as the pending-image
  // counter for the count guardrail: send()/remove() (incl. composer reset, which
  // calls remove for every pending attachment) delete their entry.
  const preparedImages = new Map<string, PreparedImagePayload>()
  let outgoing: OutgoingMessageId | null = null

  /** 入库一份附件，返回要挂在 content 上的 data part；未接入库能力 / 没有原始 File 时返回
   *  null（content 与从前逐字相同）。任何失败都落到 `archived:false`，绝不抛。 */
  async function archivePart(
    file: File | undefined,
    fallbackName: string
  ): Promise<{ type: 'data'; name: 'library'; data: ChatLibraryPartData } | null> {
    if (!archiveIo || !file) return null
    const batch = (outgoing ??= { id: newMessageId(), used: false })
    const sessionId = archiveIo.getSessionId()
    const result = await archiveIo.archive(file, `${sessionId ?? ''}:${batch.id}`)
    if (!result.ok) {
      return { type: 'data', name: 'library', data: { name: fallbackName, archived: false } }
    }
    batch.used = true
    return {
      type: 'data',
      name: 'library',
      data: {
        // 库里的真名（同名去重后可能是 `report_1.docx`），chip 点开看到的就是它。
        name: result.path.slice(result.path.lastIndexOf('/') + 1),
        archived: true,
        fileId: result.fileId,
        path: result.path
      }
    }
  }

  return {
    accept: '*',

    takeArchivedMessageId(): string | null {
      const batch = outgoing
      outgoing = null
      return batch?.used ? batch.id : null
    },

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
      // 入库对两条分支一视同仁：图片也归档（design §1.4「图片走同一条入库路径」）。
      const libraryPart = await archivePart(attachment.file, attachment.name)
      if (prepared) {
        preparedImages.delete(attachment.id)
        return {
          ...attachment,
          status: { type: 'complete' },
          // toCreateMessage maps {type:'file', data, mimeType, filename} → a
          // FileUIPart {type:'file', url, mediaType, filename} → gateway
          // convertToModelMessages → model image content.
          // 图片的 file part 与 data part **并列**，不是二选一：前者喂模型，后者画 chip。
          content: [
            {
              type: 'file',
              mimeType: prepared.mediaType,
              filename: attachment.name,
              data: prepared.dataUrl
            },
            ...(libraryPart ? [libraryPart] : [])
          ]
        }
      }
      // Panel-state entries ride body.injectedContext (buildAttachmentBlock →
      // untrusted-framed text block); empty content keeps the parts clean. The panel
      // clears its list via onConsumeInjected after the transport captured the block.
      // 非图片分支唯一多出来的东西就是这个 data part —— 模型侧一个字节都没变。
      return {
        ...attachment,
        status: { type: 'complete' },
        content: libraryPart ? [libraryPart] : []
      }
    }
  }
}
