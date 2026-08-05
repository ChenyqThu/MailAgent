// 0804 dogfood WP7 —— 用户上传头像的客户端处理（file → 居中方形裁切 → 降采样 ≤256×256 →
// webp data URI）。owner 拍板 base64 内嵌：头像随 `report_agent.avatar_json` 一起走既有
// PATCH，不引入附件存储/静态服务/清理 GC 三件套。
//
// 独立成模块（不写进组件）的原因：canvas / createImageBitmap 在 happy-dom 下都不存在，
// 组件测试只能 mock 这一层；而尺寸闸、质量阶梯、裁切几何这些真正会错的逻辑，靠注入 deps
// 就能在 node 环境里逐条测到。

import type { AgentAvatarImage } from '@shared/api/types'

/** 输出边长上限（正方形）。源图小于它时**不放大**（放大只会让字节变大、观感不变）。 */
export const AVATAR_IMAGE_EDGE = 256
/** 解码后字节硬顶；后端 `src/reports/wire.py` 复核同一上限。 */
export const AVATAR_IMAGE_MAX_BYTES = 150 * 1024
/** 源文件上限：超过直接拒，不进解码（一张 50MB 的 RAW 能把渲染进程卡住好几秒）。 */
export const AVATAR_IMAGE_MAX_SOURCE_BYTES = 10 * 1024 * 1024
export const AVATAR_IMAGE_MIME = 'image/webp'
/** 质量阶梯：从高到低试，第一档 ≤150KB 即采用。256×256 的 webp 常态在 10-30KB，
 *  实际几乎恒在第一档命中；阶梯是给极端噪声图兜底的，不是常规路径。 */
const QUALITY_LADDER = [0.92, 0.8, 0.65, 0.5]

export type AvatarImageFailure =
  /** 不是图片（MIME 前缀不对） */
  | 'not_image'
  /** 源文件超过 AVATAR_IMAGE_MAX_SOURCE_BYTES */
  | 'source_too_large'
  /** 解码/绘制失败（损坏文件、SVG 无固有尺寸、canvas 不可用……） */
  | 'decode_failed'
  /** 压到最低质量仍超 AVATAR_IMAGE_MAX_BYTES */
  | 'too_large'

export type AvatarImageResult =
  | { ok: true; avatar: AgentAvatarImage; bytes: number }
  | { ok: false; reason: AvatarImageFailure }

/** 解码后的位图。只声明本模块真正用到的成员，好让测试注入普通对象。 */
export interface AvatarImageBitmap {
  readonly width: number
  readonly height: number
  close?: () => void
}

export interface SquareCrop {
  sx: number
  sy: number
  size: number
}

export interface AvatarImageDeps {
  decode: (file: Blob) => Promise<AvatarImageBitmap>
  encode: (bitmap: AvatarImageBitmap, crop: SquareCrop, edge: number, quality: number) => string
}

/** 居中方形裁切窗口（取短边）。 */
export function squareCrop(width: number, height: number): SquareCrop {
  const size = Math.min(width, height)
  return { sx: Math.floor((width - size) / 2), sy: Math.floor((height - size) / 2), size }
}

/** data URI 的**解码后**字节数（后端量的也是这个数，不是 base64 串长）。 */
export function dataUriByteLength(dataUri: string): number {
  const base64 = dataUri.slice(dataUri.indexOf(',') + 1)
  if (!base64) return 0
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

/** 浏览器（Electron renderer）实现。`imageOrientation: 'from-image'` 显式吃掉手机照片的
 *  EXIF 旋转 —— 否则竖拍头像会躺着。 */
export const browserAvatarImageDeps: AvatarImageDeps = {
  decode: (file) => createImageBitmap(file, { imageOrientation: 'from-image' }),
  encode: (bitmap, crop, edge, quality) => {
    const canvas = document.createElement('canvas')
    canvas.width = edge
    canvas.height = edge
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d context unavailable')
    ctx.drawImage(
      bitmap as unknown as CanvasImageSource,
      crop.sx,
      crop.sy,
      crop.size,
      crop.size,
      0,
      0,
      edge,
      edge
    )
    return canvas.toDataURL(AVATAR_IMAGE_MIME, quality)
  }
}

/** 文件 → 可落库的上传态头像。失败恒返回 reason（不抛），调用方按 reason 出人话文案。 */
export async function fileToAvatarImage(
  file: File,
  deps: AvatarImageDeps = browserAvatarImageDeps
): Promise<AvatarImageResult> {
  if (!file.type.startsWith('image/')) return { ok: false, reason: 'not_image' }
  if (file.size > AVATAR_IMAGE_MAX_SOURCE_BYTES) return { ok: false, reason: 'source_too_large' }

  let bitmap: AvatarImageBitmap
  try {
    bitmap = await deps.decode(file)
  } catch {
    return { ok: false, reason: 'decode_failed' }
  }

  try {
    const crop = squareCrop(bitmap.width, bitmap.height)
    if (!(crop.size > 0)) return { ok: false, reason: 'decode_failed' }
    const edge = Math.min(AVATAR_IMAGE_EDGE, crop.size)
    for (const quality of QUALITY_LADDER) {
      let dataUri: string
      try {
        dataUri = deps.encode(bitmap, crop, edge, quality)
      } catch {
        return { ok: false, reason: 'decode_failed' }
      }
      const bytes = dataUriByteLength(dataUri)
      if (bytes > 0 && bytes <= AVATAR_IMAGE_MAX_BYTES) {
        return { ok: true, avatar: { type: 'image', data: dataUri }, bytes }
      }
      if (bytes <= 0) return { ok: false, reason: 'decode_failed' }
    }
    return { ok: false, reason: 'too_large' }
  } finally {
    bitmap.close?.()
  }
}
