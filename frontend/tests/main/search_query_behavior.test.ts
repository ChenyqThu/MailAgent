import { beforeAll, afterAll, describe, expect, test, vi } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

let fixtureDb: Database.Database

vi.mock('../../src/electron/main/db', () => ({
  getDb: () => fixtureDb,
  closeDb: () => {},
  resolveDbPath: () => ':memory:'
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

const handlers = await import('../../src/electron/main/handlers/email')

interface FixtureEmail {
  internal_id: number
  subject: string
  sender: string
  sender_name: string | null
  to_addr: string
  cc_addr: string
  date_received: string
  mailbox: string
  is_read: number
  is_flagged: number
  is_pinned: number
  is_important: number
  ai_priority: string | null
  body_markdown: string
  attachments?: Array<{ filename: string; is_inline: number }>
}

interface FixtureCase {
  name: string
  query: string
  mode?: 'smart' | 'raw'
  limit?: number
  params?: { mailbox?: string; since_date?: string; until_date?: string }
  expect_ids: number[]
  order?: 'set' | 'exact'
  expect_warnings: number
  expect_transformed_query?: string
}

interface Fixture {
  now: string
  tz_offset_minutes: number
  emails: FixtureEmail[]
  cases: FixtureCase[]
}

const fixturePath = resolve(__dirname, '../../../tests/fixtures/search_query_behavior.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE email_metadata (
      internal_id INTEGER PRIMARY KEY,
      subject TEXT,
      sender TEXT,
      sender_name TEXT,
      to_addr TEXT,
      cc_addr TEXT,
      date_received TEXT,
      mailbox TEXT,
      is_read INTEGER DEFAULT 0,
      is_flagged INTEGER DEFAULT 0,
      is_pinned INTEGER DEFAULT 0,
      is_important INTEGER DEFAULT 0,
      ai_priority TEXT,
      notion_page_id TEXT
    );

    CREATE VIRTUAL TABLE email_body_fts USING fts5(
      body_markdown,
      subject,
      sender,
      tokenize='porter unicode61 remove_diacritics 2'
    );

    CREATE TABLE email_attachment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      internal_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      is_inline INTEGER DEFAULT 0
    );

    CREATE TABLE llm_processing (
      internal_id INTEGER PRIMARY KEY,
      labels_json TEXT
    );
  `)

  const insertMeta = db.prepare(`
    INSERT INTO email_metadata
      (internal_id, subject, sender, sender_name, to_addr, cc_addr, date_received,
       mailbox, is_read, is_flagged, is_pinned, is_important, ai_priority, notion_page_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertFts = db.prepare(`
    INSERT INTO email_body_fts (rowid, body_markdown, subject, sender)
    VALUES (?, ?, ?, ?)
  `)
  const insertAttachment = db.prepare(`
    INSERT INTO email_attachment (internal_id, filename, is_inline)
    VALUES (?, ?, ?)
  `)

  for (const email of fixture.emails) {
    insertMeta.run(
      email.internal_id,
      email.subject,
      email.sender,
      email.sender_name,
      email.to_addr,
      email.cc_addr,
      email.date_received,
      email.mailbox,
      email.is_read,
      email.is_flagged,
      email.is_pinned,
      email.is_important,
      email.ai_priority,
      null
    )
    insertFts.run(email.internal_id, email.body_markdown, email.subject, email.sender)
    for (const attachment of email.attachments ?? []) {
      insertAttachment.run(email.internal_id, attachment.filename, attachment.is_inline)
    }
  }
  return db
}

beforeAll(() => {
  fixtureDb = buildDb()
})

afterAll(() => {
  fixtureDb?.close()
})

describe('search query behavior fixture', () => {
  test.each(fixture.cases)('$name', (item) => {
    const result = handlers.searchEmails({
      query: item.query,
      mode: item.mode ?? 'smart',
      limit: item.limit ?? 50,
      mailbox: item.params?.mailbox,
      since: item.params?.since_date,
      until: item.params?.until_date,
      now: fixture.now,
      tzOffsetMinutes: fixture.tz_offset_minutes
    })
    const ids = result.items.map((hit) => hit.internal_id)

    if (item.order === 'exact') {
      expect(ids).toEqual(item.expect_ids)
    } else {
      expect([...ids].sort((a, b) => a - b)).toEqual([...item.expect_ids].sort((a, b) => a - b))
    }

    expect(result.parse_warnings?.length ?? 0).toBe(item.expect_warnings)
    if (item.expect_transformed_query !== undefined) {
      expect(result.transformed_query).toBe(item.expect_transformed_query)
    }
  })
})
