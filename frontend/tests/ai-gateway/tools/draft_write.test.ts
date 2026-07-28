// prd 07-27 (包 1+2) — email_draft_compose / email_draft_update.
//
// Covers the two things that can silently go wrong here:
//   1. the WIRE body (POST /email/draft is a camelCase contract the renderer's composer shares —
//      a wrong key is dropped by FastAPI without an error, e.g. sourceDraftId ≠ internalId costs
//      the draft its thread linkage);
//   2. the update ORCHESTRATION (read-back → re-save → delete): backfill of untouched fields, the
//      verbatim body carry-over, the drafts-folder gate, and the deliberately NON-FATAL delete.
// Everything runs against a mocked serve-api (no Python).

import { describe, expect, test } from 'vitest'

import type { Tool } from 'ai'

import { createWriteTools } from '../../../src/ai-gateway/tools/write'
import {
  emailDraftComposeSchema,
  emailDraftUpdateSchema
} from '../../../src/ai-gateway/tools/schemas'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import { ToolExecutionError } from '../../../src/ai-gateway/tools/types'
import { MailAgentDomainClient } from '../../../src/ai-gateway/python/domainClient'

/** One recorded serve-api call. */
interface Call {
  url: string
  body?: string
}

/** A domain client whose responses are routed by URL, recording every call in order. */
function routedDomain(routes: {
  row?: unknown
  bodyHtml?: unknown
  bodyMarkdown?: unknown
  draft?: unknown
  deleteFails?: boolean
}): { domain: MailAgentDomainClient; calls: Call[] } {
  const calls: Call[] = []
  const ok = (data: unknown): { json: unknown } => ({ json: { status: 'success', data } })
  const notFound = (): { status: number; json: unknown } => ({
    status: 404,
    json: { status: 'error', error: { code: 'E_NOT_FOUND', message: 'nope' } }
  })
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: init?.body as string | undefined })
    let r: { status?: number; json: unknown }
    if (url.includes('/email/draft/')) {
      r = routes.deleteFails
        ? { status: 500, json: { status: 'error', error: { code: 'E_UPSTREAM', message: 'imap' } } }
        : ok({ internal_id: 9, local_deleted: true })
    } else if (url.includes('/email/draft')) {
      r = ok(routes.draft ?? { internal_id: 9, drafts_folder: 'Drafts', appended_uid: 4242 })
    } else if (url.includes('/body')) {
      const wantHtml = url.includes('format=html')
      const data = wantHtml ? routes.bodyHtml : routes.bodyMarkdown
      r = data === undefined ? notFound() : ok(data)
    } else {
      r = routes.row === undefined ? notFound() : ok(routes.row)
    }
    return new Response(JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }) as unknown as typeof fetch
  return {
    domain: new MailAgentDomainClient({
      baseUrl: 'http://127.0.0.1:8200/api',
      localToken: 't',
      fetchImpl
    }),
    calls
  }
}

/** Drive a write tool's HITL two-call shape (needsApproval registers, execute verifies + runs). */
async function approveAndRun(tool: Tool, input: unknown, toolCallId = 'tc-d1'): Promise<unknown> {
  const needsApproval = tool.needsApproval as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[] }
  ) => boolean | Promise<boolean>
  await needsApproval(input, { toolCallId, messages: [] })
  const exec = tool.execute as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }
  ) => Promise<unknown>
  return exec(input, { toolCallId, messages: [], abortSignal: undefined })
}

const toolsOf = (routes: Parameters<typeof routedDomain>[0]) => {
  const { domain, calls } = routedDomain(routes)
  return { tools: createWriteTools(domain, [], new ApprovalGuard()), calls }
}

const bodyOf = (call: Call | undefined): Record<string, unknown> =>
  JSON.parse(call?.body ?? '{}') as Record<string, unknown>

// ── email_draft_compose ─────────────────────────────────────────────────────────────────────

