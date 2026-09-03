// task 09-02 — generate_image: text → image, or (source images + text) → edited image, through the
// AI SDK `generateImage` and the IMAGE_GEN_MODEL providerRef the owner picked in Settings → AI.
//
// One tool, two modes, decided by `source_images`: empty → `/images/generations`, non-empty →
// `/images/edits` (the AI SDK switches endpoint on `prompt.images`). Only the two OpenAI-shaped
// provider protocols can serve it (providers.ts resolveImageModel); anything else is a typed error
// that points the user at Settings.
//
// Two source-reference forms, both resolved HERE (the model never handles bytes):
//   - a `file_id` returned by a previous generate_image call in THIS session (chain edits);
//   - `attached:last` / `attached:<n>` — the n-th image (1-based, conversation order) the user
//     attached in this session. Read from the AI SDK `messages` the execute options carry, so the
//     tool sees exactly the file parts the model saw.
//
// Storage: `<generatedDir>/<sessionId>/<uuid>.<ext>` (generatedDir = DATA_ROOT/data/generated,
// sibling of data/attachments). The tool result carries NO bytes — only `{file_id, mime, width,
// height, url}` per image; the renderer loads the file through the gateway's read-only
// `GET /api/ai/generated/:fileId` route (server.ts), which reuses `resolveGeneratedFilePath` below
// so the two sides can never disagree on what a valid id is.
//
// 🔴 `file_id` = `<sessionId>-<uuid>.<ext>` and is validated by a strict regex before it ever
//    touches a path: no separators, no dots outside the extension → traversal is structurally
//    impossible, and the belt below (resolved path must stay under generatedDir) is the second
//    lock. The session prefix also scopes chain edits: a file_id from another session is refused
//    (E_IMAGE_NOT_FOUND), so a session can only re-edit what it produced.
//
// Class 'outbound' (policy.ts): the prompt + the user's images egress to the image provider.
// manual_chat only, no grants key — that class row is the「headless 排除」the prd asks for.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve, sep } from 'node:path'

import { APICallError, generateImage, type ImageModel, type ModelMessage, type Tool } from 'ai'

import type { ApprovalGuard } from '../security/approval'
import { isProviderCredentialsError } from '../providerRef'
import { sanitizedUpstreamErrorMessage } from '../upstreamError'
import {
  auditedWriteTool,
  ToolExecutionError,
  type GatewayApprovalMode,
  type GatewayToolApprovalPrefs,
  type GatewayToolAuditCollector
} from './types'
import type { AgentContextMode } from './policy'
import { generateImageSchema, type GenerateImageInput } from './schemas'

/** Names of the image tools (eval catalog completeness gate extracts this array). */
export const GATEWAY_IMAGE_TOOL_NAMES = ['generate_image'] as const

export const GENERATE_IMAGE_TOOL_NAME = 'generate_image'

/** The URL prefix of the gateway's read-only image route (server.ts registers it). */
export const GENERATED_IMAGE_ROUTE_PREFIX = '/api/ai/generated/'

/** Everything the tool needs from the host (Electron main); nothing here is body-derived. */
export interface ImageGenToolDeps {
  /** IMAGE_GEN_MODEL providerRef as currently in .env (hot-read per assembly). null / '' →
   *  the tool registers but answers E_IMAGE_MODEL_NOT_CONFIGURED. */
  modelRef: string | null
  /** providers.ts resolveImageModel behind the main-process resolver. */
  resolveImageModel: (ref: string) => Promise<ImageModel>
  /** DATA_ROOT/data/generated — created lazily. */
  generatedDir: string
  /** The current chat session (folder + file_id namespace). null (session-less chat) → 0. */
  sessionId: number | null
}

const MIME_TO_EXT: Readonly<Record<string, GeneratedExt>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp'
}
const EXT_TO_MIME: Readonly<Record<GeneratedExt, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp'
}
type GeneratedExt = 'png' | 'jpg' | 'webp'

/** `<sessionId>-<uuid v4>.<ext>` — the ONLY shape the route / chain-edit lookup accept. */
const FILE_ID_RE =
  /^(\d{1,12})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(png|jpg|webp)$/

export interface ResolvedGeneratedFile {
  path: string
  mime: string
  sessionId: number
}

