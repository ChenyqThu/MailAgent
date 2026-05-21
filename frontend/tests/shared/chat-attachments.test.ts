// @vitest-environment happy-dom
//
// Sprint 14 PR C — chat-attachments helper coverage.
// The helper is pure: text-detection heuristic + size formatter +
// markdown block builder + File → ChatAttachment reader. None of
// these touch IPC, so a focused unit suite catches the corner cases
// (extension/MIME detection, content cap, binary skip) without
// renderer or React harness overhead.

import { describe, expect, test } from 'vitest'

import {
  ATTACHMENT_MAX_CONTENT_CHARS,
  buildAttachmentBlock,
  formatAttachmentSize,
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
    expect(block).toContain('[Attached files]')
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

  test('multiple attachments separated by blank lines', () => {
    const block = buildAttachmentBlock([
      makeAttachment({ id: 'a', filename: 'a.txt', content: 'A' }),
      makeAttachment({ id: 'b', filename: 'b.txt', content: 'B' })
    ])
    // Block items separated by `\n\n` (the renderer prepends one
    // blank line between blocks so they read as distinct entries).
    expect(block).toMatch(/```\nA\n```\n\n- b\.txt/)
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
