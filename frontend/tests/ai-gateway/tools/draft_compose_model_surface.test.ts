// issue #70 — email_draft_compose: the mode↔internal_id rule must reach the MODEL, not just the
// validator.
//
// Production (v1.22.0): a model asked to save a NEW draft passed `internal_id` anyway, and since the
// rule lives in `.superRefine` — which `toJSONSchema` drops — the only thing it could do was guess
// the value (0 → -1 → 1900000000000000 → 0), burning all 8 steps of the run and leaving the user
// with 8 "draft failed" cards and no draft.
//
// Two separate surfaces are pinned here because they failed for DIFFERENT reasons and only one of
// them was actually broken:
//
//   A. the JSON Schema handed to the model (RED before the fix — `internal_id` carried no
//      description at all, so nothing on the model-visible surface said "omit me for mode 'new'");
//   B. the tool-error text fed back on the next step (GREEN before the fix — contrary to the issue
//      report, ai@7 DOES relay the zod issue message; this is a regression pin so a future
//      onError/schema-wrapper change cannot silently sever it).
//
// Surface A is read through ai's OWN `asSchema` (not a hand-rolled conversion) so the assertion is
// against exactly the bytes a provider receives.

import { readFile } from 'node:fs/promises'

import { describe, expect, test } from 'vitest'
import { asSchema, simulateReadableStream, stepCountIs, streamText, type Tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import { createWriteTools } from '../../../src/ai-gateway/tools/write'
import { emailDraftComposeSchema } from '../../../src/ai-gateway/tools/schemas'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import { MailAgentDomainClient } from '../../../src/ai-gateway/python/domainClient'

/** The email_draft_compose tool exactly as the gateway builds it (serve-api never reached — the
 *  run below fails in input validation, before execute). */
function composeTool(): Tool {
  const domain = new MailAgentDomainClient({
    baseUrl: 'http://127.0.0.1:8200/api',
    localToken: 't',
    fetchImpl: (async () => {
      throw new Error('the draft endpoint must not be reached by an invalid call')
    }) as unknown as typeof fetch
  })
  return createWriteTools(domain, [], new ApprovalGuard()).email_draft_compose as Tool
}

/** Property blocks of the JSON Schema the model receives for a tool. */
function modelVisibleProperties(schema: unknown): Record<string, { description?: string }> {
  const json = asSchema(schema as never).jsonSchema as {
    properties?: Record<string, { description?: string }>
  }
  return json.properties ?? {}
}

describe('A — the mode↔internal_id rule is on the model-visible JSON Schema', () => {
  test('internal_id says it is forward-only and must be OMITTED for mode "new"', () => {
    const d = modelVisibleProperties(emailDraftComposeSchema).internal_id?.description ?? ''
    expect(d).not.toBe('')
    expect(d).toMatch(/forward/i)
    expect(d).toMatch(/omit/i)
    // The production loop was a hunt for a magic value — the schema has to say no value works.
    expect(d).toMatch(/0/)
    expect(d).toMatch(/-1/)
  })

  test('mode flags that the two modes take different parameters', () => {
    expect(modelVisibleProperties(emailDraftComposeSchema).mode?.description ?? '').toMatch(
      /internal_id/
    )
  })

  test('quote_original is marked forward-only', () => {
    expect(
      modelVisibleProperties(emailDraftComposeSchema).quote_original?.description ?? ''
    ).toMatch(/forward/i)
  })

  test('the descriptions survive the tool() wrapper the gateway actually registers', () => {
    const t = composeTool()
    expect(modelVisibleProperties(t.inputSchema).internal_id?.description ?? '').toMatch(/omit/i)
    // …and the tool description leads with the difference rather than burying it mid-paragraph.
    expect(t.description ?? '').toMatch(/DIFFERENT PARAMETERS/)
  })
})

/** The exact call the production model kept making: a 'new' draft carrying an internal_id. */
const BAD_CALL = {
  mode: 'new',
  internal_id: 0,
  subject: 'S',
  body_markdown: 'B',
  to: ['someone@example.test']
}

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 }
}

/** A run whose first step proposes BAD_CALL (failing input validation) and whose second step just
 *  stops, so the run ends deterministically. `prompts` collects what the model was called with. */
