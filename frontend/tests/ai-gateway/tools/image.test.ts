// task 09-02 — generate_image: registration face, the two generation paths (text → image, edit
// with source images) against a MOCK image model (no provider is ever called), the source-ref
// vocabulary, the on-disk store + file_id contract, the typed errors, and the class floor.
//
// 🔴 The mock model records what the tool SENT it (prompt / files / n / size) — every path test
//    asserts on that record, never only on "the tool returned something".

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ImageModel, Tool } from 'ai'

// The v4 image model shape as `ai` exports it (no direct dependency on @ai-sdk/provider here).
type ImageModelV4 = Extract<ImageModel, { specificationVersion: 'v4' }>
type ImageModelV4CallOptions = Parameters<ImageModelV4['doGenerate']>[0]

import { buildGatewayTools } from '../../../src/ai-gateway/tools'
import {
  collectAttachedImages,
  createImageTools,
  GATEWAY_IMAGE_TOOL_NAMES,
  parseSourceRef,
  readImageDimensions,
  resolveGeneratedFilePath,
  type ImageGenToolDeps
} from '../../../src/ai-gateway/tools/image'
import { GATEWAY_TOOL_CLASSES } from '../../../src/ai-gateway/tools/policy'
import { CORE_UNGATED_GATEWAY_TOOLS } from '../../../src/ai-gateway/tools/skill_gating'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import type { GatewayToolAuditCollector } from '../../../src/ai-gateway/tools/types'
import { ProviderImageModelError } from '../../../src/ai-gateway/providerRef'
import { mockDomain, okEnvelope } from './_helpers'

// 1×1 PNG (IHDR width=1 height=1) — enough header for readImageDimensions.
const PNG_1x1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_1x1 = new Uint8Array(Buffer.from(PNG_1x1_B64, 'base64'))

/** A PNG header claiming the given size (only the 24 bytes the parser reads). */
function pngHeader(width: number, height: number): Uint8Array {
  const out = new Uint8Array(24)
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(out.buffer).setUint32(16, width)
  new DataView(out.buffer).setUint32(20, height)
  return out
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'imagegen-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A recording ImageModelV4: captures every doGenerate call, answers with `images`. */
function mockModel(images: Uint8Array[] = [PNG_1x1]): {
  model: ImageModelV4
  calls: ImageModelV4CallOptions[]
} {
  const calls: ImageModelV4CallOptions[] = []
  const model: ImageModelV4 = {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'mock-image',
    maxImagesPerCall: 4,
    doGenerate: async (options) => {
      calls.push(options)
      return {
        images,
        warnings: [],
        response: { timestamp: new Date(0), modelId: 'mock-image', headers: {} },
        providerMetadata: {}
      }
    }
  }
  return { model, calls }
}

function deps(over: Partial<ImageGenToolDeps> = {}): ImageGenToolDeps {
  const { model } = mockModel()
  return {
    modelRef: 'oai:gpt-image-1',
    resolveImageModel: async () => model,
    generatedDir: dir,
    sessionId: 42,
    ...over
  }
}

function build(d: ImageGenToolDeps, collector: GatewayToolAuditCollector = []): Tool {
  return createImageTools(collector, new ApprovalGuard(), d, { contextMode: 'manual_chat' })
    .generate_image!
}

/** Drive the write tool like streamText: needsApproval (registers) → execute. */
async function run(tool: Tool, input: unknown, messages: unknown[] = []): Promise<unknown> {
  const toolCallId = `tc-${Math.random().toString(36).slice(2)}`
  const needsApproval = tool.needsApproval as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[] }
  ) => boolean | Promise<boolean>
  await needsApproval(input, { toolCallId, messages })
  const exec = tool.execute as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }
  ) => Promise<unknown>
  return exec(input, { toolCallId, messages, abortSignal: undefined })
}

function userImageMessage(dataUrl: string, text = '看这张图') {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      {
        type: 'file',
        mediaType: 'image/png',
        filename: 'a.png',
        data: { type: 'url', url: dataUrl }
      }
    ]
  }
}

