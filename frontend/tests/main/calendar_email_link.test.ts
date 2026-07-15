// 阶段 2.1 (P1-3) — calendar:emailCalendarLink / calendar:eventSourceEmail
// (email_meeting 映射直读, better-sqlite3 in-memory fixture).

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

const { runEmailCalendarLink, runEventSourceEmail } =
  await import('../../src/electron/main/handlers/calendar-read')

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE email_metadata (
      internal_id INTEGER PRIMARY KEY,
      message_id TEXT,
      subject TEXT,
      sender TEXT,
      sender_name TEXT,
      date_received TEXT,
      mailbox TEXT
    );
    CREATE TABLE email_meeting (
      internal_id INTEGER PRIMARY KEY,
      ical_uid TEXT NOT NULL,
      method TEXT,
      recurrence_id TEXT,
      sequence INTEGER NOT NULL DEFAULT 0,
      is_recurring INTEGER NOT NULL DEFAULT 0,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
    CREATE TABLE calendar_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ical_uid TEXT NOT NULL,
      recurrence_id TEXT,
      sequence INTEGER NOT NULL DEFAULT 0,
      calendar_name TEXT,
      summary TEXT,
      description TEXT,
      location TEXT,
      organizer TEXT,
      attendees_json TEXT,
      dtstart_utc REAL NOT NULL,
      dtend_utc REAL,
      is_all_day INTEGER NOT NULL DEFAULT 0,
      rrule TEXT,
      exdates_json TEXT,
      rdates_json TEXT,
      status TEXT,
      response_status TEXT,
      url TEXT,
      ics_raw TEXT,
      source TEXT NOT NULL DEFAULT 'caldav',
      notion_page_id TEXT,
      related_email_internal_id INTEGER,
      last_synced_at REAL NOT NULL,
      deleted_at REAL,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      tzid TEXT
    );
  `)

  const insEmail = db.prepare(
    `INSERT INTO email_metadata (internal_id, message_id, subject, sender, sender_name, date_received, mailbox)
     VALUES (?, ?, ?, 'boss@example.com', 'Boss', ?, '收件箱')`
  )
  insEmail.run(101, '<req-new@x>', 'New request', '2026-07-02T09:00:00+08:00')
  insEmail.run(102, '<cancel@x>', 'Cancel', '2026-07-03T09:00:00+08:00')
  insEmail.run(103, '<nocal@x>', 'Orphan invite', '2026-07-01T09:00:00+08:00')

  const insMeeting = db.prepare(
    `INSERT INTO email_meeting (internal_id, ical_uid, method, sequence, is_recurring, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 1)`
  )
  insMeeting.run(101, 'uid-series', 'REQUEST', 2, 1)
  insMeeting.run(102, 'uid-series', 'CANCEL', 3, 1)
  insMeeting.run(103, 'uid-no-cal', 'REQUEST', 0, 0)

  const insEvent = db.prepare(
    `INSERT INTO calendar_event (ical_uid, recurrence_id, summary, calendar_name, dtstart_utc, dtend_utc, source, last_synced_at, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, 'Work', 1780000000, 1780003600, ?, 1, ?, 1, 1)`
  )
  // uid-series: 跳脱 occurrence 行 + email_ics master + caldav master (应选中 caldav master)
  insEvent.run('uid-series', '2026-07-04T01:00:00+00:00', 'Detached', 'caldav', null)
  insEvent.run('uid-series', null, 'Master (email_ics)', 'email_ics', null)
  insEvent.run('uid-series', null, 'Master (caldav)', 'caldav', null)
  // uid-deleted-only: 仅软删行
  insEvent.run('uid-deleted-only', null, 'Gone', 'caldav', 123)
  return db
}

beforeEach(() => {
  fixtureDb?.close()
  fixtureDb = buildDb()
})

afterAll(() => {
  fixtureDb?.close()
  fixtureDb = null
})

describe('calendar — runEmailCalendarLink (方向 A)', () => {
  test('返回映射 + caldav master 行优先', () => {
    const link = runEmailCalendarLink(101)
    expect(link).not.toBeNull()
    expect(link!.ical_uid).toBe('uid-series')
    expect(link!.method).toBe('REQUEST')
    expect(link!.is_recurring).toBe(true)
    expect(link!.in_calendar).toBe(true)
    // master 选取: recurrence_id NULL 优先 + caldav > email_ics
    expect(link!.event?.summary).toBe('Master (caldav)')
    expect(link!.event?.source).toBe('caldav')
    expect(link!.event?.recurrence_id).toBeNull()
  })

  test('无映射邮件 → null', () => {
    expect(runEmailCalendarLink(999)).toBeNull()
  })

  test('uid 无日历行 → in_calendar=false + event=null', () => {
    const link = runEmailCalendarLink(103)
    expect(link).not.toBeNull()
    expect(link!.in_calendar).toBe(false)
    expect(link!.event).toBeNull()
  })

  test('uid 仅剩软删行 → in_calendar=false', () => {
    fixtureDb!
      .prepare(
        `INSERT INTO email_meeting (internal_id, ical_uid, method, created_at, updated_at)
         VALUES (104, 'uid-deleted-only', 'REQUEST', 1, 1)`
      )
      .run()
    fixtureDb!
      .prepare(
        `INSERT INTO email_metadata (internal_id, subject, date_received) VALUES (104, 'Del', '2026-07-01T09:00:00+08:00')`
      )
      .run()
    const link = runEmailCalendarLink(104)
    expect(link!.in_calendar).toBe(false)
    expect(link!.event).toBeNull()
  })
})

describe('calendar — runEventSourceEmail (方向 B)', () => {
  test('多封同 uid → 优先最新 REQUEST (非最新的 CANCEL)', () => {
    const src = runEventSourceEmail('uid-series')
    expect(src).not.toBeNull()
    // 102 (CANCEL) 日期更新, 但 REQUEST 语义优先 → 101
    expect(src!.internal_id).toBe(101)
    expect(src!.method).toBe('REQUEST')
    expect(src!.subject).toBe('New request')
    expect(src!.linked_email_count).toBe(2)
  })

  test('无 REQUEST 时回退最新任意 method', () => {
    fixtureDb!.prepare(`UPDATE email_meeting SET method = 'CANCEL' WHERE internal_id = 101`).run()
    const src = runEventSourceEmail('uid-series')
    expect(src!.internal_id).toBe(102) // date_received 最新
  })

  test('uid 无映射邮件 → null', () => {
    expect(runEventSourceEmail('uid-caldav-only')).toBeNull()
  })

  test('email_meeting 表缺失 (v34 前旧库) → null 不抛', () => {
    fixtureDb!.exec('DROP TABLE email_meeting')
    expect(runEventSourceEmail('uid-series')).toBeNull()
    expect(runEmailCalendarLink(101)).toBeNull()
  })
})
