// chat-panel P4 Phase 04a — edit-tier UI-edit side-channel (ApprovalGuard.applyEdit + the
// gateway /api/ai/approval/resolve endpoint + the end-to-end "edit runs domain-side while the
// ai@6 history input is unchanged" property). This is the gap 03b left open (architecture
// §13.10.2(1)): a signed approval cannot carry an edited input, so the edit rides this channel.

import { describe, expect, test } from 'vitest'

import type { Tool } from 'ai'

import { ApprovalError, ApprovalGuard } from '../../src/ai-gateway/security/approval'
import { ApprovalRunStash } from '../../src/ai-gateway/approvalStash'
import { createWriteTools } from '../../src/ai-gateway/tools/write'
import { startAiGatewayServer } from '../../src/ai-gateway/server'
import type { GatewayToolAuditEntry } from '../../src/ai-gateway/tools/types'
import { mockDomain, okEnvelope } from './tools/_helpers'

// ── ApprovalGuard.applyEdit (the domain override) ────────────────────────────

describe('ApprovalGuard.applyEdit — edit-tier override', () => {
  test('overlays only the editable fields (identity pinned); verify returns the edit', () => {
    const g = new ApprovalGuard()
    g.register('tc1', 'email_draft_reply', 'edit', { internal_id: 7, body_markdown: 'A' }, [
      'body_markdown'
    ])
    // The side channel tries to change BOTH the body AND the internal_id; only the body sticks.
    g.applyEdit('tc1', { body_markdown: 'B (edited)', internal_id: 999 })
    // verify is called inside execute with the UNCHANGED ai@6 history input (body A, id 7).
    const v = g.verify('tc1', { internal_id: 7, body_markdown: 'A' })
    expect(v.userEdited).toBe(true)
    expect(v.effectiveInput).toEqual({ internal_id: 7, body_markdown: 'B (edited)' })
  })

  test('applyEdit on a preview-tier record → E_APPROVAL_NOT_EDITABLE', () => {
    const g = new ApprovalGuard()
    g.register('tc1', 'email_flag', 'preview', { internal_id: 7, is_flagged: true })
    expect(() => g.applyEdit('tc1', { is_flagged: false })).toThrow(ApprovalError)
    try {
      g.applyEdit('tc1', { is_flagged: false })
    } catch (e) {
      expect((e as ApprovalError).code).toBe('E_APPROVAL_NOT_EDITABLE')
    }
  })

  test('applyEdit with no record → E_APPROVAL_NOT_FOUND', () => {
    const g = new ApprovalGuard()
    try {
      g.applyEdit('missing', { body_markdown: 'B' })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ApprovalError).code).toBe('E_APPROVAL_NOT_FOUND')
    }
  })

  test('applyEdit on an expired record → E_APPROVAL_EXPIRED', () => {
    let clock = 1000
    const g = new ApprovalGuard({ ttlMs: 100, now: () => clock })
    g.register('tc1', 'email_draft_reply', 'edit', { internal_id: 7, body_markdown: 'A' }, [
      'body_markdown'
    ])
    clock = 1000 + 101
    try {
      g.applyEdit('tc1', { body_markdown: 'B' })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ApprovalError).code).toBe('E_APPROVAL_EXPIRED')
    }
  })

  test('no applyEdit + matching exec input → not edited (the non-edit path is unchanged)', () => {
    const g = new ApprovalGuard()
    g.register('tc1', 'email_draft_reply', 'edit', { internal_id: 7, body_markdown: 'A' }, [
      'body_markdown'
    ])
    const v = g.verify('tc1', { internal_id: 7, body_markdown: 'A' })
    expect(v.userEdited).toBe(false)
    expect(v.effectiveInput).toEqual({ internal_id: 7, body_markdown: 'A' })
  })
})

// ── end-to-end: the write tool executes the override while ai@6 input is unchanged ──────

const executeOf = (tool: Tool) =>
  tool.execute as (i: unknown, o: { toolCallId: string; messages: unknown[] }) => Promise<unknown>