// ── registration face ────────────────────────────────────────────────────────

describe('buildGatewayTools — generate_image registration', () => {
  test('no imageGen deps → not registered (assembly byte-identical)', () => {
    const tools = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      approvalGuard: new ApprovalGuard(),
      contextMode: 'manual_chat'
    })
    expect(tools.generate_image).toBeUndefined()
  })

  test('deps + guard in manual_chat → registered', () => {
    const tools = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      approvalGuard: new ApprovalGuard(),
      imageGen: deps(),
      contextMode: 'manual_chat'
    })
    for (const n of GATEWAY_IMAGE_TOOL_NAMES) expect(tools[n]).toBeDefined()
  })

  test('deps without a guard → not registered (a write tool cannot exist without its guard)', () => {
    const tools = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      imageGen: deps(),
      contextMode: 'manual_chat'
    })
    expect(tools.generate_image).toBeUndefined()
  })

  test.each(['untrusted_trigger', 'cron_headless', 'im_chat'] as const)(
    '%s → stripped by the outbound class row (the prd「headless 排除」)',
    (mode) => {
      const tools = buildGatewayTools({
        domain: mockDomain(() => okEnvelope([])),
        approvalGuard: new ApprovalGuard(),
        imageGen: deps(),
        contextMode: mode
      })
      expect(tools.generate_image).toBeUndefined()
    }
  )

  test('classified outbound + CORE_UNGATED (never skill-gated)', () => {
    expect(GATEWAY_TOOL_CLASSES.generate_image).toBe('outbound')
    expect(CORE_UNGATED_GATEWAY_TOOLS.has('generate_image')).toBe(true)
  })

  test('factory default tier: executes card-free when the tier map says auto, asks on ask', async () => {
    const auto = createImageTools([], new ApprovalGuard(), deps(), {
      contextMode: 'manual_chat',
      toolApprovalPrefs: { generate_image: { tier: 'auto', source: 'default' } }
    }).generate_image!
    const ask = createImageTools([], new ApprovalGuard(), deps(), {
      contextMode: 'manual_chat',
      toolApprovalPrefs: { generate_image: { tier: 'ask', source: 'owner' } }
    }).generate_image!
    const na = (t: Tool) =>
      (t.needsApproval as (i: unknown, o: unknown) => boolean | Promise<boolean>)(
        { prompt: 'x', n: 1, source_images: [] },
        { toolCallId: 'tc-tier', messages: [] }
      )
    expect(await na(auto)).toBe(false)
    expect(await na(ask)).toBe(true)
  })
})

// ── generate path ────────────────────────────────────────────────────────────