describe('email_draft_compose — schema (cross-field rules fail BEFORE the approval card)', () => {
  test("mode 'forward' requires internal_id", () => {
    expect(
      emailDraftComposeSchema.safeParse({
        mode: 'forward',
        body_markdown: 'fyi',
        to: ['a@x.test']
      }).success
    ).toBe(false)
    expect(
      emailDraftComposeSchema.safeParse({
        mode: 'forward',
        internal_id: 7,
        body_markdown: 'fyi',
        to: ['a@x.test']
      }).success
    ).toBe(true)
  })

  test("mode 'forward' requires at least one recipient", () => {
    expect(
      emailDraftComposeSchema.safeParse({
        mode: 'forward',
        internal_id: 7,
        body_markdown: 'fyi',
        to: []
      }).success
    ).toBe(false)
  })

  test("mode 'new' REJECTS internal_id (a new draft has no source email)", () => {
    expect(
      emailDraftComposeSchema.safeParse({
        mode: 'new',
        internal_id: 7,
        body_markdown: 'hi',
        to: ['a@x.test']
      }).success
    ).toBe(false)
    // …and a recipient-less new draft is fine (the user may fill them in later).
    expect(
      emailDraftComposeSchema.safeParse({ mode: 'new', body_markdown: 'hi', to: [] }).success
    ).toBe(true)
  })
})

describe('email_draft_compose — wire body + output', () => {
  test("mode 'new' posts the sentinel internalId=-1, the subject and NO quoteOriginal", async () => {
    const { tools, calls } = toolsOf({})
    const out = (await approveAndRun(
      tools.email_draft_compose,
      emailDraftComposeSchema.parse({
        mode: 'new',
        subject: '  Q3 plan  ',
        body_markdown: 'hi **there**',
        to: ['a@x.test', ' b@x.test '],
        cc: ['c@x.test']
      })
    )) as Record<string, unknown>

    expect(bodyOf(calls[0])).toEqual({
      internalId: -1,
      mode: 'new',
      subject: 'Q3 plan', // trimmed
      bodyText: 'hi **there**',
      to: ['a@x.test', 'b@x.test'], // trimmed
      cc: ['c@x.test']
    })
    expect(out).toMatchObject({
      mode: 'new',
      source_internal_id: null,
      drafts_folder: 'Drafts',
      appended_uid: 4242,
      user_edited: false,
      final_subject: 'Q3 plan',
      final_to: ['a@x.test', 'b@x.test'],
      final_bcc: []
    })
    // 🔴 the endpoint echoes the REQUEST id, so the tool must not surface an `internal_id` that
    // reads like "the new draft" (the created row's id is never returned).
    expect(out.internal_id).toBeUndefined()
  })

  test("mode 'forward' posts the source internalId + quoteOriginal (default true, false honoured)", async () => {
    const { tools, calls } = toolsOf({})
    await approveAndRun(
      tools.email_draft_compose,
      emailDraftComposeSchema.parse({
        mode: 'forward',
        internal_id: 7,
        body_markdown: 'fyi',
        to: ['a@x.test']
      })
    )
    expect(bodyOf(calls[0])).toEqual({
      internalId: 7,
      mode: 'forward',
      bodyText: 'fyi',
      quoteOriginal: true,
      to: ['a@x.test']
    })
    // no subject key → the service derives "Fwd: <original>"; no attachments key → it
    // auto-collects the source email's attachments.
    expect(bodyOf(calls[0]).subject).toBeUndefined()
    expect(bodyOf(calls[0]).attachments).toBeUndefined()

    const second = toolsOf({})
    await approveAndRun(
      second.tools.email_draft_compose,
      emailDraftComposeSchema.parse({
        mode: 'forward',
        internal_id: 7,
        body_markdown: 'fyi',
        to: ['a@x.test'],
        quote_original: false
      })
    )
    expect(bodyOf(second.calls[0]).quoteOriginal).toBe(false)
  })

  test('side-channel junk in a recipient list is normalized away (the card POSTs raw arrays)', async () => {
    const { tools, calls } = toolsOf({})
    await approveAndRun(tools.email_draft_compose, {
      mode: 'new',
      body_markdown: 'hi',
      to: ['a@x.test', '  ', '', ' b@x.test '],
      cc: []
    })
    expect(bodyOf(calls[0]).to).toEqual(['a@x.test', 'b@x.test'])
    expect(bodyOf(calls[0]).cc).toBeUndefined() // empty list → key omitted
  })

  test('a forward whose recipients were cleared through the approval side-channel is refused', async () => {
    // The applyEdit channel bypasses zod, so the run re-asserts what the schema promised.
    const { tools, calls } = toolsOf({})
    await expect(
      approveAndRun(tools.email_draft_compose, {
        mode: 'forward',
        internal_id: 7,
        body_markdown: 'fyi',
        to: []
      })
    ).rejects.toMatchObject({ code: 'E_INVALID_ARG' })
    expect(calls).toHaveLength(0)
  })
})