const needsApprovalOf = (tool: Tool) =>
  tool.needsApproval as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[] }
  ) => boolean | Promise<boolean>

describe('write tool — edit via the side-channel runs the edited body (ai@6 input unchanged)', () => {
  test('register body A → applyEdit body B → execute(body A from history) writes body B', async () => {
    const collector: GatewayToolAuditEntry[] = []
    const guard = new ApprovalGuard()
    const calls: string[] = []
    const domain = mockDomain((url, body) => {
      calls.push(String(body))
      return okEnvelope({ internal_id: 7, drafts_folder: 'Drafts', method: 'reply_all_7' })
    })
    const tools = createWriteTools(domain, collector, guard)
    const proposed = { internal_id: 7, body_markdown: 'draft A' }

    // First call: register the approval (hash over body A).
    await needsApprovalOf(tools.email_draft_reply)(proposed, { toolCallId: 'tc1', messages: [] })
    // The user edits to body B on the card → POST resolve → applyEdit.
    guard.applyEdit('tc1', { body_markdown: 'draft B (edited)' })
    // Second call: ai@6 replays the UNCHANGED history input (body A). execute runs body B.
    const out = (await executeOf(tools.email_draft_reply)(proposed, {
      toolCallId: 'tc1',
      messages: []
    })) as { user_edited: boolean; final_body_markdown: string }

    expect(out.user_edited).toBe(true)
    expect(out.final_body_markdown).toBe('draft B (edited)')
    // The domain received the EDITED body (proof the override reached the wire).
    expect(calls.join('')).toContain('draft B (edited)')
    expect(collector[0]).toMatchObject({
      toolName: 'email_draft_reply',
      confirmationTier: 'edit',
      approvalStatus: 'edited',
      status: 'ok'
    })
    expect(collector[0].userEditedInputJson).toContain('draft B (edited)')
  })
})

// ── the gateway /api/ai/approval/resolve endpoint ────────────────────────────

async function withServer(
  resolveEditedApproval:
    | ((
        toolCallId: string,
        edited: Record<string, unknown>
      ) => { approvalId: string; toolName: string })
    | undefined,
  run: (base: string) => Promise<void>
): Promise<void> {
  const handle = await startAiGatewayServer({
    port: 0,
    baseUrl: 'http://127.0.0.1:0',
    apiKey: 'test',
    model: 'test-model',
    resolveEditedApproval
  })
  try {
    await run(`http://127.0.0.1:${handle.port}`)
  } finally {
    await handle.close()
  }
}