describe('generate_image — text → image', () => {
  test('sends the prompt (no files) to the model, writes the file, returns refs without bytes', async () => {
    const { model, calls } = mockModel([pngHeader(1024, 1536)])
    const collector: GatewayToolAuditCollector = []
    const tool = build(deps({ resolveImageModel: async () => model }), collector)
    const out = (await run(tool, {
      prompt: '一只在海边的柴犬',
      size: '1024x1536',
      n: 1,
      source_images: []
    })) as {
      mode: string
      model: string
      images: Array<{ file_id: string; mime: string; width: number; height: number; url: string }>
    }

    expect(calls).toHaveLength(1)
    expect(calls[0]!.prompt).toBe('一只在海边的柴犬')
    expect(calls[0]!.files).toBeUndefined()
    expect(calls[0]!.size).toBe('1024x1536')
    expect(calls[0]!.n).toBe(1)

    expect(out.mode).toBe('generate')
    expect(out.model).toBe('oai:gpt-image-1')
    expect(out.images).toHaveLength(1)
    const img = out.images[0]!
    expect(img.mime).toBe('image/png')
    expect(img.width).toBe(1024)
    expect(img.height).toBe(1536)
    expect(img.file_id).toMatch(/^42-[0-9a-f-]{36}\.png$/)
    expect(img.url).toBe(`/api/ai/generated/${img.file_id}`)
    // No bytes / base64 anywhere in the model-visible result.
    expect(JSON.stringify(out)).not.toContain('base64')
    expect(JSON.stringify(out).length).toBeLessThan(400)

    // The file is where the route will look for it, with the bytes the model returned.
    const resolved = resolveGeneratedFilePath(dir, img.file_id)!
    expect(resolved.path).toBe(join(dir, '42', img.file_id.slice(3)))
    expect(new Uint8Array(await readFile(resolved.path))).toEqual(pngHeader(1024, 1536))

    // Audit row records the call as ok with the default-tier auto skip.
    expect(collector).toHaveLength(1)
    expect(collector[0]!.status).toBe('ok')
    expect(collector[0]!.toolName).toBe('generate_image')
  })

  test('n=2 → two files, two refs', async () => {
    const { model } = mockModel([pngHeader(64, 64), pngHeader(64, 64)])
    const tool = build(deps({ resolveImageModel: async () => model }))
    const out = (await run(tool, { prompt: 'p', n: 2, source_images: [] })) as {
      images: Array<{ file_id: string }>
    }
    expect(out.images).toHaveLength(2)
    expect(out.images[0]!.file_id).not.toBe(out.images[1]!.file_id)
  })

  test('session-less chat → files land under 0/ with a 0- prefixed id', async () => {
    const tool = build(deps({ sessionId: null }))
    const out = (await run(tool, { prompt: 'p', n: 1, source_images: [] })) as {
      images: Array<{ file_id: string }>
    }
    expect(out.images[0]!.file_id).toMatch(/^0-/)
    expect(
      resolveGeneratedFilePath(dir, out.images[0]!.file_id)!.path.startsWith(join(dir, '0'))
    ).toBe(true)
  })
})

// ── edit path ────────────────────────────────────────────────────────────────

describe('generate_image — edit with source images', () => {
  test('attached:last → the user-attached bytes go to the model as files + mode=edit', async () => {
    const { model, calls } = mockModel()
    const tool = build(deps({ resolveImageModel: async () => model }))
    const messages = [
      userImageMessage(`data:image/png;base64,${Buffer.from(pngHeader(2, 2)).toString('base64')}`),
      { role: 'assistant', content: [{ type: 'text', text: '收到' }] },
      userImageMessage(`data:image/png;base64,${PNG_1x1_B64}`, '把这张改成水彩')
    ]
    const out = (await run(
      tool,
      { prompt: '改成水彩风格', n: 1, source_images: ['attached:last'] },
      messages
    )) as { mode: string }

    expect(out.mode).toBe('edit')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.prompt).toBe('改成水彩风格')
    const files = calls[0]!.files!
    expect(files).toHaveLength(1)
    // `last` = the second attachment, not the first.
    expect(files[0]!.type).toBe('file')
    expect(new Uint8Array((files[0] as { data: Uint8Array }).data)).toEqual(PNG_1x1)
  })

  test('attached:<n> is 1-based in conversation order', async () => {
    const { model, calls } = mockModel()
    const tool = build(deps({ resolveImageModel: async () => model }))
    const first = pngHeader(3, 3)
    const messages = [
      userImageMessage(`data:image/png;base64,${Buffer.from(first).toString('base64')}`),
      userImageMessage(`data:image/png;base64,${PNG_1x1_B64}`)
    ]
    await run(tool, { prompt: 'p', n: 1, source_images: ['attached:1'] }, messages)
    expect(new Uint8Array((calls[0]!.files![0] as { data: Uint8Array }).data)).toEqual(first)
  })

  test('a file_id from an earlier result in this session is read back from disk (chain edit)', async () => {
    const { model, calls } = mockModel([pngHeader(5, 5)])
    const tool = build(deps({ resolveImageModel: async () => model }))
    const firstOut = (await run(tool, { prompt: 'v1', n: 1, source_images: [] })) as {
      images: Array<{ file_id: string }>
    }
    const fileId = firstOut.images[0]!.file_id
    await run(tool, { prompt: 'v2 based on v1', n: 1, source_images: [fileId] })
    expect(calls).toHaveLength(2)
    expect(new Uint8Array((calls[1]!.files![0] as { data: Uint8Array }).data)).toEqual(
      pngHeader(5, 5)
    )
  })

  test('a file_id from ANOTHER session is refused (E_IMAGE_NOT_FOUND), even when the file exists', async () => {
    await mkdir(join(dir, '7'), { recursive: true })
    const foreign = '7-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png'
    await writeFile(join(dir, '7', foreign.slice(2)), PNG_1x1)
    const tool = build(deps())
    await expect(run(tool, { prompt: 'p', n: 1, source_images: [foreign] })).rejects.toThrow(
      /E_IMAGE_NOT_FOUND/
    )
  })

  test('attached:last with no attachment in the conversation → E_IMAGE_NOT_FOUND', async () => {
    const tool = build(deps())
    await expect(
      run(tool, { prompt: 'p', n: 1, source_images: ['attached:last'] }, [
        { role: 'user', content: [{ type: 'text', text: 'no image here' }] }
      ])
    ).rejects.toThrow(/E_IMAGE_NOT_FOUND/)
  })

  test('garbage source ref → E_IMAGE_SOURCE_INVALID naming the entry, model never called', async () => {
    const { model, calls } = mockModel()
    const tool = build(deps({ resolveImageModel: async () => model }))
    await expect(
      run(tool, { prompt: 'p', n: 1, source_images: ['../../etc/passwd'] })
    ).rejects.toThrow(/E_IMAGE_SOURCE_INVALID.*etc\/passwd/)
    expect(calls).toHaveLength(0)
  })
})

