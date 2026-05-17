// Sprint 1.8 — handler unit tests + cli-schema shape validation.
//
// Two coverage layers:
//   1. Functional: each handler returns the expected rows under filters,
//      offsets, missing-internal-id, FTS5 query.
//   2. Schema: ajv against the same docs/cli-schema/*.schema.json that
//      generates the renderer types. If the backend bumps a schema and we
//      don't `pnpm gen:types`, this test fails loudly.

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js'

import { buildFixtureDb } from '../../fixtures/sync-store-fixture'

// vi.mock must be in module scope; we point the handler module at our fixture
// db instead of the production resolveDbPath() which would try to open
// ~/Documents/MailAgent/data/sync_store.db.
let fixtureDb: Database.Database
vi.mock('../../../src/electron/main/db', () => ({
  getDb: () => fixtureDb,
  closeDb: () => {},
  resolveDbPath: () => ':memory:'
}))

// Same here — handlers/email.ts calls ipcMain.handle() at module load via
// registerEmailHandlers, but we only need the pure DAO functions; stub
// ipcMain so importing the module doesn't crash outside Electron.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

// Now import the module under test (after vi.mock declarations).
const handlers = await import('../../../src/electron/main/handlers/email')

// ---- schema validator setup -------------------------------------------------

const SCHEMA_DIR = resolve(__dirname, '../../../../docs/cli-schema')

function loadAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  for (const f of readdirSync(SCHEMA_DIR)) {
    if (!f.endsWith('.schema.json')) continue
    const raw = JSON.parse(readFileSync(resolve(SCHEMA_DIR, f), 'utf8'))
    ajv.addSchema(raw, f)
  }
  return ajv
}

function compileFor(ajv: Ajv2020, file: string): ValidateFunction {
  // Schemas were `addSchema(raw, file)`'d up-front so $ref to _common works;
  // recompiling here would double-register and throw. `getSchema(key)`
  // returns the lazily-compiled validator.
  const v = ajv.getSchema(file)
  if (!v) throw new Error(`schema ${file} not registered in ajv`)
  return v
}

function wrap(data: unknown, metaExtra: Record<string, unknown> = {}): unknown {
  // email-search.schema.json marks query/total_hits/limit as required on meta;
  // most other schemas only need duration_ms. Tests pass the per-schema extras.
  return {
    status: 'success',
    schema_version: 1,
    data,
    meta: { duration_ms: 0, ...metaExtra }
  }
}

// ---- tests ------------------------------------------------------------------

let ajv: Ajv2020
let validateList: ValidateFunction
let validateGet: ValidateFunction
let validateBody: ValidateFunction
let validateSearch: ValidateFunction
let validateAttachmentList: ValidateFunction

beforeAll(() => {
  fixtureDb = buildFixtureDb()
  ajv = loadAjv()
  validateList = compileFor(ajv, 'email-list.schema.json')
  validateGet = compileFor(ajv, 'email-get.schema.json')
  validateBody = compileFor(ajv, 'email-body.schema.json')
  validateSearch = compileFor(ajv, 'email-search.schema.json')
  validateAttachmentList = compileFor(ajv, 'attachment-list.schema.json')
})

afterAll(() => {
  fixtureDb?.close()
})

describe('listEmails', () => {
  test('returns rows ordered by date desc and is schema-valid', () => {
    const rows = handlers.listEmails({ limit: 10 })
    expect(rows).toHaveLength(4)
    expect(rows[0]?.internal_id).toBe(101) // most recent date
    expect(rows[1]?.internal_id).toBe(102)
    expect(rows[2]?.internal_id).toBe(103)
    expect(rows[3]?.internal_id).toBe(201)

    const wrapped = wrap(rows, {
      total: rows.length,
      limit: 10,
      offset: 0,
      count: rows.length
    })
    const ok = validateList(wrapped)
    if (!ok) console.error('list schema errors:', validateList.errors)
    expect(ok).toBe(true)
  })

  test('honours mailbox filter', () => {
    const rows = handlers.listEmails({ mailbox: '发件箱' })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.sender).toBe('me@example.com')
  })

  test('honours status + isRead filters together', () => {
    const rows = handlers.listEmails({ status: 'synced', isRead: false })
    expect(rows.map((r) => r.internal_id)).toEqual([101])
  })

  test('limit clamps to ≥1', () => {
    const rows = handlers.listEmails({ limit: 0 })
    // clamp lower bound is 1 — at minimum we get the most recent row
    expect(rows.length).toBeGreaterThanOrEqual(1)
  })

  test('booleans round-trip correctly (is_read/is_flagged 0/1 → false/true)', () => {
    const [first] = handlers.listEmails({ mailbox: '收件箱', limit: 1 })
    expect(typeof first.is_read).toBe('boolean')
    expect(typeof first.is_flagged).toBe('boolean')
    expect(first.is_flagged).toBe(true) // internal_id 101 had is_flagged=1
  })

  test('notion_url shape', () => {
    const [first] = handlers.listEmails({ limit: 1 })
    expect(first.notion_url).toMatch(/^https:\/\/www\.notion\.so\/[a-f0-9]{32}$/)
  })
})