function buildFailingRun(prompts: unknown[][] = []): ReturnType<typeof streamText> {
  let call = 0
  const model = new MockLanguageModelV3({
    doStream: async (opts) => {
      call += 1
      prompts.push(JSON.parse(JSON.stringify(opts.prompt)) as unknown[])
      const chunks =
        call === 1
          ? [
              { type: 'stream-start' as const, warnings: [] },
              {
                type: 'tool-call' as const,
                toolCallId: 'tc-70',
                toolName: 'email_draft_compose',
                input: JSON.stringify(BAD_CALL)
              },
              { type: 'finish' as const, finishReason: 'tool-calls' as const, usage: USAGE }
            ]
          : [
              { type: 'stream-start' as const, warnings: [] },
              { type: 'text-start' as const, id: '1' },
              { type: 'text-delta' as const, id: '1', delta: 'stopping' },
              { type: 'text-end' as const, id: '1' },
              { type: 'finish' as const, finishReason: 'stop' as const, usage: USAGE }
            ]
      return { stream: simulateReadableStream({ chunks }) }
    }
  })
  return streamText({
    model,
    prompt: 'save this as a new draft',
    stopWhen: stepCountIs(3),
    tools: { email_draft_compose: composeTool() }
  })
}

describe('B — the validation message reaches the model on the next step', () => {
  test('a mode-"new" call carrying internal_id gets the corrective text back', async () => {
    const prompts: unknown[][] = []
    // Drain — the model messages for step 2 are only built once step 1 has finished.
    for await (const _ of buildFailingRun(prompts).fullStream) void _

    expect(prompts.length).toBeGreaterThanOrEqual(2)
    const toolResults = (prompts[1] as Array<{ role?: string; content?: unknown }>)
      .filter((m) => m.role === 'tool')
      .map((m) => JSON.stringify(m.content))
      .join('\n')
    // The constraint…
    expect(toolResults).toContain("mode 'new' takes no internal_id")
    // …and the ACTION that fixes it. A message naming only the violated rule left the model
    // guessing values; it has to say "drop the field, do not substitute a placeholder".
    expect(toolResults).toMatch(/REMOVED/)
    expect(toolResults).toMatch(/placeholder/i)
    // execute never ran (the fetchImpl above would have thrown) — the call died in validation,
    // which is the whole point of keeping the rule in superRefine: no approval card for a call
    // that can only error.
  })
})

// ── C — every streaming endpoint must un-mask errorText ─────────────────────────────────────
//
// ai@7's toUIMessageStream masks EVERY errorText to a bare "An error occurred." unless an onError
// handler is supplied — tool errors included. That masked string is what lands in ui_message_json,
// so it is what the card renders AND what convertToModelMessages replays to the model as the tool
// result on the NEXT turn. /api/ai/chat (server.ts) and the headless agent run always passed one;
// the approval-resume path and the AG-UI mirror did not, which meant a write that failed AFTER the
// user approved it lost its reason on both ends. Server-side resume is the primary approval path,
// so this pins the handler at every call site rather than at one.

describe('C — toUIMessageStream onError is present at every gateway call site', () => {
  const CALL_SITES = [
    'src/ai-gateway/server.ts',
    'src/ai-gateway/approvalResume.ts',
    'src/ai-gateway/agentRun.ts',
    'src/ai-gateway/agui/aguiRoute.ts'
  ]

  test.each(CALL_SITES)('%s supplies onError to its UI message stream', async (file) => {
    const src = await readFile(new URL(`../../../${file}`, import.meta.url), 'utf8')
    expect(src).toMatch(/toUIMessageStream|pipeUIMessageStreamToResponse/)
    expect(src).toMatch(/onError:/)
  })

  test('the masking is real: a stream without onError reports nothing usable', async () => {
    const errors: string[] = []
    for await (const chunk of buildFailingRun().toUIMessageStream() as AsyncIterable<{
      type: string
      errorText?: string
    }>) {
      if (chunk.type.includes('error') && chunk.errorText != null) errors.push(chunk.errorText)
    }
    expect(errors.length).toBeGreaterThan(0)
    // This is ai@7's default — the assertion documents WHY every call site needs a handler.
    expect(errors.every((e) => e === 'An error occurred.')).toBe(true)
  })

  test('with the handler, the same stream carries the zod issue', async () => {
    const errors: string[] = []
    const stream = buildFailingRun().toUIMessageStream({
      onError: (e: unknown) => (e instanceof Error ? e.message : String(e))
    })
    for await (const chunk of stream as AsyncIterable<{ type: string; errorText?: string }>) {
      if (chunk.type.includes('error') && chunk.errorText != null) errors.push(chunk.errorText)
    }
    expect(errors.some((e) => e.includes("mode 'new' takes no internal_id"))).toBe(true)
  })
})