/** Map a file_id to its on-disk path under `generatedDir`, or null when the id is not a valid
 *  generated-file id OR the resolved path would escape the directory (belt behind the regex).
 *  Pure — no filesystem access; the caller stats / reads. Shared by the tool (chain edits) and
 *  the GET route. */
export function resolveGeneratedFilePath(
  generatedDir: string,
  fileId: string
): ResolvedGeneratedFile | null {
  const m = FILE_ID_RE.exec(fileId)
  if (!m) return null
  const [, sessionText, uuid, ext] = m as unknown as [string, string, string, GeneratedExt]
  const root = resolve(generatedDir)
  const path = resolve(root, sessionText, `${uuid}.${ext}`)
  if (!path.startsWith(root + sep)) return null
  return { path, mime: EXT_TO_MIME[ext], sessionId: Number(sessionText) }
}

/** Width/height from the file header — PNG (IHDR), JPEG (first SOFn marker), WebP (VP8 / VP8L /
 *  VP8X). null when the bytes are not one of those (the result then carries null dimensions —
 *  the card falls back to the requested size). */
export function readImageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // PNG: 8-byte signature, then IHDR chunk (length, 'IHDR', width u32be, height u32be).
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  // JPEG: SOI then marker segments; the first SOFn (C0–CF except C4/C8/CC) carries the size.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 <= bytes.length) {
      if (bytes[offset] !== 0xff) return null
      const marker = bytes[offset + 1]!
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        offset += 2
        continue
      }
      const segmentLength = view.getUint16(offset + 2)
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) }
      }
      offset += 2 + segmentLength
    }
    return null
  }
  // WebP: 'RIFF' .... 'WEBP' then a VP8 / VP8L / VP8X chunk.
  if (
    bytes.length >= 30 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!)
    if (chunk === 'VP8 ') {
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    }
    if (chunk === 'VP8L') {
      const b0 = bytes[21]!
      const b1 = bytes[22]!
      const b2 = bytes[23]!
      const b3 = bytes[24]!
      return {
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
      }
    }
    if (chunk === 'VP8X') {
      return {
        width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)),
        height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16))
      }
    }
  }
  return null
}

// ── source references ────────────────────────────────────────────────────────

type SourceRef = { kind: 'generated'; fileId: string } | { kind: 'attached'; index: number }

/** `attached:last` → index -1; `attached:<n>` (n ≥ 1) → n; a valid file_id → generated. Anything
 *  else → null (the tool answers E_IMAGE_SOURCE_INVALID naming the offending entry). */
export function parseSourceRef(raw: string): SourceRef | null {
  const text = raw.trim()
  if (FILE_ID_RE.test(text)) return { kind: 'generated', fileId: text }
  if (text === 'attached:last') return { kind: 'attached', index: -1 }
  const m = /^attached:([1-9]\d{0,2})$/.exec(text)
  if (m) return { kind: 'attached', index: Number(m[1]) }
  return null
}

interface SourceImage {
  bytes: Uint8Array
  mediaType: string
}

function decodeBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'))
}

/** Bytes out of one model-message file/image part's data field, whatever normalization the AI
 *  SDK applied (data: URL string, `{type:'url', url}` wrapper, raw base64, typed array). Remote
 *  http(s) URLs are NOT fetched (the gateway never does node:fetch on model-visible content). */
function bytesOfPartData(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (data instanceof URL) return bytesOfPartData(data.href)
  if (typeof data === 'string') {
    if (data.startsWith('data:')) {
      const comma = data.indexOf(',')
      if (comma === -1 || !data.slice(0, comma).includes(';base64')) return null
      return decodeBase64(data.slice(comma + 1))
    }
    if (/^https?:\/\//.test(data)) return null
    return decodeBase64(data)
  }
  if (data && typeof data === 'object') {
    const url = (data as { url?: unknown }).url
    if (typeof url === 'string') return bytesOfPartData(url)
  }
  return null
}

/** Every image the user attached in this conversation, in order (user messages only — the
 *  assistant's own image parts, if a provider ever emits them, are not「attached」). */
export function collectAttachedImages(messages: readonly ModelMessage[]): SourceImage[] {
  const out: SourceImage[] = []
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    for (const part of message.content as unknown as Array<Record<string, unknown>>) {
      let mediaType: string | undefined
      let data: unknown
      if (part.type === 'file' && typeof part.mediaType === 'string') {
        if (!part.mediaType.startsWith('image/')) continue
        mediaType = part.mediaType
        data = part.data
      } else if (part.type === 'image') {
        mediaType = typeof part.mediaType === 'string' ? part.mediaType : 'image/png'
        data = part.image
      } else {
        continue
      }
      const bytes = bytesOfPartData(data)
      if (bytes && bytes.length > 0) out.push({ bytes, mediaType })
    }
  }
  return out
}

