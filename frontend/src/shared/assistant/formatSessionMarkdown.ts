import type { ChatMessage } from '@shared/api/types'
import { extractTextFromUIMessage, parseUiMessageJson } from './uiMessage'

type ExportableMessageRow = Pick<ChatMessage, 'role' | 'content' | 'ui_message_json'>

function extractRowText(row: ExportableMessageRow): string {
  const uiMsg = parseUiMessageJson(row.ui_message_json ?? null)
  if (uiMsg) {
    const text = extractTextFromUIMessage(uiMsg).trim()
    if (text.length > 0) return text
  }
  return row.content.trim()
}

/**
 * Format persisted chat rows into clean shareable Markdown (skipping system/tool rows).
 */
export function formatSessionTranscriptMarkdown(
  title: string,
  rows: readonly ExportableMessageRow[]
): string {
  const heading = `# ${title.trim() || 'Conversation'}`
  const sections: string[] = [heading]

  for (const row of rows) {
    if (row.role !== 'user' && row.role !== 'assistant') continue
    const text = extractRowText(row)
    if (!text) continue
    const speaker = row.role === 'user' ? 'User' : 'Assistant'
    sections.push(`## ${speaker}\n\n${text}`)
  }

  return sections.join('\n\n')
}
