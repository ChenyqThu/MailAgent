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

/**
 * 通讯录三表（DB v54）的最小但忠实的 DDL —— 只含 `DIRECTORY_SQL` 真正 SELECT
 * 的列。表结构与 `MAILAGENT_CONTACTS_ENABLED` 解耦恒在，故这里只造表不造 flag。
 */
function addDirectory(db: Database.Database): void {
  db.exec(`
    CREATE TABLE contact (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT,
      formal_name TEXT,
      organization TEXT,
      name_variants_json TEXT,
      is_self INTEGER NOT NULL DEFAULT 0,
      hidden_at INTEGER,
      merged_into INTEGER
    );
    CREATE TABLE contact_email (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      email_normalized TEXT NOT NULL UNIQUE,
      is_primary INTEGER NOT NULL DEFAULT 0,
      former_at INTEGER
    );
  `)
}

interface SeedContact {
  display_name?: string | null
  formal_name?: string | null
  organization?: string | null
  name_variants_json?: string | null
  is_self?: number
  hidden_at?: number | null
  merged_into?: number | null
  emails: Array<{ email: string; is_primary?: number; former_at?: number | null }>
}

function seedContact(db: Database.Database, c: SeedContact): number {
  const info = db
    .prepare(
      `INSERT INTO contact
         (display_name, formal_name, organization, name_variants_json, is_self, hidden_at, merged_into)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      c.display_name ?? null,
      c.formal_name ?? null,
      c.organization ?? null,
      c.name_variants_json ?? null,
      c.is_self ?? 0,
      c.hidden_at ?? null,
      c.merged_into ?? null
    )
  const contactId = Number(info.lastInsertRowid)
  const insertEmail = db.prepare(
    `INSERT INTO contact_email (contact_id, email_normalized, is_primary, former_at)
     VALUES (?, ?, ?, ?)`
  )
  for (const e of c.emails) {
    insertEmail.run(contactId, e.email, e.is_primary ?? 0, e.former_at ?? null)
  }
  return contactId
}

/** 固定 fixture：改过名 + 组织 + 曾用邮箱 + 零往来 + 三类排除各一条。 */
function seedDirectory(db: Database.Database): void {
  addDirectory(db)
  // 邮件头里叫 "Alice Old"，通讯录里已改名；另有一个曾用邮箱。
  seedContact(db, {
    display_name: '张三',
    formal_name: 'Alice Zhang',
    organization: 'Acme Networks',
    name_variants_json: JSON.stringify(['Alice Old']),
    emails: [
      { email: 'alice@example.com', is_primary: 1 },
      { email: 'alice.legacy@example.com', former_at: 1_700_000_000_000 }
    ]
  })
  // 零往来（组织关系补出来的人），邮件头里根本没有这个地址。
  seedContact(db, {
    display_name: '李四',
    formal_name: 'Lisi Li',
    organization: 'Acme Networks',
    emails: [{ email: 'lisi@example.com', is_primary: 1 }]
  })
  // 三类排除：自己 / 隐藏（噪音群发地址）/ 合并墓碑。
  seedContact(db, { display_name: 'Me', is_self: 1, emails: [{ email: 'me@example.com' }] })
  seedContact(db, {
    display_name: 'Project Team',
    hidden_at: 1_700_000_000_000,
    emails: [{ email: 'team@example.com' }]
  })
  seedContact(db, {
    display_name: 'Jane Ghost',
    merged_into: 1,
    emails: [{ email: 'jane.ghost@example.com' }]
  })
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

describe('contact directory lane', () => {
  test('directory display_name wins over the mail-header name', () => {
    seedDirectory(fixtureDb!)

    const [hit] = contacts.contactSuggest({ q: 'alice@', limit: 5, exclude: 'me@example.com' })

    // 邮件头里最后一次见到的名字是 "Alice Old"，通讯录改成了「张三」。
    expect(hit).toMatchObject({ email: 'alice@example.com', name: '张三', score: 4 })
  })

  test('searchable by chinese name / formal_name / organization / former email', () => {
    seedDirectory(fixtureDb!)
    const emails = (q: string) =>
      contacts.contactSuggest({ q, limit: 10, exclude: 'me@example.com' }).map((i) => i.email)

    expect(emails('张')).toContain('alice@example.com')
    expect(emails('alice zhang')).toContain('alice@example.com')
    expect(emails('acme')).toEqual(
      expect.arrayContaining(['alice@example.com', 'lisi@example.com'])
    )
    // 曾用邮箱按地址也能搜到，且带的是这个人的 display_name。
    expect(
      contacts.contactSuggest({ q: 'alice.legacy', limit: 5 })[0]
    ).toMatchObject({ email: 'alice.legacy@example.com', name: '张三' })
  })

  test('directory-only person (zero mail history) is suggestible', () => {
    seedDirectory(fixtureDb!)

    const [hit] = contacts.contactSuggest({ q: '李四', limit: 5 })

    expect(hit).toMatchObject({ email: 'lisi@example.com', name: '李四', score: 0 })
    expect(hit?.last_seen).toBeUndefined()
  })

  test('merged / hidden / self contacts never enter candidates', () => {
    seedDirectory(fixtureDb!)
    const emails = (q: string) => contacts.contactSuggest({ q, limit: 20 }).map((i) => i.email)

    // 合并墓碑（通讯录侧条目）不出现。
    expect(emails('jane.ghost')).toHaveLength(0)
    // 隐藏 / 自己：连**邮件头聚合出来的同一地址**也一并压掉（不传 exclude 也不出现）。
    expect(emails('team')).toHaveLength(0)
    expect(emails('me@')).toHaveLength(0)
  })

  test('primary email sorts before the former one, both carry display_name', () => {
    seedDirectory(fixtureDb!)

    const hits = contacts
      .contactSuggest({ q: '张三', limit: 10 })
      .map((i) => ({ email: i.email, name: i.name }))

    expect(hits).toEqual([
      { email: 'alice@example.com', name: '张三' },
      { email: 'alice.legacy@example.com', name: '张三' }
    ])
  })

  test('directory name hit outranks substring noise but not a frequent prefix hit', () => {
    seedDirectory(fixtureDb!)
    // 'a' 前缀：adam(score 3) / alice(score 4, 通讯录名「张三」) 都是前缀命中，
    // 零往来的 lisi 只在 organization 'Acme Networks' 上前缀命中 → 同档但 score 0。
    const result = contacts.contactSuggest({ q: 'a', limit: 10, exclude: 'me@example.com' })
    const emails = result.map((i) => i.email)

    expect(emails.indexOf('alice@example.com')).toBeLessThan(emails.indexOf('lisi@example.com'))
    expect(emails.indexOf('adam@example.com')).toBeLessThan(emails.indexOf('lisi@example.com'))
    expect(emails).toContain('lisi@example.com')
  })

  test('resetContactSuggestCache drops the merged lane too', () => {
    expect(contacts.contactSuggest({ q: 'alice@', limit: 5 })[0]?.name).toBe('Alice Old')

    seedDirectory(fixtureDb!)
    contacts.resetContactSuggestCache()

    expect(contacts.contactSuggest({ q: 'alice@', limit: 5 })[0]?.name).toBe('张三')
  })

  test('empty directory tables leave results byte-identical to no tables at all', () => {
    const before = contacts.contactSuggest({ q: '', limit: 10, exclude: 'me@example.com' })

    addDirectory(fixtureDb!)
    contacts.resetContactSuggestCache()
    const after = contacts.contactSuggest({ q: '', limit: 10, exclude: 'me@example.com' })

    expect(after).toEqual(before)
    expect(after.length).toBeGreaterThan(0)
  })
})
