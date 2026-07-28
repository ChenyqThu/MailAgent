// chat-panel P4 Phase 03b → S3 W2 — write-tool registry + gate + needsApproval + output snapshots.
//
// Originally a legacy⋈gateway parity harness (migration contract §7/§10). The legacy
// runtime is deleted, so the parity half now PINS the gateway write tools' output
// shape against fixed fixtures (the exact values the parity run asserted). The gate
// contract is unchanged: a write tool must (a) only exist when
// MAILAGENT_AI_SDK_WRITE_TOOLS is on AND a guard is supplied, (b) ALWAYS request
// approval (never silent).

import { describe, expect, test } from 'vitest'

import type { Tool } from 'ai'

import { buildGatewayTools } from '../../../src/ai-gateway/tools'
import { createWriteTools, GATEWAY_WRITE_TOOL_NAMES } from '../../../src/ai-gateway/tools/write'
import { GATEWAY_READ_TOOL_NAMES } from '../../../src/ai-gateway/tools'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import { mockDomain, okEnvelope } from './_helpers'

/** Drive a gateway write tool's full HITL two-call shape: needsApproval (registers the
 *  approval record) → execute (verifies + runs). Returns the tool output. */
async function approveAndRun(
  tool: Tool,
  input: unknown,
  opts?: { toolCallId?: string; execInput?: unknown }
): Promise<unknown> {
  const toolCallId = opts?.toolCallId ?? 'tc-w1'
  const needsApproval = tool.needsApproval as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[] }
  ) => boolean | Promise<boolean>
  await needsApproval(input, { toolCallId, messages: [] })
  const exec = tool.execute as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }
  ) => Promise<unknown>
  return exec(opts?.execInput ?? input, { toolCallId, messages: [], abortSignal: undefined })
}

describe('write tools — flag gating (buildGatewayTools)', () => {
  test('writeToolsEnabled off → read-only (no write tools)', () => {
    const tools = buildGatewayTools({
      domain: mockDomain(() => okEnvelope({})),
      writeToolsEnabled: false,
      contextMode: 'manual_chat'
    })
    const names = Object.keys(tools)
    for (const w of GATEWAY_WRITE_TOOL_NAMES) expect(names).not.toContain(w)
    for (const r of GATEWAY_READ_TOOL_NAMES) expect(names).toContain(r)
  })

  test('writeToolsEnabled on but NO guard → still read-only (a write tool cannot exist without its guard)', () => {
    const tools = buildGatewayTools({
      domain: mockDomain(() => okEnvelope({})),
      writeToolsEnabled: true,
      contextMode: 'manual_chat'
    })
    for (const w of GATEWAY_WRITE_TOOL_NAMES) expect(Object.keys(tools)).not.toContain(w)
  })

  test('writeToolsEnabled on + guard → every write tool is added alongside reads', () => {
    const tools = buildGatewayTools({
      domain: mockDomain(() => okEnvelope({})),
      writeToolsEnabled: true,
      approvalGuard: new ApprovalGuard(),
      contextMode: 'manual_chat'
    })
    const names = Object.keys(tools)
    for (const w of GATEWAY_WRITE_TOOL_NAMES) expect(names).toContain(w)
    for (const r of GATEWAY_READ_TOOL_NAMES) expect(names).toContain(r)
  })
})

describe('write tools — always need approval (never silent)', () => {
  test('every write tool declares needsApproval', () => {
    const tools = createWriteTools(
      mockDomain(() => okEnvelope({})),
      [],
      new ApprovalGuard()
    )
    for (const name of GATEWAY_WRITE_TOOL_NAMES) {
      const tool = tools[name]
      expect(tool, name).toBeDefined()
      // needsApproval is set (a function in our impl) → ai@6 will gate execution.
      expect(tool.needsApproval, name).toBeTruthy()
    }
  })
})

