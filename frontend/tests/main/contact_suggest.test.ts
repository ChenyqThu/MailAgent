import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'
import Database from 'better-sqlite3'

let fixtureDb: Database.Database | null = null

vi.mock('../../src/electron/main/db', () => ({
  getDb: () => fixtureDb as Database.Database,
  closeDb: () => {},
  resolveDbPath: () => ':memory:'
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

const contacts = await import('../../src/electron/main/handlers/contacts')

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE email_metadata (
      internal_id INTEGER PRIMARY KEY,
      sender TEXT,
      sender_name TEXT,
      to_addr TEXT,
      cc_addr TEXT,
      mailbox TEXT,
      date_received TEXT
    );
  `)
  const insert = db.prepare(`
    INSERT INTO email_metadata
      (internal_id, sender, sender_name, to_addr, cc_addr, mailbox, date_received)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  insert.run(
    1,
    'Alice <alice@example.com>',
    'Alice A',
    'Me <me@example.com>',
    '',
    '收件箱',
    '2026-06-01T09:00:00+08:00'
  )
  insert.run(
    2,
    'me@example.com',
    'Me',
    'Doe, Jane <jane@example.com>, Bob <bob@example.com>',
    'Project Team <team@example.com>',
    '发件箱',
    '2026-06-10T10:00:00+08:00'
  )
  insert.run(
    3,
    'jane@example.com',
    'Jane Latest',
    'Me <me@example.com>',
    '',
    '收件箱',
    '2026-06-12T12:00:00+08:00'
  )
  insert.run(
    4,
    'me@example.com',
    'Me',
    'Alice Old <alice@example.com>, Bob <bob@example.com>',
    '',
    '发件箱',
    '2026-06-11T08:00:00+08:00'
  )
  insert.run(
    5,
    'me@example.com',
    'Me',
    'Adam <adam@example.com>',
    '',
    '发件箱',
    '2026-06-09T08:00:00+08:00'
  )
  return db
}

beforeEach(() => {
  fixtureDb?.close()
  fixtureDb = buildDb()
  contacts.resetContactSuggestCache()
})

afterAll(() => {
  fixtureDb?.close()
})

describe('contact suggestions', () => {
  test('parses comma-split recipients and dedupes latest display name', () => {
    const items = contacts.aggregateContactSuggestions(fixtureDb!)
    const jane = items.find((item) => item.email === 'jane@example.com')
    const alice = items.find((item) => item.email === 'alice@example.com')

    expect(jane).toMatchObject({ email: 'jane@example.com', name: 'Jane Latest', score: 4 })
    expect(alice).toMatchObject({ email: 'alice@example.com', name: 'Alice Old', score: 4 })
    expect(items.some((item) => item.email === 'doe')).toBe(false)
  })

  test('empty q returns score top with sent-recipient weight', () => {
    const [first] = contacts.contactSuggest({ q: '', limit: 3, exclude: 'me@example.com' })

    expect(first).toMatchObject({ email: 'bob@example.com', score: 6 })
  })

  test('matches by name or email and sorts prefix hits before score', () => {
    const result = contacts.contactSuggest({ q: 'ad', limit: 5, exclude: 'me@example.com' })

    expect(result[0]?.email).toBe('adam@example.com')
  })

  test('exclude removes own email from suggestions', () => {
    const result = contacts.contactSuggest({ q: 'me', limit: 5, exclude: ['me@example.com'] })

    expect(result.map((item) => item.email)).not.toContain('me@example.com')
  })
})
