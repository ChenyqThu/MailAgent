// @vitest-environment happy-dom
//
// Sprint 14 PR C — chat-attachments helper coverage.
// The helper is pure: text-detection heuristic + size formatter +
// markdown block builder + File → ChatAttachment reader. None of
// these touch IPC, so a focused unit suite catches the corner cases
// (extension/MIME detection, content cap, binary skip) without
// renderer or React harness overhead.

import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  ATTACHMENT_MAX_CONTENT_CHARS,
  ATTACHMENT_MAX_CONVERT_BYTES,
  buildAttachmentBlock,
  formatAttachmentSize,
  isConvertibleAttachment,
  isTextAttachment,
  readAttachment,
  type ChatAttachment
} from '@shared/lib/chat-attachments'

describe('isTextAttachment', () => {
  test.each([
    ['notes.txt', '', true],
    ['notes.txt', 'text/plain', true],
    ['README.md', 'text/markdown', true],
    ['data.csv', 'text/csv', true],
    ['app.tsx', '', true],
    ['payload.json', 'application/json', true],
    ['config.yaml', '', true]
  ])('%s (%s) → text', (filename, mime, expected) => {
    expect(isTextAttachment(filename, mime)).toBe(expected)
  })

  test.each([
    ['photo.png', 'image/png', false],
    ['report.pdf', 'application/pdf', false],
    ['slides.pptx', 'application/vnd.openxmlformats', false],
    ['archive.zip', 'application/zip', false],
    ['noext', '', false]
  ])('%s (%s) → binary', (filename, mime, expected) => {
    expect(isTextAttachment(filename, mime)).toBe(expected)
  })

  test('MIME prefix takes precedence over extension when both present', () => {
    // image/svg+xml is technically text/SVG but the MIME prefix wins
    // because the browser-provided mime is a stronger signal than
    // ext-list guesses (test isolates the heuristic priority).
    expect(isTextAttachment('icon.svg', 'image/svg+xml')).toBe(false)
  })
})

describe('formatAttachmentSize', () => {
  test('bytes', () => {
    expect(formatAttachmentSize(0)).toBe('0 B')
    expect(formatAttachmentSize(512)).toBe('512 B')
    expect(formatAttachmentSize(1023)).toBe('1023 B')
  })

  test('KB', () => {
    expect(formatAttachmentSize(1024)).toBe('1.0 KB')
    expect(formatAttachmentSize(12 * 1024)).toBe('12.0 KB')
    expect(formatAttachmentSize(1024 * 1024 - 1)).toMatch(/KB$/)
  })

  test('MB', () => {
    expect(formatAttachmentSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatAttachmentSize(7.5 * 1024 * 1024)).toBe('7.5 MB')
  })
})

describe('buildAttachmentBlock', () => {
  function makeAttachment(over: Partial<ChatAttachment>): ChatAttachment {
    return {
      id: 'id-1',
      filename: 'file.txt',
      sizeBytes: 100,
      mimeType: 'text/plain',
      content: null,
      ...over
    }
  }

  test('empty list returns empty string', () => {
    expect(buildAttachmentBlock([])).toBe('')
  })

  test('text attachment renders metadata + fenced content block', () => {
    const block = buildAttachmentBlock([
      makeAttachment({ filename: 'notes.md', content: 'hello world' })
    ])
    // Sprint 14 review HIGH fix — header now carries explicit
    // "untrusted user-uploaded content" framing to resist prompt
    // injection. The bare "[Attached files]" prefix is still present.
    expect(block).toContain('[Attached files')
    expect(block).toContain('untrusted')
    expect(block).toContain('notes.md')
    expect(block).toContain('hello world')
    expect(block).toMatch(/```\nhello world\n```/)
  })

  test('binary attachment renders metadata only (no fence)', () => {
    const block = buildAttachmentBlock([
      makeAttachment({ filename: 'photo.png', mimeType: 'image/png', content: null })
    ])
    expect(block).toContain('photo.png')
    expect(block).not.toContain('```')
  })

  test('multiple attachments separated by newlines', () => {
    const block = buildAttachmentBlock([
      makeAttachment({ id: 'a', filename: 'a.txt', content: 'A' }),
      makeAttachment({ id: 'b', filename: 'b.txt', content: 'B' })
    ])
    // Sprint 14 review HIGH fix — items separated by single newline
    // inside the joined block (header line + each entry as its own
    // joined-with-`\n` segment). Both filenames + their fenced bodies
    // must appear in order.
    expect(block.indexOf('a.txt')).toBeLessThan(block.indexOf('b.txt'))
    expect(block).toMatch(/```\nA\n```/)
    expect(block).toMatch(/```\nB\n```/)
  })

  test('ends with the `---` separator the LLM uses as a context divider', () => {
    const block = buildAttachmentBlock([makeAttachment({ content: 'x' })])
    expect(block.endsWith('---\n\n')).toBe(true)
  })
})