describe('write tools — output snapshots (pinned migration-contract values)', () => {
  test('email_flag output', async () => {
    const DATA = { updated_ids: [9], outbox_entries: [{ kind: 'mailapp' }] }
    const gateway = createWriteTools(
      mockDomain(() => okEnvelope(DATA)),
      [],
      new ApprovalGuard()
    )
    const gatewayOut = await approveAndRun(gateway.email_flag, { internal_id: 9, is_flagged: true })
    expect(gatewayOut).toEqual({
      internal_id: 9,
      applied: { is_flagged: true },
      updated_ids: [9],
      outbox_entries: [{ kind: 'mailapp' }],
      user_edited: false
    })
  })

  test('email_archive output', async () => {
    const DATA = { from_mailbox: '收件箱', to_mailbox: '存档', notion_updated: true }
    const gateway = createWriteTools(
      mockDomain(() => okEnvelope(DATA)),
      [],
      new ApprovalGuard()
    )
    const gatewayOut = await approveAndRun(gateway.email_archive, { internal_id: 9 })
    expect(gatewayOut).toEqual({
      internal_id: 9,
      archived: true,
      from_mailbox: '收件箱',
      to_mailbox: '存档',
      notion_updated: true,
      user_edited: false
    })
  })

  test('email_pin output', async () => {
    const DATA = { is_pinned: true, changed: true }
    const gateway = createWriteTools(
      mockDomain(() => okEnvelope(DATA)),
      [],
      new ApprovalGuard()
    )
    const gatewayOut = await approveAndRun(gateway.email_pin, { internal_id: 9, pinned: true })
    expect(gatewayOut).toEqual({
      internal_id: 9,
      is_pinned: true,
      changed: true,
      user_edited: false
    })
  })

  test('email_draft_reply output', async () => {
    let wireBody: string | undefined
    const gateway = createWriteTools(
      mockDomain((_url, body) => {
        wireBody = body
        return okEnvelope({ internal_id: 9, drafts_folder: 'Drafts', method: 'reply_all_9' })
      }),
      [],
      new ApprovalGuard()
    )
    const gatewayOut = await approveAndRun(gateway.email_draft_reply, {
      internal_id: 9,
      body_markdown: 'thanks!'
    })
    expect(gatewayOut).toEqual({
      internal_id: 9,
      mailbox: 'Drafts',
      account_name: null,
      draft_id: 'reply_all_9',
      user_edited: false,
      final_body_markdown: 'thanks!',
      final_to: null,
      final_cc: null,
      final_bcc: null
    })
    // 无收件人覆盖 → wire 不带 to/cc/bcc, mode 缺省 reply-all (服务端派生收件人不变)。
    const parsed = JSON.parse(wireBody ?? '{}')
    expect(parsed).toEqual({
      internalId: 9,
      mode: 'reply-all',
      bodyText: 'thanks!',
      quoteOriginal: true
    })
  })

  test('email_draft_reply recipient overrides ride the wire (add/remove people on reply-all)', async () => {
    let wireBody: string | undefined
    const gateway = createWriteTools(
      mockDomain((_url, body) => {
        wireBody = body
        return okEnvelope({ internal_id: 9, drafts_folder: 'Drafts', method: 'reply_all_9' })
      }),
      [],
      new ApprovalGuard()
    )
    const gatewayOut = (await approveAndRun(gateway.email_draft_reply, {
      internal_id: 9,
      body_markdown: 'thanks!',
      mode: 'reply',
      to: ['a@x.com', ' b@x.com ', ''],
      cc: ['c@x.com'],
      bcc: []
    })) as Record<string, unknown>
    const parsed = JSON.parse(wireBody ?? '{}')
    expect(parsed).toEqual({
      internalId: 9,
      mode: 'reply',
      bodyText: 'thanks!',
      quoteOriginal: true,
      to: ['a@x.com', 'b@x.com'], // trim + 去空串
      cc: ['c@x.com']
      // bcc: [] → 不覆盖 → 不上 wire
    })
    expect(gatewayOut.final_to).toEqual(['a@x.com', 'b@x.com'])
    expect(gatewayOut.final_cc).toEqual(['c@x.com'])
    expect(gatewayOut.final_bcc).toBeNull()
  })

  test('email_resync output', async () => {
    const DATA = { old_page_id: 'p-old', new_page_id: 'p-new', action: 'recreated' }
    const gateway = createWriteTools(
      mockDomain(() => okEnvelope(DATA)),
      [],
      new ApprovalGuard()
    )
    const gatewayOut = await approveAndRun(gateway.email_resync, { internal_id: 9 })
    expect(gatewayOut).toEqual({
      internal_id: 9,
      old_page_id: 'p-old',
      new_page_id: 'p-new',
      action: 'recreated',
      user_edited: false
    })
  })
})