// ── failure copy ─────────────────────────────────────────────────────────────

/** E_IMAGE_GENERATION_FAILED 的正文。脱敏基线（`HTTP <status> <name>`，绝不带上游 message /
 *  responseBody）之外补两件能自诊断的事实：请求打到了哪个端点、以及 404 的常见成因 —— 0903
 *  dogfood 里错误只有一句 `HTTP 404 AI_APICallError`，看不出是模型名写错还是那台中转压根没有
 *  图像端点（实测：同一 base 上 /v1/chat/completions 返 401 而 /v1/images/generations 返 404）。
 *  URL 只取 origin + pathname：有的 provider 把密钥放在查询串里，而端点本身已足够定位。 */
export function imageGenerationFailureMessage(err: unknown): string {
  const base = sanitizedUpstreamErrorMessage(err)
  if (!APICallError.isInstance(err)) return base
  let endpoint = ''
  try {
    const u = new URL(err.url)
    endpoint = ` (POST ${u.origin}${u.pathname})`
  } catch {
    /* provider 配错时 url 未必是绝对地址；少这一段不影响其余信息 */
  }
  if (err.statusCode !== 404) return `${base}${endpoint}`
  return (
    `${base}${endpoint} —— 该 provider 未提供 OpenAI 图像端点（/v1/images/generations），` +
    '请在「设置 → AI」换一个支持图像生成的 provider 或模型。'
  )
}

// ── the tool ─────────────────────────────────────────────────────────────────

export interface GeneratedImageRef {
  file_id: string
  mime: string
  width: number | null
  height: number | null
  url: string
}

export interface GenerateImageResult {
  mode: 'generate' | 'edit'
  model: string
  images: GeneratedImageRef[]
}

function extOf(mediaType: string): GeneratedExt {
  return MIME_TO_EXT[mediaType] ?? 'png'
}