describe('POST /api/ai/approval/resolve', () => {
  test('valid edit → 200 ok, returns approvalId + toolName; applyEdit was called', async () => {
    const guard = new ApprovalGuard()
    guard.register('tc1', 'email_draft_reply', 'edit', { internal_id: 7, body_markdown: 'A' }, [
      'body_markdown'
    ])
    await withServer(
      (toolCallId, edited) => {
        const rec = guard.applyEdit(toolCallId, edited)
        return { approvalId: rec.approvalId, toolName: rec.toolName }
      },
      async (base) => {
        const res = await fetch(`${base}/api/ai/approval/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolCallId: 'tc1', editedInput: { body_markdown: 'B' } })
        })
        expect(res.status).toBe(200)
        const body = (await res.json()) as { status: string; toolName: string }
        expect(body.status).toBe('ok')
        expect(body.toolName).toBe('email_draft_reply')
        // The override is now on the record.
        expect(guard.verify('tc1', { internal_id: 7, body_markdown: 'A' }).effectiveInput).toEqual({
          internal_id: 7,
          body_markdown: 'B'
        })
      }
    )
  })

  test('not-found → 404; not-editable → 400; missing args → 400', async () => {
    const guard = new ApprovalGuard()
    guard.register('preview1', 'email_flag', 'preview', { internal_id: 7, is_flagged: true })
    await withServer(
      (toolCallId, edited) => {
        const rec = guard.applyEdit(toolCallId, edited)
        return { approvalId: rec.approvalId, toolName: rec.toolName }
      },
      async (base) => {
        const notFound = await fetch(`${base}/api/ai/approval/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolCallId: 'nope', editedInput: { body_markdown: 'B' } })
        })
        expect(notFound.status).toBe(404)
        expect((await notFound.json()).error).toBe('E_APPROVAL_NOT_FOUND')

        const notEditable = await fetch(`${base}/api/ai/approval/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolCallId: 'preview1', editedInput: { is_flagged: false } })
        })
        expect(notEditable.status).toBe(400)
        expect((await notEditable.json()).error).toBe('E_APPROVAL_NOT_EDITABLE')

        const missing = await fetch(`${base}/api/ai/approval/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolCallId: 'tc1' })
        })
        expect(missing.status).toBe(400)
        expect((await missing.json()).error).toBe('E_INVALID_ARG')
      }
    )
  })

  // L4 批次2 — the in-panel decide card learns only the approvalId from GET /pending (the internal
  // toolCallId never leaves the gateway), so /resolve accepts the same id shape /decide does and
  // looks the toolCallId up in the stash itself.
  test('{ approvalId } shape resolves through the stash and applies the SAME edit', async () => {
    const guard = new ApprovalGuard()
    guard.register('tc1', 'email_draft_reply', 'edit', { internal_id: 7, body_markdown: 'A' }, [
      'body_markdown'
    ])
    const stash = new ApprovalRunStash()
    const token = stash.stash({
      toolCallId: 'tc1',
      approvalId: 'ap_1',
      toolName: 'email_draft_reply',
      sessionId: 3,
      body: { messages: [] },
      responseMessage: { id: 'a1', role: 'assistant', parts: [] } as never,
      contextMode: 'manual_chat'
    })
    const handle = await startAiGatewayServer({
      port: 0,
      baseUrl: 'http://127.0.0.1:0',
      apiKey: 'test',
      model: 'test-model',
      approvalStash: stash,
      resolveEditedApproval: (toolCallId, edited) => {
        const rec = guard.applyEdit(toolCallId, edited)
        return { approvalId: rec.approvalId, toolName: rec.toolName }
      }
    })
    try {
      const base = `http://127.0.0.1:${handle.port}`
      const res = await fetch(`${base}/api/ai/approval/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId: 'ap_1', editedInput: { body_markdown: 'B' } })
      })
      expect(res.status).toBe(200)
      expect(guard.verify('tc1', { internal_id: 7, body_markdown: 'A' }).effectiveInput).toEqual({
        internal_id: 7,
        body_markdown: 'B'
      })
      // 🔴 peek, not claim: the entry must still be claimable by the /decide that follows.
      expect(stash.claim('tc1', token)).not.toBeNull()

      // a stale / wrong approvalId → 404 fail-closed (nothing edited)
      const stale = await fetch(`${base}/api/ai/approval/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId: 'ap_nope', editedInput: { body_markdown: 'C' } })
      })
      expect(stale.status).toBe(404)
      expect((await stale.json()).error).toBe('E_APPROVAL_NOT_FOUND')
    } finally {
      await handle.close()
    }
  })

  test('{ approvalId } with no stash wired → 404 (nothing is claimable)', async () => {
    await withServer(
      () => ({ approvalId: 'ap_1', toolName: 'email_draft_reply' }),
      async (base) => {
        const res = await fetch(`${base}/api/ai/approval/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approvalId: 'ap_1', editedInput: { body_markdown: 'B' } })
        })
        expect(res.status).toBe(404)
      }
    )
  })

  test('no resolver wired (read-only / 03b config) → 501', async () => {
    await withServer(undefined, async (base) => {
      const res = await fetch(`${base}/api/ai/approval/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolCallId: 'tc1', editedInput: { body_markdown: 'B' } })
      })
      expect(res.status).toBe(501)
      expect((await res.json()).error).toBe('E_NOT_IMPLEMENTED')
    })
  })
})
