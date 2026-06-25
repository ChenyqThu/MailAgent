// chat-panel P4 Phase 06a (cutover) — backfill-ui-messages migration script.
//
// Pins the three contract behaviours: --dry-run writes nothing, a real run fills ONLY the NULL rows
// and never overwrites an existing UIMessage (+ is idempotent), and a row that fails to convert is
// skipped without aborting the run.

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { backfillUiMessages } from '../../scripts/chat/backfill-ui-messages'
import type { MailAgentUIMessage } from '../../src/shared/assistant/uiMessage'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE ai_chat_messages (
      id INTEGER PRIMARY KEY,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      thinking TEXT,
      model TEXT,
      tokens_input INTEGER,
      tokens_output INTEGER,
      ui_message_json TEXT
    );
  `)
  // ids 1,2 are legacy (ui_message_json NULL); id 3 already has a canonical UIMessage.
  db.exec(`
    INSERT INTO ai_chat_messages (id, role, content, thinking, ui_message_json) VALUES
      (1, 'user', '帮我总结', NULL, NULL),
      (2, 'assistant', '这封邮件要你本周五确认', '先读正文', NULL),
      (3, 'assistant', '已存在', NULL, '{"id":"3","role":"assistant","parts":[{"type":"text","text":"existing"}]}');
  `)
})

afterEach(() => db.close())

const nullCount = (): number =>
  (
    db.prepare('SELECT COUNT(*) n FROM ai_chat_messages WHERE ui_message_json IS NULL').get() as {
      n: number
    }
  ).n
const json = (id: number): string | null =>
  (
    db.prepare('SELECT ui_message_json FROM ai_chat_messages WHERE id = ?').get(id) as {
      ui_message_json: string | null
    }
  ).ui_message_json

describe('backfillUiMessages', () => {
  test('--dry-run counts the NULL rows but writes nothing', () => {
    const res = backfillUiMessages(db, { dryRun: true })
    expect(res).toEqual({ scanned: 2, filled: 2, failed: 0 })
    expect(nullCount()).toBe(2) // untouched
  })

  test('real run fills ONLY the NULL rows, never overwrites an existing UIMessage, idempotent', () => {
    const before3 = json(3)
    const res = backfillUiMessages(db, {})
    expect(res).toEqual({ scanned: 2, filled: 2, failed: 0 })

    const row1 = JSON.parse(json(1) as string) as MailAgentUIMessage
    expect(row1.role).toBe('user')
    expect(row1.parts.some((p) => p.type === 'text' && p.text === '帮我总结')).toBe(true)
    const row2 = JSON.parse(json(2) as string) as MailAgentUIMessage
    // thinking → a reasoning part synthesized by chatMessageToUIMessage.
    expect(row2.parts.some((p) => p.type === 'reasoning' && p.text === '先读正文')).toBe(true)

    // Row 3 (existing UIMessage) is byte-identical — never overwritten.
    expect(json(3)).toBe(before3)
    // A second run finds nothing left to do.
    expect(backfillUiMessages(db, {}).scanned).toBe(0)
  })

  test('a row that fails to convert is skipped, not aborted (others still fill)', () => {
    const convert = vi.fn((row: { id: number; content: string }): MailAgentUIMessage => {
      if (row.id === 1) throw new Error('boom')
      return {
        id: String(row.id),
        role: 'assistant',
        parts: [{ type: 'text', text: row.content }]
      }
    })
    const res = backfillUiMessages(db, { convert })
    expect(res.scanned).toBe(2)
    expect(res.failed).toBe(1) // row 1 threw
    expect(res.filled).toBe(1) // row 2 still filled
    expect(json(1)).toBeNull() // failed → stays NULL
    expect(json(2)).not.toBeNull()
  })
})
