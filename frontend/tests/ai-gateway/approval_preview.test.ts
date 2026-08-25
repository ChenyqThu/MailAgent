// L4 批次1 #6 — the approval-card preview line now comes from serve-api's SERVER-DERIVED facts,
// with the model's own args as the fallback.
//
// Why this matters: `approvalInputPreview` can only re-tell what the model wrote, and part of a
// write's payload is derived server-side (an email_draft_reply without `to` means "server, compute
// reply-all"). The three surfaces that get nothing BUT this one line — island card, Feishu card,
// record-view pending panel — therefore showed the user everything except who the mail goes to.
//
// Pinned here (both产出点 share resolveApprovalPreview, so both are exercised):
//   ① server line wins when serve-api answers;
//   ② null (no deriver for that tool) → the model-args line — fail-OPEN;
//   ③ the hook THROWING → the model-args line — fail-OPEN (a card must never be lost);
//   ④ no hook wired at all → the pre-#6 behaviour, and on the announce leg still SYNCHRONOUS.

import { afterEach, describe, expect, test, vi } from 'vitest'

import { approvalInputPreview, makePersistOnFinish } from '../../src/ai-gateway/chatRun'
import type { PreparedChatRun } from '../../src/ai-gateway/chatRun'
import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import type { AiGatewayConfig, IslandApprovalAnnounce } from '../../src/ai-gateway/config'
import { ApprovalRunStash } from '../../src/ai-gateway/approvalStash'
import type { MailAgentUIMessage } from '../../src/shared/assistant/uiMessage'

/** The model's args for a reply whose recipients are NOT in the args (the server derives them) —
 *  i.e. exactly the case the old client-side preview could not describe. */
const REPLY_INPUT = { internal_id: 53675, body_markdown: '收到，明天给你数字。' }
const SERVER_LINE = '回复「Re: 季度预算」 · 收件人 boss@x.com, peer@y.com'
const FALLBACK_LINE = approvalInputPreview('email_draft_reply', REPLY_INPUT)

// ── pending leg (GET /api/ai/approval/pending) ───────────────────────────────────────────────

const handles: AiGatewayHandle[] = []
afterEach(async () => {
  while (handles.length) await handles.pop()!.close()
})

function pausedResponse(): MailAgentUIMessage {
  return {
    id: 'a1',
    role: 'assistant',
    parts: [
      {
        type: 'tool-email_draft_reply',
        toolCallId: 'tc1',
        state: 'approval-requested',
        input: REPLY_INPUT,
        approval: { id: 'ap1' }
      }
    ]
  } as unknown as MailAgentUIMessage
}

async function pendingPreview(
  fetchApprovalPreview?: AiGatewayConfig['fetchApprovalPreview']
): Promise<string> {
  const stash = new ApprovalRunStash()
  stash.stash({
    toolCallId: 'tc1',
    approvalId: 'ap1',
    toolName: 'email_draft_reply',
    sessionId: 7,
    body: { messages: [], model: 'claude-sonnet-4-6', sessionId: 7 },
    responseMessage: pausedResponse(),
    contextMode: 'manual_chat'
  })
  const cfg = {
    port: 0,
    baseUrl: 'https://crs.example/api',
    apiKey: 'sk-test',
    model: 'claude-sonnet-4-6',
    approvalStash: stash,
    ...(fetchApprovalPreview ? { fetchApprovalPreview } : {})
  } as AiGatewayConfig
  const handle = await startAiGatewayServer(cfg)
  handles.push(handle)
  const res = await fetch(`http://127.0.0.1:${handle.port}/api/ai/approval/pending?sessionId=7`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { inputPreview: string }).inputPreview
}

