// Sprint 14 PR C — chat attachments (MVP).
//
// Local-only attachment metadata + content reader. The full pipeline
// (chat_attachments table, LLM vision protocol, Anthropic image
// content blocks, OpenAI file_id) is scoped to a follow-up sprint;
// this MVP keeps attachments in renderer memory and prepends a
// "[Attached files]" block to the user message before each send, so
// the LLM at least sees the metadata + the file's text content when
// available. Binary attachments (images, PDF) ship as metadata-only
// — the model can acknowledge them but not look inside.

/** Cap each attachment's text content at this many characters before
 *  prepending it to the prompt. Five attachments × 5000 chars × ~0.25
 *  tokens/char ≈ 6.2k context tokens; well under the per-turn budget
 *  even on the smaller Sonnet 4 context window. */
export const ATTACHMENT_MAX_CONTENT_CHARS = 5000

export interface ChatAttachment {
  /** crypto.randomUUID — stable id for chip remove/list ordering. */
  id: string
  filename: string
  sizeBytes: number
  /** Browser-detected MIME type (file.type). Empty string for
   *  extension-less files, so the readiness check below also looks at
   *  the filename. */
  mimeType: string
  /** UTF-8 content for text-class files (text/*, application/json,
   *  application/xml, common code extensions). null for binary
   *  attachments. Capped at ATTACHMENT_MAX_CONTENT_CHARS. */
  content: string | null
}

const TEXT_MIME_PREFIXES: readonly string[] = ['text/']
const TEXT_MIME_EXACT: ReadonlySet<string> = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-yaml',
  'application/x-sh'
])
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'xml',
  'yaml',
  'yml',
  'html',
  'htm',
  'log',
  'sh',
  'py',
  'js',
  'ts',
  'tsx',
  'jsx',
  'css',
  'scss',
  'rst'
])

/** True iff we'll attempt to read this file's text content. Heuristic:
 *  trust the MIME prefix first (more accurate when the browser supplies
 *  one), then fall through to the filename extension for extension-less
 *  or octet-stream cases where the browser refused to guess. */
export function isTextAttachment(filename: string, mimeType: string): boolean {
  if (mimeType.length > 0) {
    if (TEXT_MIME_PREFIXES.some((p) => mimeType.startsWith(p))) return true
    if (TEXT_MIME_EXACT.has(mimeType)) return true
  }
  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() : ''
  return TEXT_EXTENSIONS.has(ext)
}

/** Read the file via the FileReader API. For text files, returns the
 *  truncated content; for binary, returns null without reading (saves
 *  base64 work that the LLM can't use yet). Throws on read failure
 *  — caller (Composer) surfaces a toast. */
export async function readAttachment(file: File): Promise<ChatAttachment> {
  const isText = isTextAttachment(file.name, file.type)
  const content = isText
    ? (await file.text()).slice(0, ATTACHMENT_MAX_CONTENT_CHARS)
    : null
  return {
    id:
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${file.name}-${file.size}-${Date.now()}`,
    filename: file.name,
    sizeBytes: file.size,
    mimeType: file.type,
    content
  }
}

/** Format a byte count as `12.3 KB` / `1.5 MB`. Localised through the
 *  same units the Settings page uses (DESIGN.md §14 mono numbers). */
export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Render an attachment list as a markdown block to prepend before the
 *  user's prompt. Each entry shows filename + size + (when known) the
 *  text excerpt; binary entries surface only the metadata so the LLM
 *  can say "I see you attached image.png but I can't read it yet". */
export function buildAttachmentBlock(attachments: ReadonlyArray<ChatAttachment>): string {
  if (attachments.length === 0) return ''
  const blocks = attachments.map((a) => {
    const head = `- ${a.filename} (${formatAttachmentSize(a.sizeBytes)}${a.mimeType ? `, ${a.mimeType}` : ''})`
    if (a.content === null) return head
    return `${head}\n\`\`\`\n${a.content}\n\`\`\``
  })
  return `[Attached files]\n${blocks.join('\n\n')}\n\n---\n\n`
}
