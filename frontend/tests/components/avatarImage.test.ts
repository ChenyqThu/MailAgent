// 0804 dogfood WP7 —— 上传头像的客户端处理（file → 裁切 → 降采样 → webp data URI）。
//
// canvas / createImageBitmap 在 node 与 happy-dom 下都不存在，所以真正会出错的逻辑
// （尺寸闸、质量阶梯、裁切几何、字节数换算）全部抽在 avatarImage.ts 里靠注入 deps 测；
// 组件那层只需 mock 这一个函数。
import { describe, expect, test, vi } from 'vitest'

import {
  AVATAR_IMAGE_EDGE,
  AVATAR_IMAGE_MAX_BYTES,
  AVATAR_IMAGE_MAX_SOURCE_BYTES,
  dataUriByteLength,
  fileToAvatarImage,
  squareCrop,
  type AvatarImageBitmap,
  type AvatarImageDeps
} from '../../src/shared/components/agents/avatarImage'

/** 生成解码后正好 `bytes` 字节的 webp data URI。 */
function dataUriOf(bytes: number): string {
  return `data:image/webp;base64,${Buffer.alloc(bytes).toString('base64')}`
}

/** node 里没有 File 构造器的 size/type 语义保证，用最小 stub（本模块只读这两个字段）。 */
function fakeFile(type: string, size: number): File {
  return { type, size } as File
}

function deps(
  encode: (bitmap: AvatarImageBitmap, crop: unknown, edge: number, quality: number) => string,
  bitmap: AvatarImageBitmap = { width: 1200, height: 800 }
): AvatarImageDeps {
  return { decode: () => Promise.resolve(bitmap), encode } as AvatarImageDeps
}

describe('squareCrop — 居中方形裁切窗口', () => {
  test('横图取短边并水平居中；竖图垂直居中；正方零偏移', () => {
    expect(squareCrop(1200, 800)).toEqual({ sx: 200, sy: 0, size: 800 })
    expect(squareCrop(800, 1200)).toEqual({ sx: 0, sy: 200, size: 800 })
    expect(squareCrop(512, 512)).toEqual({ sx: 0, sy: 0, size: 512 })
  })
})

describe('dataUriByteLength — 量的是解码后字节（后端量的也是这个数）', () => {
  test('三种 padding 形态都准', () => {
    for (const bytes of [1, 2, 3, 999, 150 * 1024]) {
      expect(dataUriByteLength(dataUriOf(bytes))).toBe(bytes)
    }
  })
})

describe('fileToAvatarImage — 闸与降级', () => {
  test('非图片 MIME 直接拒，且不进解码', async () => {
    const decode = vi.fn()
    const result = await fileToAvatarImage(fakeFile('application/pdf', 1024), {
      decode,
      encode: () => ''
    })
    expect(result).toEqual({ ok: false, reason: 'not_image' })
    expect(decode).not.toHaveBeenCalled()
  })

  test('源文件超 10MB 直接拒，且不进解码（解一张 50MB RAW 会卡住渲染进程）', async () => {
    const decode = vi.fn()
    const result = await fileToAvatarImage(
      fakeFile('image/png', AVATAR_IMAGE_MAX_SOURCE_BYTES + 1),
      { decode, encode: () => '' }
    )
    expect(result).toEqual({ ok: false, reason: 'source_too_large' })
    expect(decode).not.toHaveBeenCalled()
  })

  test('解码抛错 → decode_failed（不把异常抛给调用方）', async () => {
    const result = await fileToAvatarImage(fakeFile('image/svg+xml', 100), {
      decode: () => Promise.reject(new Error('no intrinsic size')),
      encode: () => ''
    })
    expect(result).toEqual({ ok: false, reason: 'decode_failed' })
  })

  test('首档就够小 → 只编码一次，返回 image 形态 + 字节数；bitmap.close 被调用', async () => {
    const encode = vi.fn(() => dataUriOf(20 * 1024))
    const close = vi.fn()
    const result = await fileToAvatarImage(
      fakeFile('image/png', 4096),
      deps(encode, { width: 1200, height: 800, close })
    )
    expect(result).toEqual({
      ok: true,
      avatar: { type: 'image', data: dataUriOf(20 * 1024) },
      bytes: 20 * 1024
    })
    expect(encode).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  test('首档超限 → 沿质量阶梯降级，命中第一档 ≤150KB 即停', async () => {
    const sizes = [200 * 1024, 160 * 1024, 90 * 1024]
    const qualities: number[] = []
    const encode = vi.fn((_b: AvatarImageBitmap, _c: unknown, _e: number, quality: number) => {
      qualities.push(quality)
      return dataUriOf(sizes[qualities.length - 1])
    })
    const result = await fileToAvatarImage(fakeFile('image/jpeg', 4_000_000), deps(encode))
    expect(result.ok).toBe(true)
    expect(result.ok && result.bytes).toBe(90 * 1024)
    expect(encode).toHaveBeenCalledTimes(3)
    // 阶梯确实是**递减**的（写反了会先出最糊的那档）。
    expect(qualities).toEqual([...qualities].sort((a, b) => b - a))
  })

  test('压到最低质量仍超顶 → too_large（不静默落一张超限图）', async () => {
    const encode = vi.fn(() => dataUriOf(AVATAR_IMAGE_MAX_BYTES + 1))
    const result = await fileToAvatarImage(fakeFile('image/png', 4096), deps(encode))
    expect(result).toEqual({ ok: false, reason: 'too_large' })
    expect(encode.mock.calls.length).toBeGreaterThan(1)
  })

  test('正好 150KB 放行（边界不是 off-by-one，且与后端硬顶同值）', async () => {
    const result = await fileToAvatarImage(
      fakeFile('image/png', 4096),
      deps(() => dataUriOf(AVATAR_IMAGE_MAX_BYTES))
    )
    expect(result.ok).toBe(true)
  })

  test('小图不放大：edge = min(256, 短边)', async () => {
    const edges: number[] = []
    await fileToAvatarImage(
      fakeFile('image/png', 4096),
      deps(
        (_b, _c, edge) => {
          edges.push(edge)
          return dataUriOf(1024)
        },
        { width: 64, height: 96 }
      )
    )
    expect(edges).toEqual([64])

    edges.length = 0
    await fileToAvatarImage(
      fakeFile('image/png', 4096),
      deps(
        (_b, _c, edge) => {
          edges.push(edge)
          return dataUriOf(1024)
        },
        { width: 4000, height: 3000 }
      )
    )
    expect(edges).toEqual([AVATAR_IMAGE_EDGE])
  })

  test('零尺寸位图 → decode_failed（不去画一张 0×0 的画布）', async () => {
    const encode = vi.fn()
    const result = await fileToAvatarImage(
      fakeFile('image/png', 4096),
      deps(encode, { width: 0, height: 0 })
    )
    expect(result).toEqual({ ok: false, reason: 'decode_failed' })
    expect(encode).not.toHaveBeenCalled()
  })
})
