import { describe, expect, test } from 'vitest'

import i18n from '@shared/i18n'
import {
  extractRepresentativeArg,
  formatToolDisplayTitle,
  narrateToolCall,
  prettifyMcpToolName,
  summarizeToolActions,
  summarizeToolResult
} from '@shared/assistant/tools/toolNarration'

await i18n.changeLanguage('zh-CN')
const t = i18n.t.bind(i18n)

describe('toolNarration', () => {
  test('extractRepresentativeArg prioritizes semantic keys over ids/limits', () => {
    expect(
      extractRepresentativeArg('email_search_fulltext', {
        limit: 20,
        internal_id: 53675,
        query: 'Q4 报销流程'
      })
    ).toBe('Q4 报销流程')

    expect(extractRepresentativeArg('email_get', { internal_id: 53675, format: 'full' })).toBe('')
  })

  test('prettifyMcpToolName formats known and generic MCP connectors cleanly', () => {
    expect(prettifyMcpToolName('mcp__notion__search')).toEqual({
      server: 'Notion',
      action: 'search'
    })
    expect(formatToolDisplayTitle('mcp__notion__notion_update_page', t)).toBe(
      'Notion · notion update page'
    )
    expect(formatToolDisplayTitle('web_search', t)).toBe('联网搜索')
  })

  test('narrateToolCall combines localized tool title with meaningful arg', () => {
    expect(
      narrateToolCall({ toolName: 'email_search_fulltext', args: { query: 'redis timeout' } }, t)
    ).toBe('正在全文搜索邮件「redis timeout」…')

    expect(narrateToolCall({ toolName: 'email_get', args: { internal_id: 53675 } }, t)).toBe(
      '正在读取邮件…'
    )
  })

  test('summarizeToolActions deduplicates counts and ignores suggest_followups', () => {
    const out = summarizeToolActions(
      [
        { type: 'tool-call', toolName: 'email_search_fulltext' },
        { type: 'tool-call', toolName: 'email_search_fulltext' },
        { type: 'tool-call', toolName: 'email_body' },
        { type: 'tool-call', toolName: 'suggest_followups' }
      ],
      t
    )
    expect(out).toBe('全文搜索邮件 ×2 · 读取邮件正文')
  })

  test('summarizeToolResult extracts count and sample labels', () => {
    expect(
      summarizeToolResult({
        items: [
          { internal_id: 1, subject: 'Q4 Budget Approval' },
          { internal_id: 2, subject: 'Architecture Notes' }
        ]
      })
    ).toEqual({
      count: 2,
      samples: ['Q4 Budget Approval', 'Architecture Notes']
    })
    expect(summarizeToolResult({ ok: true })).toBeNull()
  })
})