export function createImageTools(
  collector: GatewayToolAuditCollector,
  guard: ApprovalGuard,
  deps: ImageGenToolDeps,
  opts: {
    a2uiEnabled?: boolean
    approvalMode?: GatewayApprovalMode
    /** 08-05 WP-11 — per-tool tier map of a MANUAL run (default auto; owner may set ask/deny). */
    toolApprovalPrefs?: GatewayToolApprovalPrefs['tools']
    oneShot?: boolean
    contextMode?: AgentContextMode
  } = {}
): Record<string, Tool> {
  const sessionId = deps.sessionId ?? 0
  const sessionDir = join(deps.generatedDir, String(sessionId))

  async function loadSources(
    refs: readonly string[],
    messages: readonly ModelMessage[]
  ): Promise<SourceImage[]> {
    const sources: SourceImage[] = []
    let attached: SourceImage[] | null = null
    for (const raw of refs) {
      const ref = parseSourceRef(raw)
      if (!ref) {
        throw new ToolExecutionError(
          'E_IMAGE_SOURCE_INVALID',
          `source_images entry "${raw}" is not a file_id from a previous generate_image result nor an attached:<n> / attached:last reference`
        )
      }
      if (ref.kind === 'generated') {
        const resolved = resolveGeneratedFilePath(deps.generatedDir, ref.fileId)
        if (!resolved || resolved.sessionId !== sessionId) {
          throw new ToolExecutionError(
            'E_IMAGE_NOT_FOUND',
            `generated image ${ref.fileId} does not belong to this session`
          )
        }
        let bytes: Uint8Array
        try {
          bytes = new Uint8Array(await readFile(resolved.path))
        } catch {
          throw new ToolExecutionError(
            'E_IMAGE_NOT_FOUND',
            `generated image ${ref.fileId} is no longer on disk`
          )
        }
        sources.push({ bytes, mediaType: resolved.mime })
        continue
      }
      attached ??= collectAttachedImages(messages)
      const picked = ref.index === -1 ? attached[attached.length - 1] : attached[ref.index - 1]
      if (!picked) {
        throw new ToolExecutionError(
          'E_IMAGE_NOT_FOUND',
          attached.length === 0
            ? 'the user has not attached any image in this conversation'
            : `attached image #${ref.index} does not exist (the user attached ${attached.length})`
        )
      }
      sources.push(picked)
    }
    return sources
  }

  const generate_image = auditedWriteTool<GenerateImageInput>(
    {
      name: 'generate_image',
      description:
        'Generate a new image from a text prompt, or EDIT existing images when source_images is ' +
        'non-empty (the sources plus the prompt go to the image model). Uses the image model the ' +
        'user configured in Settings → AI (IMAGE_GEN_MODEL); if none is configured the call fails ' +
        'with E_IMAGE_MODEL_NOT_CONFIGURED — tell the user to pick one there. source_images ' +
        'entries are either a file_id returned by a previous generate_image call in this ' +
        'conversation (to keep editing a result), or "attached:last" / "attached:<n>" for the ' +
        'image(s) the user attached to their messages (1-based, in conversation order). Write the ' +
        'prompt in the language the image should follow; describe subject, style and composition ' +
        'concretely. size is "<width>x<height>" (model-dependent, e.g. 1024x1024 / 1024x1536 / ' +
        '1536x1024; omit for the model default). n ≤ 2. The result carries file references and a ' +
        'url per image — the chat renders them as an image card; never try to print the image ' +
        'bytes yourself, just refer to the picture in your reply.',
      inputSchema: generateImageSchema,
      risk: 'edit',
      a2uiEnabled: opts.a2uiEnabled,
      approvalMode: opts.approvalMode,
      toolApprovalPrefs: opts.toolApprovalPrefs,
      oneShot: opts.oneShot,
      contextMode: opts.contextMode,
      run: async (input, { signal, messages }): Promise<GenerateImageResult> => {
        const modelRef = deps.modelRef?.trim() ?? ''
        if (modelRef.length === 0) {
          throw new ToolExecutionError(
            'E_IMAGE_MODEL_NOT_CONFIGURED',
            'No image model is configured. Ask the user to pick one under Settings → AI → 图像生成模型 (IMAGE_GEN_MODEL).'
          )
        }
        let model: ImageModel
        try {
          model = await deps.resolveImageModel(modelRef)
        } catch (e) {
          const code = (e as { code?: unknown }).code
          if (isProviderCredentialsError(e) || code === 'E_IMAGE_MODEL_UNSUPPORTED') {
            throw new ToolExecutionError(code as string, (e as Error).message)
          }
          throw e
        }
        const sources = await loadSources(input.source_images, messages)
        const mode: GenerateImageResult['mode'] = sources.length > 0 ? 'edit' : 'generate'
        let generated
        try {
          generated = await generateImage({
            model,
            prompt:
              mode === 'edit'
                ? { images: sources.map((s) => s.bytes), text: input.prompt }
                : input.prompt,
            n: input.n,
            ...(input.size ? { size: input.size as `${number}x${number}` } : {}),
            abortSignal: signal
          })
        } catch (e) {
          if (signal?.aborted) throw e
          // Upstream bodies can echo request headers (api key) — never forward them verbatim.
          throw new ToolExecutionError(
            'E_IMAGE_GENERATION_FAILED',
            imageGenerationFailureMessage(e)
          )
        }
        await mkdir(sessionDir, { recursive: true })
        const images: GeneratedImageRef[] = []
        for (const file of generated.images) {
          const fileName = `${randomUUID()}.${extOf(file.mediaType)}`
          const fileId = `${sessionId}-${fileName}`
          await writeFile(join(sessionDir, fileName), file.uint8Array)
          const dims = readImageDimensions(file.uint8Array)
          images.push({
            file_id: fileId,
            mime: EXT_TO_MIME[extOf(file.mediaType)],
            width: dims?.width ?? null,
            height: dims?.height ?? null,
            url: `${GENERATED_IMAGE_ROUTE_PREFIX}${fileId}`
          })
        }
        return { mode, model: modelRef, images }
      }
    },
    collector,
    guard
  )

  return { generate_image }
}
