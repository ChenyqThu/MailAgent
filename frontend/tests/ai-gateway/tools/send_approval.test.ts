// chat-panel P4 Phase 04b — high-risk send tool (email_prepare_send) execution gate.
//
// Covers the blocking outbound-send gate end to end on the gateway side:
//   - needsApproval registers a blocking approval (one-shot idempotency key) and NEVER sends on
//     the first call;
//   - the approved second call hashes the EFFECTIVE payload, signs the approval token, posts it
//     to /email/send-approved, and audits confirmation_tier='edit' (blocking→edit), content_hash
//     + idempotency_key + approval_status='approved';
//   - the signed token + content hash the tool sends are exactly what the Python guard re-verifies
//     (signSendApprovalToken over {contentHash, idempotencyKey, expiresAt});
//   - a REPLAYED approval (execute twice) → E_APPROVAL_USED on the second, the send runs ONCE;
//   - an expired approval → E_APPROVAL_EXPIRED, no send;
//   - an edit (applyEdit side-channel) → sends the edited payload, audits approval_status='edited';
//   - no recipient → E_INVALID_ARG, no send.

import { describe, expect, test } from 'vitest'

import type { Tool } from 'ai'

import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import {
  bareAddress,
  createSendTools,
  recipientInWhitelist,
  sendRecipientsAllWhitelisted
} from '../../../src/ai-gateway/tools/send'
import { hashOutbound, signSendApprovalToken } from '../../../src/ai-gateway/security/sendToken'
import type { GatewayToolAuditEntry } from '../../../src/ai-gateway/tools/types'
import { mockDomain, okEnvelope } from './_helpers'

const SECRET = 'test-local-token'

interface SentBody {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  bodyText: string
  internalId: number
  contentHash: string
  idempotencyKey: string
  approvalToken: string
  expiresAt: number
}

interface Harness {
  tool: Tool
  collector: GatewayToolAuditEntry[]
  guard: ApprovalGuard
  sentBodies: SentBody[]
}

function harness(opts?: {
  now?: () => number
  ttlMs?: number
  sendRecipientWhitelist?: readonly string[]
}): Harness {
  const collector: GatewayToolAuditEntry[] = []
  const guard = new ApprovalGuard({ now: opts?.now, ttlMs: opts?.ttlMs })
  const sentBodies: SentBody[] = []
  const domain = mockDomain((url, body) => {
    if (url.includes('/email/send-approved') && body) {
      sentBodies.push(JSON.parse(body) as SentBody)
    }
    return okEnvelope({
      sent: true,
      message_id: '<sent-1@corp.test>',
      archived_to_sent: true,
      method: 'smtp',
      to_count: 1,
      cc_count: 0
    })
  })
  const tool = createSendTools(domain, collector, guard, {
    signingSecret: SECRET,
    contextMode: 'manual_chat',
    sendRecipientWhitelist: opts?.sendRecipientWhitelist
  }).email_prepare_send
  return { tool, collector, guard, sentBodies }
}

const needsApprovalOf = (tool: Tool) =>
  tool.needsApproval as (i: unknown, o: { toolCallId: string; messages: unknown[] }) => boolean
const executeOf = (tool: Tool) =>
  tool.execute as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }
  ) => Promise<unknown>

const INPUT = {
  to: ['procurement@example-corp.test'],
  subject: '报价确认结论',
  body_markdown: '单价 1280、交期 4 周。',
  internal_id: 51240
}