// ── typed errors ─────────────────────────────────────────────────────────────

describe('generate_image — typed errors', () => {
  test('no IMAGE_GEN_MODEL → E_IMAGE_MODEL_NOT_CONFIGURED, resolver never consulted', async () => {
    const resolveImageModel = vi.fn()
    const tool = build(deps({ modelRef: '   ', resolveImageModel }))
    await expect(run(tool, { prompt: 'p', n: 1, source_images: [] })).rejects.toThrow(
      /E_IMAGE_MODEL_NOT_CONFIGURED/
    )
    expect(resolveImageModel).not.toHaveBeenCalled()
  })

  test('provider without an image model → the resolver error code surfaces to the model', async () => {
    const tool = build(
      deps({
        resolveImageModel: async () => {
          throw new ProviderImageModelError('anthropic has no image model')
        }
      })
    )
    await expect(run(tool, { prompt: 'p', n: 1, source_images: [] })).rejects.toThrow(
      /E_IMAGE_MODEL_UNSUPPORTED.*anthropic has no image model/
    )
  })

  test('upstream failure → E_IMAGE_GENERATION_FAILED with a sanitized message (no body leak)', async () => {
    const model: ImageModelV4 = {
      specificationVersion: 'v4',
      provider: 'mock',
      modelId: 'mock-image',
      maxImagesPerCall: 1,
      doGenerate: async () => {
        throw new Error('401 unauthorized: Authorization: Bearer sk-secret-123')
      }
    }
    const tool = build(deps({ resolveImageModel: async () => model }))
    let thrown: unknown
    try {
      await run(tool, { prompt: 'p', n: 1, source_images: [] })
    } catch (e) {
      thrown = e
    }
    expect(String((thrown as Error).message)).toMatch(/E_IMAGE_GENERATION_FAILED/)
    expect(String((thrown as Error).message)).not.toContain('sk-secret-123')
  })

  test('schema: n > 2 and a malformed size are rejected before execute', () => {
    const tool = build(deps())
    const schema = tool.inputSchema as { safeParse?: (v: unknown) => { success: boolean } }
    expect(schema.safeParse).toBeTypeOf('function')
    expect(schema.safeParse!({ prompt: 'p', n: 3 }).success).toBe(false)
    expect(schema.safeParse!({ prompt: 'p', size: 'big' }).success).toBe(false)
    expect(schema.safeParse!({ prompt: 'p' }).success).toBe(true)
  })
})