// ── email_draft_update ──────────────────────────────────────────────────────────────────────

const DRAFT_ROW = {
  internal_id: 9,
  subject: 'old subject',
  mailbox: '草稿箱',
  to_addr: '"Doe, Jane" <jane@x.test>, bob@x.test',
  cc_addr: 'carl@x.test',
  attachments: [
    { id: 11, filename: 'a.pdf', is_inline: false },
    { id: 12, filename: 'sig.png', is_inline: true }
  ]
}

describe('email_draft_update — orchestration (read back → re-save → delete)', () => {
  test('subject-only edit: backfills recipients + carries the body over as html, then deletes the old row', async () => {
    const { tools, calls } = toolsOf({
      row: DRAFT_ROW,
      bodyHtml: { internal_id: 9, content: '<p>keep <b>me</b></p>' }
    })
    const out = (await approveAndRun(
      tools.email_draft_update,
      emailDraftUpdateSchema.parse({ draft_internal_id: 9, subject: 'new subject' })
    )) as Record<string, unknown>

    // three calls, in order: read row → read html body → POST draft → DELETE old.
    expect(calls.map((c) => c.url.replace('http://127.0.0.1:8200/api', ''))).toEqual([
      '/email/9?include=attachments',
      '/email/9/body?format=html',
      '/email/draft',
      '/email/draft/9'
    ])
    expect(bodyOf(calls[2])).toEqual({
      internalId: 9,
      mode: 'new',
      // 🔴 sourceDraftId MUST equal internalId or the service drops the thread linkage.
      sourceDraftId: 9,
      subject: 'new subject',
      bodyHtml: '<p>keep <b>me</b></p>',
      to: ['jane@x.test', 'bob@x.test'], // display names stripped, order kept
      cc: ['carl@x.test'],
      attachments: [{ attachment_id: 11 }] // the inline signature image is NOT re-attached
    })
    expect(out).toMatchObject({
      draft_internal_id: 9,
      updated: true,
      old_draft_deleted: true,
      old_draft_delete_error: null,
      body_source: 'existing_html',
      attachments_carried: 1,
      final_subject: 'new subject',
      final_body_markdown: null,
      warnings: []
    })
  })

  test('a provided body_markdown is used verbatim and skips the body read entirely', async () => {
    const { tools, calls } = toolsOf({ row: DRAFT_ROW })
    const out = (await approveAndRun(
      tools.email_draft_update,
      emailDraftUpdateSchema.parse({ draft_internal_id: 9, body_markdown: 'rewritten' })
    )) as Record<string, unknown>
    expect(calls.some((c) => c.url.includes('/body'))).toBe(false)
    expect(bodyOf(calls[1])).toMatchObject({ bodyText: 'rewritten', subject: 'old subject' })
    expect(out).toMatchObject({ body_source: 'model', final_body_markdown: 'rewritten' })
  })

  test('no html column → falls back to the markdown body', async () => {
    const { tools, calls } = toolsOf({
      row: DRAFT_ROW,
      bodyMarkdown: { internal_id: 9, content: 'plain text body' }
    })
    const out = (await approveAndRun(
      tools.email_draft_update,
      emailDraftUpdateSchema.parse({ draft_internal_id: 9, subject: 's2' })
    )) as Record<string, unknown>
    expect(bodyOf(calls[3])).toMatchObject({ bodyText: 'plain text body' })
    expect(out).toMatchObject({ body_source: 'existing_markdown' })
  })

  test('no body synced yet + no body_markdown → refuses BEFORE writing anything (never an empty draft)', async () => {
    const { tools, calls } = toolsOf({ row: DRAFT_ROW })
    await expect(
      approveAndRun(
        tools.email_draft_update,
        emailDraftUpdateSchema.parse({ draft_internal_id: 9, subject: 's2' })
      )
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
    expect(calls.some((c) => c.url.endsWith('/email/draft'))).toBe(false)
  })

  test('recipient overrides replace the backfill; an empty list means "no change", not "clear"', async () => {
    const { tools, calls } = toolsOf({
      row: DRAFT_ROW,
      bodyHtml: { internal_id: 9, content: '<p>x</p>' }
    })
    await approveAndRun(tools.email_draft_update, {
      draft_internal_id: 9,
      to: ['new@x.test'],
      cc: []
    })
    expect(bodyOf(calls[2])).toMatchObject({
      to: ['new@x.test'],
      cc: ['carl@x.test'] // [] → no override → the draft's current cc survives
    })
  })

  test('a non-draft target is refused with an actionable error and writes nothing', async () => {
    const { tools, calls } = toolsOf({ row: { ...DRAFT_ROW, mailbox: '收件箱' } })
    await expect(
      approveAndRun(
        tools.email_draft_update,
        emailDraftUpdateSchema.parse({ draft_internal_id: 9, subject: 'x' })
      )
    ).rejects.toMatchObject({ code: 'E_INVALID_ARG' })
    expect(calls).toHaveLength(1) // only the read
  })

  test('a drafts-folder variant spelling ("Drafts") is accepted (mailbox semantics single source)', async () => {
    const { tools, calls } = toolsOf({
      row: { ...DRAFT_ROW, mailbox: 'Drafts' },
      bodyHtml: { internal_id: 9, content: '<p>x</p>' }
    })
    await approveAndRun(
      tools.email_draft_update,
      emailDraftUpdateSchema.parse({ draft_internal_id: 9, subject: 'x' })
    )
    expect(calls.some((c) => c.url.endsWith('/email/draft'))).toBe(true)
  })

  test('a missing target row → E_NOT_FOUND, nothing written', async () => {
    const { tools, calls } = toolsOf({})
    await expect(
      approveAndRun(
        tools.email_draft_update,
        emailDraftUpdateSchema.parse({ draft_internal_id: 9, subject: 'x' })
      )
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
    expect(calls).toHaveLength(1)
  })

  test('an empty patch is refused before any HTTP call', async () => {
    const { tools, calls } = toolsOf({ row: DRAFT_ROW })
    await expect(
      approveAndRun(
        tools.email_draft_update,
        emailDraftUpdateSchema.parse({ draft_internal_id: 9 })
      )
    ).rejects.toBeInstanceOf(ToolExecutionError)
    expect(calls).toHaveLength(0)
  })

  test('DELETE failure is NON-FATAL: the new draft is reported + the duplicate is spelled out', async () => {
    const { tools, calls } = toolsOf({
      row: DRAFT_ROW,
      bodyHtml: { internal_id: 9, content: '<p>x</p>' },
      deleteFails: true
    })
    const out = (await approveAndRun(
      tools.email_draft_update,
      emailDraftUpdateSchema.parse({ draft_internal_id: 9, subject: 'new' })
    )) as Record<string, unknown>
    expect(calls).toHaveLength(4) // the delete WAS attempted
    expect(out).toMatchObject({ updated: true, old_draft_deleted: false, appended_uid: 4242 })
    expect(String(out.old_draft_delete_error)).toContain('E_UPSTREAM')
    expect((out.warnings as string[]).join(' ')).toContain('BOTH')
  })
})