describe('getEmail', () => {
  test('returns full record with body summary and attachments', () => {
    const rec = handlers.getEmail(101)
    expect(rec).not.toBeNull()
    expect(rec?.body?.format).toBe('html')
    expect(rec?.attachments).toHaveLength(2)
    const [, derived] = rec!.attachments!
    expect(derived.derived_from).not.toBeNull()
    expect(derived.derived_format).toBe('pdf')

    const ok = validateGet(wrap(rec))
    if (!ok) console.error('schema errors:', validateGet.errors)
    expect(ok).toBe(true)
  })

  test('returns null when internal_id missing', () => {
    expect(handlers.getEmail(99_999)).toBeNull()
  })

  test('body is null when email_body row missing (fetch_failed case)', () => {
    const rec = handlers.getEmail(103)
    expect(rec?.body).toBeNull()
    expect(rec?.attachments).toEqual([])
  })
})

describe('getEmailBody', () => {
  test('markdown format returns body_markdown content', () => {
    const body = handlers.getEmailBody(101, 'markdown')
    expect(body?.format).toBe('markdown')
    expect(body?.content).toContain('redis client')
    expect(validateBody(wrap(body))).toBe(true)
  })

  test('html format returns body_html content', () => {
    const body = handlers.getEmailBody(101, 'html')
    expect(body?.format).toBe('html')
    expect(body?.content).toContain('<p>')
  })

  test('raw format returns only the sha256 hash', () => {
    const body = handlers.getEmailBody(101, 'raw')
    expect(body?.format).toBe('raw')
    expect(body?.content).toBe('sha256-aaa-101')
  })

  test('missing internal_id returns null', () => {
    expect(handlers.getEmailBody(99_999, 'markdown')).toBeNull()
  })
})

describe('searchEmails (FTS5)', () => {
  test('English word hit', () => {
    const hits = handlers.searchEmails({ query: 'redis', limit: 10 })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.internal_id).toBe(101)
    expect(hits[0]?.snippet ?? '').toContain('<mark>')
    const wrapped = wrap(hits, { query: 'redis', total_hits: hits.length, limit: 10 })
    const ok = validateSearch(wrapped)
    if (!ok) console.error('search schema errors:', validateSearch.errors)
    expect(ok).toBe(true)
  })

  test('CJK prefix-wildcard hit (DESIGN.md note: unicode61 needs * for plain CN)', () => {
    const hits = handlers.searchEmails({ query: '产品*', limit: 10 })
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0]?.internal_id).toBe(102)
  })

  test('mailbox filter narrows results', () => {
    const all = handlers.searchEmails({ query: 'notion', limit: 10 })
    const sent = handlers.searchEmails({ query: 'notion', mailbox: '发件箱', limit: 10 })
    expect(sent.length).toBeLessThanOrEqual(all.length)
  })

  test('empty query short-circuits to []', () => {
    expect(handlers.searchEmails({ query: '   ', limit: 10 })).toEqual([])
  })

  test('rank is monotonically non-decreasing (smaller = better per bm25)', () => {
    const hits = handlers.searchEmails({ query: 'redis OR 产品*', limit: 10 })
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.rank).toBeGreaterThanOrEqual(hits[i - 1]!.rank)
    }
  })
})

describe('attachment shape', () => {
  test('the attachments[] inside email:get matches attachment-list schema', () => {
    const rec = handlers.getEmail(101)!
    expect(validateAttachmentList(wrap(rec.attachments))).toBe(true)
  })
})
