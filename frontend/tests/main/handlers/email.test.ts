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
const preparedSql: string[] = []
vi.mock('../../../src/electron/main/db', () => ({
  getDb: () => ({
    prepare: (sql: string) => {
      preparedSql.push(sql)
      return fixtureDb.prepare(sql)
    }
  }),
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
// attachment:list 面 —— 与 email:get 的内嵌附件是两个形状 (12 vs 11 字段),
// 「attachment shape」describe 块把两者一起钉住, 防再次混用 (2026-07-27 审计 #3)。
const attachmentHandlers = await import('../../../src/electron/main/handlers/attachment')

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
let validateAttachmentList: ValidateFunction

beforeAll(() => {
  fixtureDb = buildFixtureDb()
  ajv = loadAjv()
  validateList = compileFor(ajv, 'email-list.schema.json')
  validateGet = compileFor(ajv, 'email-get.schema.json')
  validateBody = compileFor(ajv, 'email-body.schema.json')
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

  // issue #42 后续 — 内建三视图按判定集 IN(...) 认变体行。fork 生产实证: 库里
  // mailbox='INBOX' 的历史行之前恒精确匹配 '收件箱' → 收件箱视图不可见, 只在
  // 「所有邮件」露出, 而判定面 (Sent 游标/报告/飞书) 已认全变体。
  test('builtin view matches mailbox label variants', () => {
    const db = fixtureDb
    db.prepare(
      `INSERT INTO email_metadata (internal_id, message_id, subject, sender, mailbox,
                                   date_received, is_read, is_flagged, sync_status)
       VALUES (9901, '<variant@example.com>', 'variant', 'eve@x', 'INBOX',
               '2026-05-02 09:00:00', 0, 0, 'synced')`
    ).run()
    try {
      expect(handlers.listEmails({ mailbox: '收件箱' }).map((r) => r.internal_id)).toContain(9901)
      // 传变体本身同解
      expect(handlers.listEmails({ mailbox: 'INBOX' }).map((r) => r.internal_id)).toContain(101)
    } finally {
      db.prepare('DELETE FROM email_metadata WHERE internal_id = 9901').run()
    }
  })

  // 🔴 已知取舍的反向锁 — 自定义文件夹视图维持精确匹配, 变体展开不得泄漏进去。
  test('custom folder filter stays exact', () => {
    const db = fixtureDb
    db.prepare(
      `INSERT INTO email_metadata (internal_id, message_id, subject, sender, mailbox,
                                   date_received, is_read, is_flagged, sync_status)
       VALUES (9902, '<folder@example.com>', 'folder', 'frank@x', 'ProjectX',
               '2026-05-03 09:00:00', 0, 0, 'synced')`
    ).run()
    try {
      expect(handlers.listEmails({ mailbox: 'ProjectX' }).map((r) => r.internal_id)).toEqual([9902])
      expect(handlers.listEmails({ mailbox: '收件箱' }).map((r) => r.internal_id)).not.toContain(
        9902
      )
    } finally {
      db.prepare('DELETE FROM email_metadata WHERE internal_id = 9902').run()
    }
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
  test('returns metadata and attachments without querying email_body', () => {
    preparedSql.length = 0
    const rec = handlers.getEmail(101)
    expect(rec).not.toBeNull()
    expect(rec?.body).toBeNull()
    expect(rec?.attachments).toHaveLength(2)
    const [, derived] = rec!.attachments!
    expect(derived.derived_from).not.toBeNull()
    expect(derived.derived_format).toBe('pdf')

    const ok = validateGet(wrap(rec))
    if (!ok) console.error('schema errors:', validateGet.errors)
    expect(ok).toBe(true)
    expect(preparedSql.some((sql) => sql.includes('FROM email_body'))).toBe(false)
  })

  test('returns null when internal_id missing', () => {
    expect(handlers.getEmail(99_999)).toBeNull()
  })

  // 2026-07-27 镜像审计 P1: is_important 一直在 LIST_COLS 的 SELECT 里, 但
  // shapeFullRecord 漏投影 → EmailDetail 的 ❗ 徽标永不渲染 + ComposePanel
  // draft-edit 静默丢高重要性。web (serve-api wire.meta_to_dict include_important)
  // 一直是对的, 只有桌面漏。语义两侧一致: 非空 bool, NULL/0 → false。
  test('surfaces is_important (P1: 曾漏投影, ❗ 徽标永不渲染)', () => {
    const db = fixtureDb
    db.prepare('UPDATE email_metadata SET is_important = 1 WHERE internal_id = 101').run()
    try {
      expect(handlers.getEmail(101)?.is_important).toBe(true)
      // 其余行仍是 false (不是 undefined —— 投影恒发, 与 Python bool(row) 同口径)。
      expect(handlers.getEmail(102)?.is_important).toBe(false)
    } finally {
      db.prepare('UPDATE email_metadata SET is_important = 0 WHERE internal_id = 101').run()
    }
  })

  test('body is null when email_body row missing (fetch_failed case)', () => {
    const rec = handlers.getEmail(103)
    expect(rec?.body).toBeNull()
    expect(rec?.attachments).toEqual([])
  })
})

describe('getEmailBody', () => {
  test('markdown format returns body_markdown content', () => {
    preparedSql.length = 0
    const body = handlers.getEmailBody(101, 'markdown')
    expect(body?.format).toBe('markdown')
    expect(body?.content).toContain('redis client')
    expect(validateBody(wrap(body))).toBe(true)
    const sql = preparedSql.find((item) => item.includes('FROM email_body')) ?? ''
    expect(sql).toContain('body_markdown AS content')
    expect(sql).not.toContain('body_html')
    expect(body?.truncated).toBe(false)
  })

  test('html format returns body_html content', () => {
    preparedSql.length = 0
    const body = handlers.getEmailBody(101, 'html')
    expect(body?.format).toBe('html')
    expect(body?.content).toContain('<p>')
    const sql = preparedSql.find((item) => item.includes('FROM email_body')) ?? ''
    expect(sql).toContain('body_html AS content')
    expect(sql).not.toContain('body_markdown')
  })

  test('raw format returns only the sha256 hash', () => {
    const body = handlers.getEmailBody(101, 'raw')
    expect(body?.format).toBe('raw')
    expect(body?.content).toBe('sha256-aaa-101')
  })

  test('missing internal_id returns null', () => {
    expect(handlers.getEmailBody(99_999, 'markdown')).toBeNull()
  })

  test('preview truncates oversized markdown while full mode returns all content', () => {
    const content = 'A'.repeat(300_000)
    fixtureDb
      .prepare(
        'UPDATE email_body SET body_markdown = ?, body_size_bytes = ? WHERE internal_id = 101'
      )
      .run(content, 300_000)
    try {
      const preview = handlers.getEmailBody(101, 'markdown', 'preview')
      const full = handlers.getEmailBody(101, 'markdown', 'full')
      expect(preview?.truncated).toBe(true)
      expect(preview?.content).toHaveLength(64 * 1024)
      expect(full?.truncated).toBe(false)
      expect(full?.content).toHaveLength(300_000)
    } finally {
      fixtureDb
        .prepare(
          'UPDATE email_body SET body_markdown = ?, body_size_bytes = ? WHERE internal_id = 101'
        )
        .run('Hey, the redis client keeps timing out after 5s.', 57)
    }
  })
})

describe('attachment shape', () => {
  // 这条以前断言的是「内嵌附件满足 **attachment-list** schema」—— 那是另一个 payload
  // 的契约 (它 required internal_id)。内嵌附件真正受 email-get.schema.json 的
  // attachments.items 管 (11 字段, 无 internal_id), 与 Python
  // wire.attachment_to_dict 的默认形一致 —— 后者在 wire.py gotcha #1 是有意决定,
  // 且被 tests/cli/test_wire_parity.py 钉死。旧断言把 TS 侧多带 internal_id 的
  // accident 固化成了「契约」(2026-07-27 镜像审计 #3)。
  test('内嵌附件是 11 字段形, 不含 internal_id (对齐 Python wire 默认形)', () => {
    const rec = handlers.getEmail(101)!
    const [first] = rec.attachments!
    expect(first).toBeDefined()
    // 镜像 test_wire_parity.py: 绝不回显 internal_id / host 路径。
    expect(first).not.toHaveProperty('internal_id')
    expect(first).not.toHaveProperty('local_path')
    // 整条记录 (含内嵌附件) 仍走 email-get schema 校验 —— 见 getEmail 用例的 validateGet。
    expect(validateGet(wrap(rec))).toBe(true)
  })

  // 独立的 attachment:list 面才带 internal_id —— 它有自己的 shaper
  // (handlers/attachment.ts) 与自己的 schema。两个形状不可混用。
  test('attachment:list 面仍是 12 字段形 (含 internal_id)', () => {
    const rows = attachmentHandlers.listAttachments(101)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]).toHaveProperty('internal_id', 101)
    expect(validateAttachmentList(wrap(rows))).toBe(true)
  })
})

// ---- Sprint 2 D0: enriched view IPCs -----------------------------------------

describe('listEmailsEnriched', () => {
  test('returns rows in date-desc order with body snippet + LLM labels + attach count', () => {
    const rows = handlers.listEmailsEnriched({ limit: 10 })
    expect(rows.map((r) => r.internal_id)).toEqual([101, 102, 103, 201])

    // 101 — denormalized snippet + full LLM labels + 2 non-inline attachments.
    expect(rows[0].snippet).toMatch(/^Hey, the redis client/)
    expect(rows[0].lang).toBe('en')
    expect(rows[0].ai_priority).toBe('critical') // mapped from "🔴 紧急"
    expect(rows[0].ai_action).toBe('需要回复')
    expect(rows[0].attach_count).toBe(2)

    // 102 — has CN body + partial LLM labels + only an inline (cid:) attachment
    // The inline image must NOT bump the user-visible attach_count.
    expect(rows[1].snippet?.startsWith('本周 *产品*')).toBe(true)
    expect(rows[1].lang).toBe('zh')
    expect(rows[1].ai_priority).toBe('important') // mapped from "🟡 重要"
    expect(rows[1].ai_action).toBe('需要决策')
    expect(rows[1].attach_count).toBe(0)

    // 103 — fetch_failed, no email_body row, no llm_processing row
    expect(rows[2].snippet).toBeNull()
    expect(rows[2].lang).toBe('unknown')
    expect(rows[2].ai_priority).toBeNull()
    expect(rows[2].ai_action).toBeNull()
    expect(rows[2].attach_count).toBe(0)

    // 201 — no body/snippet seeded; no LLM row either
    expect(rows[3].snippet).toBeNull()
    expect(rows[3].lang).toBe('unknown')
    expect(rows[3].ai_priority).toBeNull()
  })

  test('mailbox filter does not trip the JOIN ambiguity (m.mailbox vs llm.mailbox)', () => {
    const rows = handlers.listEmailsEnriched({ mailbox: '发件箱' })
    expect(rows).toHaveLength(1)
    expect(rows[0].internal_id).toBe(201)
  })

  test('honours isRead + status filters', () => {
    const rows = handlers.listEmailsEnriched({ status: 'synced', isRead: false })
    expect(rows.map((r) => r.internal_id)).toEqual([101])
  })

  test('cli.gen.ts EmailMeta core fields are intact (extends contract)', () => {
    const row = handlers.listEmailsEnriched({ limit: 1 })[0]!
    // Schema-anchored fields must still be there and well-shaped
    expect(typeof row.internal_id).toBe('number')
    expect(typeof row.subject).toBe('string')
    expect(typeof row.sender).toBe('string')
    expect(typeof row.is_read).toBe('boolean')
    expect(typeof row.is_flagged).toBe('boolean')
    expect(row.notion_url).toMatch(/^https:\/\/www\.notion\.so\/[a-f0-9]{32}$/)
  })
})

describe('listMailboxes', () => {
  test('aggregates per mailbox with total + unread + flagged + failed counts', () => {
    const rows = handlers.listMailboxes()
    // 收件箱 has 3 rows (101 unread+flagged, 102 read, 103 unread+failed) →
    //   total=3, unread=2, flagged=1, failed=1
    // 发件箱 has 1 row (201 read, synced) → total=1, all-zero counts
    // Sprint 10 user-acceptance shape: listMailboxes now returns flagged +
    // failed alongside total + unread so the Sidebar virtual entries can
    // surface real counts (previous hardcoded 0).
    expect(rows).toEqual([
      { mailbox: '收件箱', total: 3, unread: 2, flagged: 1, failed: 1 },
      { mailbox: '发件箱', total: 1, unread: 0, flagged: 0, failed: 0 }
    ])
  })

  test('excludes NULL / empty-string mailbox rows', () => {
    // Insert a row with mailbox=NULL; it must not show up in the list.
    const db = fixtureDb
    db.prepare(
      `INSERT INTO email_metadata (internal_id, message_id, subject, sender, mailbox, is_read, is_flagged)
       VALUES (999, '<orphan@example.com>', 'orphan', 'x@x', NULL, 0, 0)`
    ).run()
    try {
      const rows = handlers.listMailboxes()
      // Should still be 2 entries (the NULL-mailbox row excluded)
      expect(rows.map((r) => r.mailbox)).toEqual(['收件箱', '发件箱'])
    } finally {
      db.prepare('DELETE FROM email_metadata WHERE internal_id = 999').run()
    }
  })
})

describe('listEmailsByThread', () => {
  test('returns sibling rows ordered by date ASC for a multi-member thread', () => {
    const db = fixtureDb
    // Seed two extra siblings on thread-A so there's a real thread to walk.
    db.prepare(
      `INSERT INTO email_metadata
         (internal_id, message_id, thread_id, subject, sender, mailbox,
          is_read, is_flagged, sync_status, notion_page_id, date_received)
       VALUES (104, '<msg-104@example.com>', 'thread-A', 'Re: redis timeout debug session',
               'alice@example.com', '收件箱', 1, 0, 'synced',
               'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee', '2026-05-15T11:00:00+08:00')`
    ).run()
    db.prepare(
      `INSERT INTO email_metadata
         (internal_id, message_id, thread_id, subject, sender, mailbox,
          is_read, is_flagged, sync_status, notion_page_id, date_received)
       VALUES (100, '<msg-100@example.com>', 'thread-A', 'redis timeout debug session',
               'alice@example.com', '收件箱', 1, 0, 'synced',
               'dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee', '2026-05-15T07:00:00+08:00')`
    ).run()
    try {
      const rows = handlers.listEmailsByThread('thread-A')
      // 100 (07:00) → 101 (09:00) → 104 (11:00) chronological ascending
      expect(rows.map((r) => r.internal_id)).toEqual([100, 101, 104])
      expect(rows[0].thread_id).toBe('thread-A')
      expect(rows[0].notion_url).toMatch(/^https:\/\/www\.notion\.so\/[a-f0-9]{32}$/)
      expect(typeof rows[0].is_read).toBe('boolean')
      expect(rows[1].snippet).toMatch(/^Hey, the redis client/)
    } finally {
      db.prepare('DELETE FROM email_metadata WHERE internal_id IN (100, 104)').run()
    }
  })

  test('single-member thread returns just the one email', () => {
    const rows = handlers.listEmailsByThread('thread-B')
    expect(rows).toHaveLength(1)
    expect(rows[0].internal_id).toBe(102)
    expect(rows[0].snippet?.startsWith('本周 *产品*')).toBe(true)
  })

  test('batch thread rows include denormalized snippets', () => {
    const rows = handlers.listEmailsByThreads(['thread-A', 'thread-B'])
    expect(rows['thread-A']?.find((row) => row.internal_id === 101)?.snippet).toMatch(
      /^Hey, the redis client/
    )
    expect(rows['thread-B']?.[0]?.snippet?.startsWith('本周 *产品*')).toBe(true)
  })

  test('unknown thread_id returns empty list (not null)', () => {
    expect(handlers.listEmailsByThread('thread-does-not-exist')).toEqual([])
  })

  test('empty / null thread_id input → empty list', () => {
    expect(handlers.listEmailsByThread('')).toEqual([])
    expect(handlers.listEmailsByThread(null as unknown as string)).toEqual([])
  })
})

describe('getAIFields', () => {
  test('decodes labels_json + processing_status + review status for a fully-LLM-processed row', () => {
    const f = handlers.getAIFields(101)!
    expect(f.internal_id).toBe(101)
    expect(f.processing_status).toBe('AI Reviewed')
    expect(f.mailbox).toBe('收件箱')
    expect(f.is_read).toBe(false)
    expect(f.is_flagged).toBe(true)
    expect(f.ai_priority).toBe('critical')
    expect(f.ai_action).toBe('需要回复')
    expect(f.ai_review_status).toBe('reviewed') // llm_status='success' → reviewed
    expect(f.sentiment).toBeNull() // agent doesn't emit this — REVIEW-LOG H-14 follow-up
    expect(f.labels_raw).not.toBeNull()
    expect(f.labels_raw?.category).toBe('🔧 技术支持')
  })

  test('failed LLM run still surfaces partial labels but review_status = pending', () => {
    const f = handlers.getAIFields(102)!
    expect(f.processing_status).toBe('已同步')
    expect(f.ai_priority).toBe('important')
    expect(f.ai_action).toBe('需要决策')
    expect(f.ai_review_status).toBe('pending') // llm_status='failed' → pending
    expect(f.labels_raw?.language).toBe('中文')
  })

  test('no llm_processing row at all → ai_* fields null', () => {
    const f = handlers.getAIFields(103)!
    expect(f.processing_status).toBeNull()
    expect(f.ai_priority).toBeNull()
    expect(f.ai_action).toBeNull()
    expect(f.ai_review_status).toBeNull()
    expect(f.labels_raw).toBeNull()
  })

  test('returns null for a missing internal_id', () => {
    expect(handlers.getAIFields(99_999)).toBeNull()
  })
})
