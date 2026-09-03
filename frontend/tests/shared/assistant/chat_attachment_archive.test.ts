// @vitest-environment happy-dom
//
// P2-L5 对话附件「发送即入库」（design §1.4，owner 09-02 拍板项 L3）。
//
// 三条不变量按重要性排：
//   ① **入库失败恒回落现状** —— serve-api 没起 / 超大 / 磁盘满，消息照发、文本预置那条老路
//      一个字没动，只是 chip 标「未归档」。这条是本文件里最要紧的用例。
//   ② **模型看到的内容不变** —— 非图片分支多出来的只有一个 `data-library` part，而它不进
//      模型消息（实测闸在 `tests/ai-gateway/library_data_part_model_messages.test.ts`）；
//      图片的 file part 与 data part 并列，file part 逐字节不变。
//   ③ **source_ref 指得回那条消息** —— 一次发送里的多个附件共享同一个 UIMessage id，且这个
//      id 随后被 `takeArchivedMessageId()` 取走盖在消息上（runtime 的 generateId 钩子）。
//
// 不接入库能力（`archiveIo` 不传）时行为与本 lane 之前逐字相同 —— 那条由既有的
// `chat_attachment_adapter.test.ts` 继续钉，本文件只钉「接上之后」。

import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  chatAttachmentParentPath,
  createChatAttachmentArchiver,
  type ChatAttachmentArchiver
} from '@shared/lib/chat-attachments'
import {
  createMailAgentAttachmentAdapter,
  type AttachmentPanelBridge,
  type ChatLibraryPartData
} from '@shared/assistant/runtime/chatAttachmentAdapter'
import { LIBRARY_VERSION_CONFLICT, type LibraryUploadFile } from '@shared/api/library'
import type { LibraryFile } from '@shared/api/types/library'
import { __resetToastStore } from '@shared/state/toast'
import type { CompleteAttachment, PendingAttachment } from '@assistant-ui/react'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`

function pngFile(name = 'shot.png'): File {
  const bin = atob(PNG_BASE64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], name, { type: 'image/png' })
}

function docxFile(name = 'report.docx'): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  })
}

function withSpoofedSize(file: File, size: number): File {
  Object.defineProperty(file, 'size', { value: size })
  return file
}

function libraryRow(over: Partial<LibraryFile> = {}): LibraryFile {
  return {
    id: 7,
    mount_id: 0,
    rel_path: '2026-09/report.docx',
    path: 'chat-attachments/2026-09/report.docx',
    parent_path: 'chat-attachments/2026-09',
    filename: 'report.docx',
    kind: 'office',
    mime: null,
    size_bytes: 4,
    mtime: null,
    content_hash: 'h',
    source: 'chat',
    source_ref: '113:m-1',
    created_by: 'user',
    status: 'present',
    text_status: null,
    created_at: 0,
    updated_at: 0,
    ...over
  } as LibraryFile
}

function conflictError(): Error {
  return Object.assign(new Error('already exists'), { code: LIBRARY_VERSION_CONFLICT })
}

function makeBridge(): { bridge: AttachmentPanelBridge; added: string[]; removed: string[] } {
  const added: string[] = []
  const removed: string[] = []
  return {
    added,
    removed,
    bridge: { onAdd: (a) => added.push(a.filename), onRemove: (id) => removed.push(id) }
  }
}

/** content 里的 data-library 载荷（没有就 null）。 */
function libraryData(complete: CompleteAttachment): ChatLibraryPartData | null {
  for (const part of complete.content) {
    if (part.type === 'data' && (part as { name?: string }).name === 'library') {
      return (part as unknown as { data: ChatLibraryPartData }).data
    }
  }
  return null
}

beforeEach(() => {
  __resetToastStore()
})

describe('createChatAttachmentArchiver — 落盘那一步', () => {
  test('按月分桶 + source=chat + source_ref 原样传下去', async () => {
    const uploadFile = vi.fn(async (_input: LibraryUploadFile) => libraryRow())
    const archive = createChatAttachmentArchiver({ uploadFile }, () => new Date(2026, 8, 15))

    await expect(archive(docxFile(), '113:m-1')).resolves.toEqual({
      ok: true,
      fileId: 7,
      path: 'chat-attachments/2026-09/report.docx'
    })
    const sent = uploadFile.mock.calls[0]![0]
    expect(sent.parent_path).toBe('chat-attachments/2026-09')
    expect(sent.filename).toBe('report.docx')
    expect(sent.source).toBe('chat')
    expect(sent.source_ref).toBe('113:m-1')
  })

  test('chatAttachmentParentPath — 月份补零', () => {
    expect(chatAttachmentParentPath(new Date(2026, 0, 3))).toBe('chat-attachments/2026-01')
    expect(chatAttachmentParentPath(new Date(2026, 11, 31))).toBe('chat-attachments/2026-12')
  })

  test('超过 UPLOAD_MAX_BYTES → 直接 ok:false，一个字节都不上传', async () => {
    const uploadFile = vi.fn(async () => libraryRow())
    const archive = createChatAttachmentArchiver({ uploadFile })
    const huge = withSpoofedSize(docxFile('huge.docx'), 15 * 1024 * 1024 + 1)
    await expect(archive(huge, '1:m')).resolves.toEqual({ ok: false })
    expect(uploadFile).not.toHaveBeenCalled()
  })

  test('serve-api 没起（上传抛错）→ ok:false，不重试', async () => {
    const uploadFile = vi.fn(async () => {
      throw Object.assign(new Error('connection refused'), { code: 'E_NETWORK' })
    })
    const archive = createChatAttachmentArchiver({ uploadFile })
    await expect(archive(docxFile(), '1:m')).resolves.toEqual({ ok: false })
    expect(uploadFile).toHaveBeenCalledTimes(1)
  })

  test('同名撞库（409）→ 换 _1 后缀重试，成功后用库里的真名', async () => {
    const uploadFile = vi.fn(async (input: LibraryUploadFile) => {
      if (input.filename === 'report.docx') throw conflictError()
      return libraryRow({
        filename: input.filename,
        path: `chat-attachments/2026-09/${input.filename}`
      })
    })
    const archive = createChatAttachmentArchiver({ uploadFile }, () => new Date(2026, 8, 15))
    await expect(archive(docxFile(), '1:m')).resolves.toEqual({
      ok: true,
      fileId: 7,
      path: 'chat-attachments/2026-09/report_1.docx'
    })
    expect(uploadFile).toHaveBeenCalledTimes(2)
  })

  test('一直撞名 → 试满次数后回落 ok:false（不无限重试）', async () => {
    const uploadFile = vi.fn(async () => {
      throw conflictError()
    })
    const archive = createChatAttachmentArchiver({ uploadFile })
    await expect(archive(docxFile(), '1:m')).resolves.toEqual({ ok: false })
    expect(uploadFile).toHaveBeenCalledTimes(5)
  })

  test('服务端回了投影行形状（id 为 null）→ 当没入库，不造假 id', async () => {
    const uploadFile = vi.fn(async () => libraryRow({ id: null }))
    const archive = createChatAttachmentArchiver({ uploadFile })
    await expect(archive(docxFile(), '1:m')).resolves.toEqual({ ok: false })
  })
})

// ── adapter 接上入库能力之后 ──────────────────────────────────────────────────

function okArchiver(fileId = 7): ChatAttachmentArchiver {
  return async (file) => ({
    ok: true,
    fileId,
    path: `chat-attachments/2026-09/${file.name}`
  })
}

const failArchiver: ChatAttachmentArchiver = async () => ({ ok: false })

describe('adapter.send() — 非图片分支', () => {
  test('入库成功：content 只多一个 data-library part，文本预置那条老路照旧', async () => {
    const { bridge, added } = makeBridge()
    const calls: string[] = []
    const adapter = createMailAgentAttachmentAdapter(() => bridge, undefined, {
      archive: async (file, sourceRef) => {
        calls.push(sourceRef)
        return okArchiver()(file, sourceRef)
      },
      getSessionId: () => 113
    })

    const pending = (await adapter.add({ file: docxFile() })) as PendingAttachment
    // 桥进 panel state 的那份（buildAttachmentBlock 的取数源）一如既往。
    expect(added).toEqual(['report.docx'])

    const complete = await adapter.send(pending)
    expect(complete.content).toHaveLength(1)
    expect(libraryData(complete)).toEqual({
      name: 'report.docx',
      archived: true,
      fileId: 7,
      path: 'chat-attachments/2026-09/report.docx'
    })
    expect(calls).toEqual(['113:' + adapterMessageId(adapter)])
  })

  // 🔴 本 lane 的核心回落用例（design §1.4「入库失败 → 回落现状，消息照发」）。
  test('入库失败：消息照发、panel state 一个字没动，chip 载荷标 archived:false', async () => {
    const { bridge, added } = makeBridge()
    const adapter = createMailAgentAttachmentAdapter(() => bridge, undefined, {
      archive: failArchiver,
      getSessionId: () => 113
    })

    const pending = (await adapter.add({ file: docxFile() })) as PendingAttachment
    const complete = await adapter.send(pending)

    // send() 没抛 —— 消息发得出去。
    expect(complete.status).toEqual({ type: 'complete' })
    // 回落到现状：内存 + 文本预置那条路径完好（桥里的那份没被动过）。
    expect(added).toEqual(['report.docx'])
    // chip 明确标未归档，而不是悄悄不画。
    expect(libraryData(complete)).toEqual({ name: 'report.docx', archived: false })
    // 全批没有一份入库成功 → 不占用 UIMessage id，交回 AI SDK 自己生成。
    expect(adapter.takeArchivedMessageId()).toBeNull()
  })

  test('不接入库能力（archiveIo 缺省）→ content 仍是空数组，行为逐字不变', async () => {
    const { bridge } = makeBridge()
    const adapter = createMailAgentAttachmentAdapter(() => bridge)
    const pending = (await adapter.add({ file: docxFile() })) as PendingAttachment
    const complete = await adapter.send(pending)
    expect(complete.content).toEqual([])
    expect(adapter.takeArchivedMessageId()).toBeNull()
  })
})

describe('adapter.send() — 图片分支', () => {
  test('file part 与 data part 并列：图仍逐字节喂给模型，另带一枚 chip', async () => {
    const adapter = createMailAgentAttachmentAdapter(() => null, undefined, {
      archive: okArchiver(9),
      getSessionId: () => 113
    })
    const pending = (await adapter.add({ file: pngFile() })) as PendingAttachment
    const complete = await adapter.send(pending)

    expect(complete.content).toHaveLength(2)
    expect(complete.content[0]).toEqual({
      type: 'file',
      mimeType: 'image/png',
      filename: 'shot.png',
      data: PNG_DATA_URL
    })
    expect(libraryData(complete)).toEqual({
      name: 'shot.png',
      archived: true,
      fileId: 9,
      path: 'chat-attachments/2026-09/shot.png'
    })
  })
})

describe('source_ref 的 UIMessage id', () => {
  test('同一次发送的多个附件共享一个 id；takeArchivedMessageId 取一次就清空', async () => {
    const refs: string[] = []
    const adapter = createMailAgentAttachmentAdapter(() => null, undefined, {
      archive: async (file, sourceRef) => {
        refs.push(sourceRef)
        return okArchiver()(file, sourceRef)
      },
      getSessionId: () => 113
    })
    const a = (await adapter.add({ file: docxFile('a.docx') })) as PendingAttachment
    const b = (await adapter.add({ file: docxFile('b.docx') })) as PendingAttachment
    // composer 的 Promise.all 语义：两个 send() 同批启动。
    await Promise.all([adapter.send(a), adapter.send(b)])

    expect(refs).toHaveLength(2)
    expect(refs[0]).toBe(refs[1])
    expect(refs[0]!.startsWith('113:')).toBe(true)

    const messageId = adapter.takeArchivedMessageId()
    expect(messageId).not.toBeNull()
    expect(refs[0]).toBe(`113:${messageId}`)
    // 一次消费 —— 第二次取到 null，助手消息不会抢走这个 id。
    expect(adapter.takeArchivedMessageId()).toBeNull()
  })

  test('新会话（session 还没建）→ 会话段留空，uiMessageId 仍唯一', async () => {
    const refs: string[] = []
    const adapter = createMailAgentAttachmentAdapter(() => null, undefined, {
      archive: async (file, sourceRef) => {
        refs.push(sourceRef)
        return okArchiver()(file, sourceRef)
      },
      getSessionId: () => null
    })
    const pending = (await adapter.add({ file: docxFile() })) as PendingAttachment
    await adapter.send(pending)
    expect(refs[0]!.startsWith(':')).toBe(true)
    expect(refs[0]!.length).toBeGreaterThan(1)
  })

  test('两批发送拿到不同的 id（跨批不串）', async () => {
    const refs: string[] = []
    const adapter = createMailAgentAttachmentAdapter(() => null, undefined, {
      archive: async (file, sourceRef) => {
        refs.push(sourceRef)
        return okArchiver()(file, sourceRef)
      },
      getSessionId: () => 113
    })
    const a = (await adapter.add({ file: docxFile('a.docx') })) as PendingAttachment
    await adapter.send(a)
    adapter.takeArchivedMessageId()
    const b = (await adapter.add({ file: docxFile('b.docx') })) as PendingAttachment
    await adapter.send(b)
    expect(refs[0]).not.toBe(refs[1])
  })
})

/** 取当前批次的 id 而不清空 —— 只给上面那条断言用（takeArchivedMessageId 是消费式的）。 */
function adapterMessageId(adapter: { takeArchivedMessageId(): string | null }): string {
  const id = adapter.takeArchivedMessageId()
  expect(id).not.toBeNull()
  return id as string
}