describe('email_prepare_send — blocking approval + double-guard send', () => {
  test('needsApproval registers a blocking approval with a one-shot idempotency key; no send yet', () => {
    const h = harness()
    const needs = needsApprovalOf(h.tool)(INPUT, { toolCallId: 'tc1', messages: [] })
    expect(needs).toBe(true)
    expect(h.sentBodies).toHaveLength(0)
    // a blocking record carries an idempotency key + is editable (to/cc/bcc/subject/body).
    const v = h.guard.verify('tc1', INPUT)
    expect(v.record.risk).toBe('blocking')
    expect(v.record.idempotencyKey).toMatch(/^idem-/)
  })

  test('approved second call hashes + signs + sends; audits content_hash + idempotency + edit tier', async () => {
    const h = harness()
    needsApprovalOf(h.tool)(INPUT, { toolCallId: 'tc1', messages: [] })
    const out = (await executeOf(h.tool)(INPUT, { toolCallId: 'tc1', messages: [] })) as {
      sent: boolean
      message_id: string
    }
    expect(out.sent).toBe(true)
    expect(out.message_id).toBe('<sent-1@corp.test>')
    expect(h.sentBodies).toHaveLength(1)

    const body = h.sentBodies[0]
    const expectedHash = hashOutbound({
      to: INPUT.to,
      cc: [],
      bcc: [],
      subject: INPUT.subject,
      body: INPUT.body_markdown
    })
    expect(body.contentHash).toBe(expectedHash)
    expect(body.bodyText).toBe(INPUT.body_markdown)
    expect(body.idempotencyKey).toMatch(/^idem-/)
    // the token the tool sent is exactly what Python re-verifies (same secret + envelope).
    expect(body.approvalToken).toBe(
      signSendApprovalToken(SECRET, {
        contentHash: body.contentHash,
        idempotencyKey: body.idempotencyKey,
        expiresAt: body.expiresAt
      })
    )

    expect(h.collector).toHaveLength(1)
    expect(h.collector[0]).toMatchObject({
      toolName: 'email_prepare_send',
      status: 'ok',
      confirmationTier: 'edit', // blocking maps to edit for the audit/eval tier
      approvalStatus: 'approved',
      contentHash: expectedHash
    })
    expect(h.collector[0].idempotencyKey).toMatch(/^idem-/)
  })

  test('a REPLAYED approval (execute twice) → E_APPROVAL_USED on the second; the send runs ONCE', async () => {
    const h = harness()
    needsApprovalOf(h.tool)(INPUT, { toolCallId: 'tc1', messages: [] })
    await executeOf(h.tool)(INPUT, { toolCallId: 'tc1', messages: [] })
    await expect(executeOf(h.tool)(INPUT, { toolCallId: 'tc1', messages: [] })).rejects.toThrow(
      /E_APPROVAL_USED/
    )
    expect(h.sentBodies).toHaveLength(1) // never sent twice
    expect(h.collector[1]).toMatchObject({ status: 'error', approvalStatus: 'rejected' })
  })

  test('an expired approval → E_APPROVAL_EXPIRED, no send', async () => {
    let clock = 1_000
    const h = harness({ ttlMs: 100, now: () => clock })
    needsApprovalOf(h.tool)(INPUT, { toolCallId: 'tc1', messages: [] })
    clock = 1_000 + 101
    await expect(executeOf(h.tool)(INPUT, { toolCallId: 'tc1', messages: [] })).rejects.toThrow(
      /E_APPROVAL_EXPIRED/
    )
    expect(h.sentBodies).toHaveLength(0)
  })

  test('an edited approval (applyEdit side-channel) sends the EDITED payload + audits edited', async () => {
    const h = harness()
    needsApprovalOf(h.tool)(INPUT, { toolCallId: 'tc1', messages: [] })
    // user edits the body + adds a cc on the SendApprovalCard → resolve side-channel.
    h.guard.applyEdit('tc1', {
      to: INPUT.to,
      cc: ['manager@example-corp.test'],
      bcc: [],
      subject: INPUT.subject,
      body_markdown: '单价 1280、交期 4 周，已加抄送经理。'
    })
    await executeOf(h.tool)(INPUT, { toolCallId: 'tc1', messages: [] })
    expect(h.sentBodies).toHaveLength(1)
    const body = h.sentBodies[0]
    expect(body.cc).toEqual(['manager@example-corp.test'])
    expect(body.bodyText).toContain('已加抄送经理')
    // content hash is over the EDITED payload; token matches it.
    expect(body.contentHash).toBe(
      hashOutbound({
        to: INPUT.to,
        cc: ['manager@example-corp.test'],
        bcc: [],
        subject: INPUT.subject,
        body: '单价 1280、交期 4 周，已加抄送经理。'
      })
    )
    expect(h.collector[0]).toMatchObject({ approvalStatus: 'edited', confirmationTier: 'edit' })
  })

  test('no recipient → E_INVALID_ARG, no send', async () => {
    const h = harness()
    const empty = { ...INPUT, to: [] as string[] }
    needsApprovalOf(h.tool)(empty, { toolCallId: 'tc1', messages: [] })
    await expect(executeOf(h.tool)(empty, { toolCallId: 'tc1', messages: [] })).rejects.toThrow(
      /E_INVALID_ARG/
    )
    expect(h.sentBodies).toHaveLength(0)
  })
})