// ── pure helpers ─────────────────────────────────────────────────────────────

describe('resolveGeneratedFilePath — the file_id contract', () => {
  test('valid id → <root>/<session>/<uuid>.<ext> with the mime of the extension', () => {
    const r = resolveGeneratedFilePath(dir, '12-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.webp')!
    expect(r.path).toBe(join(dir, '12', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.webp'))
    expect(r.mime).toBe('image/webp')
    expect(r.sessionId).toBe(12)
  })

  test.each([
    '../../etc/passwd',
    '12-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png/../x.png',
    '12-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.exe',
    '12-AAAAAAAA-bbbb-cccc-dddd-eeeeeeeeeeee.png',
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png',
    '12-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png ',
    ''
  ])('rejects %j', (id) => {
    expect(resolveGeneratedFilePath(dir, id)).toBeNull()
  })
})

describe('parseSourceRef', () => {
  test.each([
    ['attached:last', { kind: 'attached', index: -1 }],
    ['attached:3', { kind: 'attached', index: 3 }],
    [
      '9-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg',
      { kind: 'generated', fileId: '9-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg' }
    ]
  ])('%s', (raw, expected) => {
    expect(parseSourceRef(raw)).toEqual(expected)
  })
  test.each(['attached:0', 'attached:', 'last', 'http://x/y.png', 'a.png'])('rejects %s', (raw) => {
    expect(parseSourceRef(raw)).toBeNull()
  })
})

describe('collectAttachedImages', () => {
  test('user file parts only, in order; assistant parts and non-image files skipped', () => {
    const out = collectAttachedImages([
      {
        role: 'user',
        content: [
          { type: 'file', mediaType: 'application/pdf', data: 'AAAA' },
          {
            type: 'file',
            mediaType: 'image/png',
            data: { type: 'url', url: `data:image/png;base64,${PNG_1x1_B64}` }
          }
        ]
      },
      { role: 'assistant', content: [{ type: 'file', mediaType: 'image/png', data: PNG_1x1 }] },
      { role: 'user', content: [{ type: 'image', image: PNG_1x1, mediaType: 'image/png' }] }
    ] as never)
    expect(out).toHaveLength(2)
    expect(out[0]!.mediaType).toBe('image/png')
    expect(out[0]!.bytes).toEqual(PNG_1x1)
    expect(out[1]!.bytes).toEqual(PNG_1x1)
  })
})

describe('readImageDimensions', () => {
  test('PNG IHDR', () => {
    expect(readImageDimensions(pngHeader(1536, 1024))).toEqual({ width: 1536, height: 1024 })
    expect(readImageDimensions(PNG_1x1)).toEqual({ width: 1, height: 1 })
  })
  test('JPEG SOF0', () => {
    // SOI, APP0 (len 16), SOF0 (len 17): precision 8, height 0x0100, width 0x0200
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x02, 0x00, 0x03,
      0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01
    ])
    expect(readImageDimensions(jpeg)).toEqual({ width: 512, height: 256 })
  })
  test('WebP VP8X', () => {
    const webp = new Uint8Array(30)
    webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58])
    // canvas width-1 = 799 (0x031f), height-1 = 599 (0x0257), little-endian 24-bit at 24..29
    webp.set([0x1f, 0x03, 0x00, 0x57, 0x02, 0x00], 24)
    expect(readImageDimensions(webp)).toEqual({ width: 800, height: 600 })
  })
  test('unknown bytes → null', () => {
    expect(readImageDimensions(new Uint8Array([1, 2, 3, 4]))).toBeNull()
  })
})