describe('readAttachment', () => {
  test('text file → content captured', async () => {
    const file = new File(['line1\nline2'], 'notes.txt', { type: 'text/plain' })
    const a = await readAttachment(file)
    expect(a.filename).toBe('notes.txt')
    expect(a.sizeBytes).toBe(file.size)
    expect(a.mimeType).toBe('text/plain')
    expect(a.content).toBe('line1\nline2')
  })

  test('binary file → content stays null', async () => {
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'photo.jpg', {
      type: 'image/jpeg'
    })
    const a = await readAttachment(file)
    expect(a.filename).toBe('photo.jpg')
    expect(a.mimeType).toBe('image/jpeg')
    expect(a.content).toBeNull()
  })

  test('text content is truncated to ATTACHMENT_MAX_CONTENT_CHARS', async () => {
    const long = 'x'.repeat(ATTACHMENT_MAX_CONTENT_CHARS + 1000)
    const file = new File([long], 'big.txt', { type: 'text/plain' })
    const a = await readAttachment(file)
    expect(a.content?.length).toBe(ATTACHMENT_MAX_CONTENT_CHARS)
  })

  test('id is unique across reads of the same file', async () => {
    const f1 = new File(['x'], 'a.txt', { type: 'text/plain' })
    const f2 = new File(['x'], 'a.txt', { type: 'text/plain' })
    const a1 = await readAttachment(f1)
    const a2 = await readAttachment(f2)
    expect(a1.id).not.toBe(a2.id)
  })
})

// ---------------------------------------------------------------------------
// task 08-10 WP3 — office documents go through the server-side converter.
// ---------------------------------------------------------------------------

describe('isConvertibleAttachment', () => {
  test.each([
    ['report.docx', ''],
    ['deck.pptx', 'application/vnd.openxmlformats'],
    ['book.xlsx', ''],
    ['legacy.doc', 'application/msword'],
    ['macro.xlsm', '']
  ])('%s → convertible', (filename, mime) => {
    expect(isConvertibleAttachment(filename, mime)).toBe(true)
  })

  test('csv stays on the local text path — direct read is the more faithful output', () => {
    expect(isConvertibleAttachment('data.csv', 'text/csv')).toBe(false)
    expect(isTextAttachment('data.csv', 'text/csv')).toBe(true)
  })

  test('🔴 pdf is NOT sent — the server pdf lane ships off, so it would be a wasted round-trip', () => {
    expect(isConvertibleAttachment('doc.pdf', 'application/pdf')).toBe(false)
  })

  test('images stay metadata-only', () => {
    expect(isConvertibleAttachment('photo.png', 'image/png')).toBe(false)
  })
})

describe('readAttachment — document conversion', () => {
  function mockFetch(impl: () => unknown): ReturnType<typeof vi.fn> {
    const fn = vi.fn(async () => impl() as Response)
    vi.stubGlobal('fetch', fn)
    return fn
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function docxFile(name = 'report.docx'): File {
    return new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], name, {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    })
  }

  test('converted markdown lands in content', async () => {
    mockFetch(() => ({
      ok: true,
      json: async () => ({
        status: 'success',
        data: { status: 'converted', markdown: '# Title\n\n| a | b |\n| --- | --- |' }
      })
    }))
    const a = await readAttachment(docxFile())
    expect(a.content).toContain('| --- |')
  })

  test('sends filename + base64, and includes credentials for the remote build', async () => {
    const fn = mockFetch(() => ({
      ok: true,
      json: async () => ({ status: 'success', data: { status: 'converted', markdown: 'x' } })
    }))
    await readAttachment(docxFile('合同.docx'))
    expect(fn).toHaveBeenCalledTimes(1)
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/attachment/convert')
    // 🔴 remote web authenticates by CF Access cookie; omitting this is a real
    // bug shipped on another endpoint — pin it so we don't repeat it.
    expect(init.credentials).toBe('include')
    const body = JSON.parse(String(init.body)) as { filename: string; contentBase64: string }
    expect(body.filename).toBe('合同.docx')
    expect(body.contentBase64.length).toBeGreaterThan(0)
  })

  test('endpoint disabled (404) → metadata-only, never throws', async () => {
    mockFetch(() => ({ ok: false, status: 404, json: async () => ({}) }))
    const a = await readAttachment(docxFile())
    expect(a.content).toBeNull()
    expect(a.filename).toBe('report.docx')
  })

  test('server says unsupported → metadata-only', async () => {
    mockFetch(() => ({
      ok: true,
      json: async () => ({ status: 'success', data: { status: 'unsupported', markdown: null } })
    }))
    expect((await readAttachment(docxFile())).content).toBeNull()
  })

  test('transport failure → metadata-only, message still sendable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      })
    )
    await expect(readAttachment(docxFile())).resolves.toMatchObject({ content: null })
  })

  test('converted markdown is capped at ATTACHMENT_MAX_CONTENT_CHARS', async () => {
    mockFetch(() => ({
      ok: true,
      json: async () => ({
        status: 'success',
        data: { status: 'converted', markdown: 'y'.repeat(ATTACHMENT_MAX_CONTENT_CHARS + 500) }
      })
    }))
    const a = await readAttachment(docxFile())
    expect(a.content?.length).toBe(ATTACHMENT_MAX_CONTENT_CHARS)
  })

  test('oversized document skips the round-trip entirely', async () => {
    const fn = mockFetch(() => ({ ok: true, json: async () => ({}) }))
    const big = new File(['x'], 'huge.docx', { type: '' })
    Object.defineProperty(big, 'size', { value: ATTACHMENT_MAX_CONVERT_BYTES + 1 })
    expect((await readAttachment(big)).content).toBeNull()
    expect(fn).not.toHaveBeenCalled()
  })

  test('text and image files never hit the converter', async () => {
    const fn = mockFetch(() => ({ ok: true, json: async () => ({}) }))
    await readAttachment(new File(['hello'], 'a.txt', { type: 'text/plain' }))
    await readAttachment(new File([new Uint8Array([1])], 'b.png', { type: 'image/png' }))
    expect(fn).not.toHaveBeenCalled()
  })
})