// ── 08-05 WP-11 (D2=a) — the recipient whitelist, the send's ONE structured card-free shape ────

describe('email_prepare_send — recipient whitelist (WP-11 D2=a)', () => {
  test('验收③ — EMPTY whitelist → the send always asks (no bare auto exists for the send)', () => {
    const h = harness({ sendRecipientWhitelist: [] })
    expect(needsApprovalOf(h.tool)(INPUT, { toolCallId: 'tc-wl0', messages: [] })).toBe(true)
    const h2 = harness() // absent (resolver failure / no prefs) — same floor
    expect(needsApprovalOf(h2.tool)(INPUT, { toolCallId: 'tc-wl0b', messages: [] })).toBe(true)
  })

  test("every recipient whitelisted → card-free send, audited 'auto_tool_pref', double guard intact", async () => {
    const h = harness({ sendRecipientWhitelist: ['@example-corp.test'] })
    const input = {
      ...INPUT,
      cc: ['manager@example-corp.test']
    }
    expect(needsApprovalOf(h.tool)(input, { toolCallId: 'tc-wl1', messages: [] })).toBe(false)
    const out = await executeOf(h.tool)(input, { toolCallId: 'tc-wl1', messages: [] })
    expect(out).toMatchObject({ sent: true })
    expect(h.sentBodies).toHaveLength(1)
    // the double guard ran on the skip: content hash + one-shot idempotency + distinct audit.
    expect(h.collector[0]).toMatchObject({
      toolName: 'email_prepare_send',
      status: 'ok',
      confirmationTier: 'edit',
      approvalStatus: 'auto_tool_pref'
    })
    expect(h.collector[0].contentHash).toBeTruthy()
    expect(h.collector[0].idempotencyKey).toBeTruthy()
    // replay → E_APPROVAL_USED (one-shot consume unchanged)
    await expect(executeOf(h.tool)(input, { toolCallId: 'tc-wl1', messages: [] })).rejects.toThrow(
      /E_APPROVAL_USED/
    )
  })

  test('ONE non-whitelisted recipient (bcc included) → the card comes back', () => {
    const h = harness({ sendRecipientWhitelist: ['@example-corp.test'] })
    expect(
      needsApprovalOf(h.tool)(
        { ...INPUT, bcc: ['spy@evil.test'] },
        { toolCallId: 'tc-wl2', messages: [] }
      )
    ).toBe(true)
  })

  test('the whitelist free pass is manual_chat-gated (consumption side)', () => {
    const collector: GatewayToolAuditEntry[] = []
    const tool = createSendTools(
      mockDomain(() => okEnvelope({ sent: true })),
      collector,
      new ApprovalGuard(),
      {
        signingSecret: SECRET,
        contextMode: 'cron_headless',
        sendRecipientWhitelist: ['@example-corp.test']
      }
    ).email_prepare_send
    expect(needsApprovalOf(tool)(INPUT, { toolCallId: 'tc-wl3', messages: [] })).toBe(true)
  })

  test('matcher semantics: exact email, @domain suffix anchored on the @, display names, junk', () => {
    expect(bareAddress('Jane Doe <A@Corp.Test>')).toBe('a@corp.test')
    expect(bareAddress(' a@corp.test ')).toBe('a@corp.test')
    const wl = ['a@corp.test', '@corp.test']
    expect(recipientInWhitelist('A@CORP.TEST', wl)).toBe(true)
    expect(recipientInWhitelist('Jane <b@corp.test>', wl)).toBe(true) // domain entry
    // 🔴 suffix is anchored on the '@' — a lookalike domain can never ride the entry.
    expect(recipientInWhitelist('x@evil-corp.test', wl)).toBe(false)
    expect(recipientInWhitelist('x@corp.test.evil.io', wl)).toBe(false)
    expect(recipientInWhitelist('not-an-email', wl)).toBe(false)
    // all-recipients predicate: empty whitelist / empty recipients never pass
    expect(sendRecipientsAllWhitelisted({ to: ['a@corp.test'] } as never, [])).toBe(false)
    expect(sendRecipientsAllWhitelisted({ to: [] } as never, wl)).toBe(false)
    expect(
      sendRecipientsAllWhitelisted({ to: ['a@corp.test'], cc: ['b@corp.test'] } as never, wl)
    ).toBe(true)
    expect(
      sendRecipientsAllWhitelisted({ to: ['a@corp.test'], cc: ['c@other.test'] } as never, wl)
    ).toBe(false)
  })
})
