// Build an in-memory sqlite that mirrors the v6 sync_store.db schema closely
// enough for handler reads. We don't replicate the watcher's triggers or the
// llm_processing table — just the email_metadata / email_body / email_attachment
// / email_body_fts surfaces the IPC handlers in main/handlers/email.ts touch.
//
// Returned db is opened read-write so tests can seed rows; the handler module
// (after vi.mock of ../db) is re-routed to this connection so production
// code remains read-only against the real file.

import Database from 'better-sqlite3'

export function buildFixtureDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE email_metadata (
      internal_id INTEGER PRIMARY KEY,
      message_id TEXT UNIQUE,
      thread_id TEXT,
      subject TEXT,
      sender TEXT,
      sender_name TEXT,
      to_addr TEXT,
      cc_addr TEXT,
      date_received TEXT,
      mailbox TEXT,
      is_read INTEGER DEFAULT 0,
      is_flagged INTEGER DEFAULT 0,
      sync_status TEXT DEFAULT 'pending',
      notion_page_id TEXT,
      notion_thread_id TEXT,
      sync_error TEXT,
      retry_count INTEGER DEFAULT 0,
      next_retry_at REAL,
      created_at REAL,
      updated_at REAL,
      processing_status TEXT,
      web_action_at REAL,
      -- v8 / v9 columns the DAO now SELECTs as part of LIST_COLS — adding
      -- them here keeps the in-memory fixture schema-aligned with the live
      -- sync_store.db so handler reads don't OperationalError once the
      -- better-sqlite3 native binding ABI is rebuilt.
      is_pinned INTEGER DEFAULT 0,
      pinned_at REAL,
      is_important INTEGER DEFAULT 0,
      -- v14 (Sprint 16 cutover-day): 镜像 LLM AI 字段到主表, 让 EmailRow
      -- 渲染 + searchEmails palette 不再绕 llm_processing.labels_json
      -- (see d0a8086). fixture 之前漏 sync → searchEmails 测试全 fail.
      ai_priority TEXT,
      ai_action TEXT
    );
    CREATE INDEX idx_email_date ON email_metadata(date_received DESC);
    CREATE INDEX idx_email_sync_status ON email_metadata(sync_status);

    CREATE TABLE email_body (
      internal_id INTEGER PRIMARY KEY,
      message_id TEXT,
      body_html TEXT,
      body_markdown TEXT,
      body_format TEXT,
      body_size_bytes INTEGER,
      has_inline_images INTEGER DEFAULT 0,
      raw_mime_sha256 TEXT,
      fetched_at REAL NOT NULL,
      fetched_source TEXT NOT NULL,
      schema_version INTEGER DEFAULT 1,
      FOREIGN KEY (internal_id) REFERENCES email_metadata(internal_id) ON DELETE CASCADE
    );

    CREATE TABLE email_attachment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      internal_id INTEGER NOT NULL,
      content_id TEXT,
      filename TEXT NOT NULL,
      content_type TEXT,
      size_bytes INTEGER,
      is_inline INTEGER DEFAULT 0,
      local_path TEXT,
      sha256 TEXT,
      derived_from INTEGER,
      derived_format TEXT,
      notion_file_id TEXT,
      notion_block_id TEXT,
      created_at REAL NOT NULL,
      schema_version INTEGER DEFAULT 1
    );

    CREATE VIRTUAL TABLE email_body_fts USING fts5(
      body_markdown, subject, sender,
      tokenize='porter unicode61 remove_diacritics 2'
    );

    CREATE TABLE llm_processing (
      internal_id INTEGER PRIMARY KEY,
      notion_page_id TEXT,
      mailbox TEXT,
      status TEXT,
      retry_count INTEGER DEFAULT 0,
      next_retry_at REAL,
      last_error TEXT,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_input_tokens INTEGER,
      cache_creation_input_tokens INTEGER,
      latency_ms INTEGER,
      labels_json TEXT,
      created_at REAL,
      updated_at REAL
    );
  `)

  // Seed a small but realistic spread:
  //   - 3 inbox emails (one unread + flagged, one synced, one failed)
  //   - 1 sent email (synced, has CC)
  //   - 1 with attachment + derived PDF
  //   - body content covers both English and CN to exercise FTS5
  const insertMeta = db.prepare(`
    INSERT INTO email_metadata
      (internal_id, message_id, thread_id, subject, sender, sender_name,
       to_addr, cc_addr, date_received, mailbox, is_read, is_flagged,
       sync_status, notion_page_id, created_at, updated_at)
    VALUES (@internal_id, @message_id, @thread_id, @subject, @sender,
            @sender_name, @to_addr, @cc_addr, @date_received, @mailbox,
            @is_read, @is_flagged, @sync_status, @notion_page_id,
            @created_at, @updated_at)
  `)
  const insertBody = db.prepare(`
    INSERT INTO email_body
      (internal_id, message_id, body_html, body_markdown, body_format,
       body_size_bytes, has_inline_images, raw_mime_sha256, fetched_at, fetched_source)
    VALUES (@internal_id, @message_id, @body_html, @body_markdown, @body_format,
            @body_size_bytes, @has_inline_images, @raw_mime_sha256,
            @fetched_at, @fetched_source)
  `)
  const insertAtt = db.prepare(`
    INSERT INTO email_attachment
      (internal_id, content_id, filename, content_type, size_bytes,
       is_inline, local_path, sha256, derived_from, derived_format,
       notion_file_id, notion_block_id, created_at)
    VALUES (@internal_id, @content_id, @filename, @content_type, @size_bytes,
            @is_inline, @local_path, @sha256, @derived_from, @derived_format,
            @notion_file_id, @notion_block_id, @created_at)
  `)

  const now = Date.now() / 1000
  const metas = [
    {
      internal_id: 101,
      message_id: '<msg-101@example.com>',
      thread_id: 'thread-A',
      subject: 'redis timeout debug session',
      sender: 'alice@example.com',
      sender_name: 'Alice',
      to_addr: 'me@example.com',
      cc_addr: '',
      date_received: '2026-05-15T09:00:00+08:00',
      mailbox: '收件箱',
      is_read: 0,
      is_flagged: 1,
      sync_status: 'synced',
      notion_page_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      created_at: now - 3600,
      updated_at: now - 3600
    },
    {
      internal_id: 102,
      message_id: '<msg-102@example.com>',
      thread_id: 'thread-B',
      subject: '本周产品评审 — Notion 集成',
      sender: 'bob@example.com',
      sender_name: 'Bob',
      to_addr: 'me@example.com',
      cc_addr: 'team@example.com',
      date_received: '2026-05-14T15:30:00+08:00',
      mailbox: '收件箱',
      is_read: 1,
      is_flagged: 0,
      sync_status: 'synced',
      notion_page_id: '11111111-2222-3333-4444-555555555555',
      created_at: now - 7200,
      updated_at: now - 7200
    },
    {
      internal_id: 103,
      message_id: '<msg-103@example.com>',
      thread_id: 'thread-C',
      subject: 'Re: 服务器宕机 incident postmortem',
      sender: 'oncall@example.com',
      sender_name: 'Oncall',
      to_addr: 'me@example.com',
      cc_addr: '',
      date_received: '2026-05-13T22:10:00+08:00',
      mailbox: '收件箱',
      is_read: 0,
      is_flagged: 0,
      sync_status: 'failed',
      notion_page_id: null,
      created_at: now - 10800,
      updated_at: now - 10800
    },
    {
      internal_id: 201,
      message_id: '<msg-201@example.com>',
      thread_id: 'thread-D',
      subject: 'follow-up: Q2 OKR alignment',
      sender: 'me@example.com',
      sender_name: 'Me',
      to_addr: 'manager@example.com',
      cc_addr: '',
      date_received: '2026-05-12T11:00:00+08:00',
      mailbox: '发件箱',
      is_read: 1,
      is_flagged: 0,
      sync_status: 'synced',
      notion_page_id: '99999999-8888-7777-6666-555555555555',
      created_at: now - 14400,
      updated_at: now - 14400
    }
  ] as const

  const insertAll = db.transaction((rows: typeof metas) => {
    for (const m of rows) insertMeta.run(m)
  })
  insertAll(metas)

  // Bodies for 101 and 102; 103 has no body row (fetch_failed scenario).
  insertBody.run({
    internal_id: 101,
    message_id: '<msg-101@example.com>',
    body_html: '<p>Hey, the redis client keeps timing out after 5s.</p>',
    body_markdown: 'Hey, the redis client keeps timing out after 5s.',
    body_format: 'html',
    body_size_bytes: 64,
    has_inline_images: 0,
    raw_mime_sha256: 'sha256-aaa-101',
    fetched_at: now - 3500,
    fetched_source: 'applescript'
  })
  insertBody.run({
    internal_id: 102,
    message_id: '<msg-102@example.com>',
    body_html: '<p>本周 *产品* 评审议程：Notion 集成进度</p>',
    body_markdown: '本周 *产品* 评审议程：Notion 集成进度',
    body_format: 'html',
    body_size_bytes: 80,
    has_inline_images: 0,
    raw_mime_sha256: 'sha256-bbb-102',
    fetched_at: now - 7100,
    fetched_source: 'applescript'
  })

  // Manual FTS5 seed (the production schema has triggers that auto-populate;
  // we don't replicate them, so we insert rowid-aligned rows here directly).
  const ftsInsert = db.prepare(
    'INSERT INTO email_body_fts(rowid, body_markdown, subject, sender) VALUES (?, ?, ?, ?)'
  )
  ftsInsert.run(
    101,
    'Hey, the redis client keeps timing out after 5s.',
    'redis timeout debug session',
    'alice@example.com'
  )
  ftsInsert.run(
    102,
    '本周 *产品* 评审议程：Notion 集成进度',
    '本周产品评审 — Notion 集成',
    'bob@example.com'
  )

  // Attachments for 101: a PDF + its derived "preview" PDF.
  const att1 = insertAtt.run({
    internal_id: 101,
    content_id: null,
    filename: 'spec.docx',
    content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size_bytes: 4096,
    is_inline: 0,
    local_path: '/tmp/email-notion-sync/aaa/spec.docx',
    sha256: 'sha-att-1',
    derived_from: null,
    derived_format: null,
    notion_file_id: 'notion-file-001',
    notion_block_id: 'notion-block-001',
    created_at: now - 3400
  })
  insertAtt.run({
    internal_id: 101,
    content_id: null,
    filename: 'spec.pdf',
    content_type: 'application/pdf',
    size_bytes: 8192,
    is_inline: 0,
    local_path: '/tmp/email-notion-sync/aaa/spec.pdf',
    sha256: 'sha-att-2',
    derived_from: Number(att1.lastInsertRowid),
    derived_format: 'pdf',
    notion_file_id: 'notion-file-002',
    notion_block_id: 'notion-block-002',
    created_at: now - 3399
  })
  // Inline cid: image on 102 — must NOT bump the user-visible attach_count
  // (DESIGN.md §5.1 paperclip is for real attachments, not body images).
  insertAtt.run({
    internal_id: 102,
    content_id: 'logo@cid',
    filename: 'logo.png',
    content_type: 'image/png',
    size_bytes: 2048,
    is_inline: 1,
    local_path: '/tmp/email-notion-sync/bbb/logo.png',
    sha256: 'sha-att-3',
    derived_from: null,
    derived_format: null,
    notion_file_id: null,
    notion_block_id: null,
    created_at: now - 7000
  })

  // processing_status on metadata — set per the lifecycle table in
  // CLAUDE.md "Processing Status 生命周期". 103 (failed) keeps NULL so the
  // AIFieldsBlock fallback is exercised.
  db.prepare(
    `UPDATE email_metadata SET processing_status = 'AI Reviewed' WHERE internal_id = 101`
  ).run()
  db.prepare(
    `UPDATE email_metadata SET processing_status = '已同步'      WHERE internal_id = 102`
  ).run()
  db.prepare(
    `UPDATE email_metadata SET processing_status = '已完成'      WHERE internal_id = 201`
  ).run()

  // llm_processing seeds. Three scenarios:
  //   - 101: success + labels_json with full LLM output (incl. emoji priority)
  //   - 102: failed run, labels_json present from a prior partial write
  //   - 103: NO row — exercises the "LLM never ran" fallback in getAIFields()
  const insertLlm = db.prepare(`
    INSERT INTO llm_processing
      (internal_id, notion_page_id, mailbox, status,
       model, input_tokens, output_tokens, cache_read_input_tokens,
       cache_creation_input_tokens, latency_ms, labels_json, created_at, updated_at)
    VALUES (@internal_id, @notion_page_id, @mailbox, @status, @model,
            @input_tokens, @output_tokens, @cache_read_input_tokens,
            @cache_creation_input_tokens, @latency_ms, @labels_json,
            @created_at, @updated_at)
  `)
  insertLlm.run({
    internal_id: 101,
    notion_page_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    mailbox: '收件箱',
    status: 'success',
    model: 'claude-sonnet-4-6',
    input_tokens: 6000,
    output_tokens: 200,
    cache_read_input_tokens: 5800,
    cache_creation_input_tokens: 0,
    latency_ms: 1500,
    labels_json: JSON.stringify({
      ai_summary: 'Alice asked about a redis timeout — needs a reply.',
      key_points: '- timeout after 5s\n- prod issue',
      category: '🔧 技术支持',
      language: 'English',
      sender_priority: '外部联系人',
      action_required: true,
      action_type: '需要回复',
      priority: '🔴 紧急',
      urgency_reason: 'prod down',
      mail_actions: ['⚠️ Flagged'],
      daily_digest_date: '2026-05-15',
      related_project: '',
      mailbox: '收件箱',
      input_tokens: 6000,
      output_tokens: 200,
      cache_read_input_tokens: 5800,
      cache_creation_input_tokens: 0,
      model: 'claude-sonnet-4-6',
      latency_ms: 1500
    }),
    created_at: now - 3000,
    updated_at: now - 3000
  })
  insertLlm.run({
    internal_id: 102,
    notion_page_id: '11111111-2222-3333-4444-555555555555',
    mailbox: '收件箱',
    status: 'failed',
    model: 'claude-sonnet-4-6',
    input_tokens: null,
    output_tokens: null,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
    latency_ms: null,
    labels_json: JSON.stringify({
      language: '中文',
      priority: '🟡 重要',
      action_type: '需要决策',
      action_required: true
    }),
    created_at: now - 6000,
    updated_at: now - 6000
  })

  return db
}
