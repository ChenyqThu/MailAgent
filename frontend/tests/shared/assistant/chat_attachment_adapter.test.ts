// @vitest-environment happy-dom
//
// issue #61 Lane 3 (A2) — MailAgent AttachmentAdapter (chatAttachmentAdapter.ts) unit surface:
//
//   · split policy: image → bounded data-URL file part at send(); text/binary → the Sprint-14
//     panel injectedContext path（readAttachment 语义逐条保住：文本读取 / 5000 截断 / 5MB
//     oversized→content null），send() 返回空 content —— 回归面 #1/#2/#3。
//   · id sync: 桥接进 panel state 的 ChatAttachment 与 composer attachment 同 id，remove()
//     1:1 反映射 —— 回归面 #5 的幽灵 chip 防线。
//   · guardrails（护栏与 UI 同批）：张数上限 / 源文件大小上限 / 长边降采样管线（io 注入）/
//     最终 payload 兜底 —— 每条失败都出 toast（回归面 #8：内置 paste 只 console.error）。
//
// happy-dom 无 createImageBitmap/canvas → renderDownscaledImage 恒 null → 小图 pass-through
// 原字节（composer_paste_image.test.tsx 的逐字节断言依赖这一点）；降采样路径用注入的 io 假件钉。

import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  CHAT_IMAGE_MAX_COUNT,
  CHAT_IMAGE_MAX_PAYLOAD_CHARS,
  CHAT_IMAGE_MAX_SOURCE_BYTES,
  createMailAgentAttachmentAdapter,
  fileToDataUrl,
  isImageFile,
  prepareImagePayload,
  type AttachmentPanelBridge,
  type PreparedImagePayload
} from '@shared/assistant/runtime/chatAttachmentAdapter'
import { ATTACHMENT_MAX_TEXT_READ_BYTES, type ChatAttachment } from '@shared/lib/chat-attachments'
import { __resetToastStore, useToastStore } from '@shared/state/toast'
import type { PendingAttachment } from '@assistant-ui/react'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`

function pngFile(name = 'shot.png'): File {
  const bin = atob(PNG_BASE64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], name, { type: 'image/png' })
}

function textFile(name = 'notes.txt', content = 'hello attachment'): File {
  return new File([content], name, { type: 'text/plain' })
}

/** Spoof file.size without allocating the bytes (readAttachment / the guards only read .size). */
function withSpoofedSize(file: File, size: number): File {
  Object.defineProperty(file, 'size', { value: size })
  return file
}

interface BridgeLog {
  bridge: AttachmentPanelBridge
  added: ChatAttachment[]
  removed: string[]
}

function makeBridge(): BridgeLog {
  const added: ChatAttachment[] = []
  const removed: string[] = []
  return {
    added,
    removed,
    bridge: {
      onAdd: (a) => added.push(a),
      onRemove: (id) => removed.push(id)
    }
  }
}

function toastTitles(): string[] {
  return useToastStore.getState().items.map((t) => t.title)
}

beforeEach(() => {
  __resetToastStore()
})

describe('helpers', () => {
  test('isImageFile — MIME 前缀判定', () => {
    expect(isImageFile(pngFile())).toBe(true)
    expect(isImageFile(textFile())).toBe(false)
  })

  test('fileToDataUrl — 原字节逐字往返', async () => {
    await expect(fileToDataUrl(pngFile())).resolves.toBe(PNG_DATA_URL)
  })

  test('prepareImagePayload — 降采样命中时用重编码产物，未命中时 pass-through', async () => {
    const scaled: PreparedImagePayload = {
      dataUrl: 'data:image/jpeg;base64,SCALED',
      mediaType: 'image/jpeg'
    }
    const io = {
      renderDownscaledImage: vi.fn(async () => scaled),
      fileToDataUrl: vi.fn(async () => PNG_DATA_URL)
    }
    await expect(prepareImagePayload(pngFile(), io)).resolves.toEqual(scaled)
    expect(io.fileToDataUrl).not.toHaveBeenCalled()

    io.renderDownscaledImage = vi.fn(async () => null)
    await expect(prepareImagePayload(pngFile(), io)).resolves.toEqual({
      dataUrl: PNG_DATA_URL,
      mediaType: 'image/png'
    })
  })
})

describe('文本/二进制附件 — Sprint-14 injectedContext 老路逐条保住', () => {
  test('文本文件：readAttachment 语义 + 桥进 panel state 同 id + send() 空 content', async () => {
    const { bridge, added } = makeBridge()
    const adapter = createMailAgentAttachmentAdapter(() => bridge)

    const pending = (await adapter.add({ file: textFile() })) as PendingAttachment
    // 桥接进 panel 的 ChatAttachment 保住文本读取语义（content = 文件文本）……
    expect(added).toHaveLength(1)
    expect(added[0].content).toBe('hello attachment')
    expect(added[0].filename).toBe('notes.txt')
    // ……且与 composer attachment 同 id（回归面 #5 的 1:1 反映射前提）。
    expect(pending.id).toBe(added[0].id)
    expect(pending.status).toEqual({ type: 'requires-action', reason: 'composer-send' })

    // send() 返回空 content —— 文本附件不进 parts，继续走 body.injectedContext。
    const complete = await adapter.send(pending)
    expect(complete.status).toEqual({ type: 'complete' })
    expect(complete.content).toEqual([])
  })

  test('>5MB 文本：oversized→content null（仍出 chip），语义不变（回归面 #2）', async () => {
    const { bridge, added } = makeBridge()
    const adapter = createMailAgentAttachmentAdapter(() => bridge)
    const big = withSpoofedSize(textFile('huge.log', 'x'), ATTACHMENT_MAX_TEXT_READ_BYTES + 1)
    await adapter.add({ file: big })
    expect(added[0].content).toBeNull()
    expect(added[0].sizeBytes).toBe(ATTACHMENT_MAX_TEXT_READ_BYTES + 1)
  })

  test('remove() → 桥的 onRemove 拿到同 id（panel state 过滤）', async () => {
    const { bridge, added, removed } = makeBridge()
    const adapter = createMailAgentAttachmentAdapter(() => bridge)
    const pending = (await adapter.add({ file: textFile() })) as PendingAttachment
    await adapter.remove(pending)
    expect(removed).toEqual([added[0].id])
  })
})

describe('图片附件 — file part 通路 + 护栏', () => {
  test('小图 pass-through：send() 的 file part data 逐字等于原 data URL', async () => {
    const { bridge, added } = makeBridge()
    const adapter = createMailAgentAttachmentAdapter(() => bridge)
    const pending = (await adapter.add({ file: pngFile() })) as PendingAttachment
    expect(pending.type).toBe('image')
    // 图片不进 panel state（否则 injectedContext 会再拼一行「模型读不了它」的假话）。
    expect(added).toHaveLength(0)

    const complete = await adapter.send(pending)
    expect(complete.content).toEqual([
      { type: 'file', mimeType: 'image/png', filename: 'shot.png', data: PNG_DATA_URL }
    ])
  })

  test('降采样管线（io 注入）：send() 用重编码产物 + image/jpeg', async () => {
    const io = {
      renderDownscaledImage: async () => ({
        dataUrl: 'data:image/jpeg;base64,SCALED',
        mediaType: 'image/jpeg'
      }),
      fileToDataUrl
    }
    const adapter = createMailAgentAttachmentAdapter(() => null, io)
    const pending = (await adapter.add({ file: pngFile() })) as PendingAttachment
    const complete = await adapter.send(pending)
    expect(complete.content).toEqual([
      {
        type: 'file',
        mimeType: 'image/jpeg',
        filename: 'shot.png',
        data: 'data:image/jpeg;base64,SCALED'
      }
    ])
  })

  test('张数上限：第 N+1 张拒收 + toast；remove/send 释放名额', async () => {
    const adapter = createMailAgentAttachmentAdapter(() => null)
    const pendings: PendingAttachment[] = []
    for (let i = 0; i < CHAT_IMAGE_MAX_COUNT; i++) {
      pendings.push((await adapter.add({ file: pngFile(`s${i}.png`) })) as PendingAttachment)
    }
    await expect(adapter.add({ file: pngFile('over.png') })).rejects.toThrow()
    expect(toastTitles()).toHaveLength(1)
    expect(toastTitles()[0]).toContain(String(CHAT_IMAGE_MAX_COUNT))

    // remove 释放一个名额……
    await adapter.remove(pendings[0])
    await expect(adapter.add({ file: pngFile('again.png') })).resolves.toBeTruthy()
    // ……send 也释放（composer send 后计数归零，不会把下一条消息挡死）。
    for (const p of pendings.slice(1)) await adapter.send(p)
    await expect(adapter.add({ file: pngFile('next-turn.png') })).resolves.toBeTruthy()
  })

  test('源文件大小上限：>10MB 拒收 + toast，不读字节', async () => {
    const adapter = createMailAgentAttachmentAdapter(() => null)
    const huge = withSpoofedSize(pngFile('huge.png'), CHAT_IMAGE_MAX_SOURCE_BYTES + 1)
    await expect(adapter.add({ file: huge })).rejects.toThrow()
    expect(toastTitles()).toHaveLength(1)
  })

  test('payload 兜底：重编码不可用且 data URL 超限 → 拒收 + toast', async () => {
    const io = {
      renderDownscaledImage: async () => null,
      fileToDataUrl: async () => `data:image/png;base64,${'A'.repeat(CHAT_IMAGE_MAX_PAYLOAD_CHARS)}`
    }
    const adapter = createMailAgentAttachmentAdapter(() => null, io)
    await expect(adapter.add({ file: pngFile() })).rejects.toThrow()
    expect(toastTitles()).toHaveLength(1)
  })

  test('读取失败：toast + rethrow（内置 paste 只 console.error，toast 是这里的责任）', async () => {
    const io = {
      renderDownscaledImage: async () => null,
      fileToDataUrl: async () => {
        throw new Error('reader exploded')
      }
    }
    const adapter = createMailAgentAttachmentAdapter(() => null, io)
    await expect(adapter.add({ file: pngFile() })).rejects.toThrow('reader exploded')
    expect(toastTitles()).toHaveLength(1)
  })
})