describe('/api/ai/approval/pending — preview source', () => {
  test('① serve-api answers → the SERVER line is what the surfaces render', async () => {
    const seen: Array<{ toolName: string; input: unknown }> = []
    const preview = await pendingPreview(async (info) => {
      seen.push(info)
      return SERVER_LINE
    })
    expect(preview).toBe(SERVER_LINE)
    // the deriver is asked about THIS tool with the model's raw args (it needs them to look the
    // real payload up — it just doesn't TRUST them for the facts)
    expect(seen).toEqual([{ toolName: 'email_draft_reply', input: REPLY_INPUT }])
  })

  test('② no deriver for this tool (null) → the model-args line', async () => {
    expect(await pendingPreview(async () => null)).toBe(FALLBACK_LINE)
  })

  test('② empty/blank server line is treated as no answer', async () => {
    expect(await pendingPreview(async () => '   ')).toBe(FALLBACK_LINE)
  })

  test('③ serve-api unreachable (hook throws) → the model-args line, still a 200', async () => {
    expect(
      await pendingPreview(async () => {
        throw new Error('ECONNREFUSED')
      })
    ).toBe(FALLBACK_LINE)
  })

  test('④ hook not wired → pre-#6 behaviour verbatim', async () => {
    expect(await pendingPreview()).toBe(FALLBACK_LINE)
  })
})

// ── announce leg (makePersistOnFinish → cfg.announceApprovalToIsland) ─────────────────────────

function makeRun(): PreparedChatRun {
  return {
    result: { usage: Promise.resolve(undefined) } as unknown as PreparedChatRun['result'],
    rawMessages: [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: '帮我回复' }] }
    ] as unknown as PreparedChatRun['rawMessages'],
    sessionId: 42,
    modelId: 'claude-sonnet-4-6',
    protocol: 'anthropic',
    auditEntries: [],
    toolNames: [],
    originalBody: { messages: [], model: 'claude-sonnet-4-6', sessionId: 42 }
  }
}

function announceCfg(over: Partial<AiGatewayConfig>): {
  cfg: AiGatewayConfig
  announced: IslandApprovalAnnounce[]
} {
  const announced: IslandApprovalAnnounce[] = []
  const cfg = {
    islandAgentEnabled: true,
    approvalStash: new ApprovalRunStash(),
    // makePersistOnFinish returns early without it (a cfg that persists nothing has no pause branch)
    persistTurn: () => {},
    announceApprovalToIsland: (info: IslandApprovalAnnounce) => announced.push(info),
    ...over
  } as AiGatewayConfig
  return { cfg, announced }
}

/** Fire the pause WITHOUT awaiting — ④ needs to observe the announce before any microtask runs
 *  (an awaited call can't tell "same tick" from "one microtask later"). */
function firePause(cfg: AiGatewayConfig): Promise<void> {
  const onFinish = makePersistOnFinish(cfg, makeRun())
  return onFinish({ responseMessage: pausedResponse(), isAborted: false } as unknown as Parameters<
    typeof onFinish
  >[0]) as Promise<void>
}

async function pause(cfg: AiGatewayConfig): Promise<void> {
  await firePause(cfg)
}

describe('island announce — preview source', () => {
  test('① serve-api answers → the island card carries the SERVER line', async () => {
    const { cfg, announced } = announceCfg({ fetchApprovalPreview: async () => SERVER_LINE })
    await pause(cfg)
    await vi.waitFor(() => expect(announced).toHaveLength(1))
    expect(announced[0].inputPreview).toBe(SERVER_LINE)
    expect(announced[0].resumeToken.length).toBeGreaterThan(0) // the stash contract is untouched
  })

  test('③ hook throws → the card is still announced, with the model-args line', async () => {
    const { cfg, announced } = announceCfg({
      fetchApprovalPreview: async () => {
        throw new Error('ECONNREFUSED')
      }
    })
    await pause(cfg)
    await vi.waitFor(() => expect(announced).toHaveLength(1))
    expect(announced[0].inputPreview).toBe(FALLBACK_LINE)
  })

  test('④ no hook → announced SYNCHRONOUSLY within the pause tick (pre-#6 timing)', async () => {
    const { cfg, announced } = announceCfg({})
    const settled = firePause(cfg)
    // asserted BEFORE awaiting: with no hook the announce must still happen in the same tick,
    // i.e. #6 costs an un-hooked gateway (harness / pre-#6 lifecycle) exactly nothing.
    expect(announced).toHaveLength(1)
    expect(announced[0].inputPreview).toBe(FALLBACK_LINE)
    await settled
  })
})
