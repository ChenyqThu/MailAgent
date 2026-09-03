// 从 ImageGenCard.tsx 拆出（_cardShell.lib.ts 先例）：react-refresh/only-export-components 要求一个
// 文件只导出组件。本文件是图片卡的**纯逻辑**面（tool part args / result 的读法、占位比例、绝对
// URL、重试文案），零 JSX —— 组件在 ImageGenCard.tsx，两边合起来是一张卡。

import { resolveAiGatewayBaseUrl } from '../../runtime/flags'

export interface ImageGenInput {
  prompt: string
  size: string | null
  sourceCount: number
}

export interface GeneratedImageView {
  fileId: string
  url: string
  width: number | null
  height: number | null
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** The tool input (model args). While the args are still streaming `args` may be partial and
 *  `argsText` unparseable — every field degrades to empty rather than throwing. */
export function readImageGenInput(args: unknown, argsText: string | undefined): ImageGenInput {
  let obj = asRecord(args)
  if (!obj && argsText) {
    try {
      obj = asRecord(JSON.parse(argsText))
    } catch {
      obj = null
    }
  }
  const prompt = typeof obj?.prompt === 'string' ? obj.prompt : ''
  const size = typeof obj?.size === 'string' && /^\d+x\d+$/.test(obj.size) ? obj.size : null
  const sources = Array.isArray(obj?.source_images) ? obj.source_images.length : 0
  return { prompt, size, sourceCount: sources }
}

/** The tool result's image references, or [] (error results / pre-result phases). */
export function readImageGenOutput(result: unknown): GeneratedImageView[] {
  const obj = asRecord(result)
  const images = Array.isArray(obj?.images) ? obj.images : []
  const out: GeneratedImageView[] = []
  for (const raw of images) {
    const row = asRecord(raw)
    if (!row || typeof row.file_id !== 'string' || typeof row.url !== 'string') continue
    out.push({
      fileId: row.file_id,
      url: row.url,
      width: typeof row.width === 'number' ? row.width : null,
      height: typeof row.height === 'number' ? row.height : null
    })
  }
  return out
}

/** `aspect-ratio` for the placeholder from the requested size — 1:1 when unknown. */
export function placeholderAspect(size: string | null): string {
  const m = size ? /^(\d+)x(\d+)$/.exec(size) : null
  if (!m) return '1 / 1'
  const w = Number(m[1])
  const h = Number(m[2])
  return w > 0 && h > 0 ? `${w} / ${h}` : '1 / 1'
}

/** Absolute URL of a generated image: the tool result's gateway-relative `url` + the renderer's
 *  gateway base (`''` on the web build = same origin — serve-api's ai_gateway_proxy forwards
 *  GET /api/ai/generated/{file_id} to the gateway). */
export function absoluteImageUrl(url: string): string {
  return `${resolveAiGatewayBaseUrl() ?? ''}${url}`
}

/** The prompt re-sent by 「重试」— phrased as a user request so the model calls the tool again. */
export function buildRetryPrompt(
  t: (key: string, opts?: Record<string, unknown>) => string,
  prompt: string
): string {
  return t('chat.imageGenCard.retryPrompt', { prompt })
}
