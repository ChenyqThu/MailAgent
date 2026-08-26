// Matters MVP P4 — the follow-up run's tool surface (D6) + the two review-side tools (D8).
//
// Covers what the venue test in ai-gateway/agent_run.test.ts cannot see from the outside:
//   * matter_update_propose — registration condition (a Matter+run anchor), silence (no approval
//     card), and the server-stamped identity (matter/run come from the closure, never the input).
//   * matter_review_update — the DYNAMIC approval verdict (non-manual 恒卡 / manual reject 免卡 /
//     manual accept touching a `field` change 弹卡 / unreadable payload fail-closed).
//   * matter_run_control — start/cancel wire shape + the structurally absent trigger_kind.
//   * the email read tools' Matter scoping: list/search narrowing vs. email_get's membership guard
//     (G5 — the manual filter must NOT start policing email_get).

import { describe, expect, test } from 'vitest'
import type { Tool } from 'ai'
import { z } from 'zod'

import { buildGatewayTools } from '../../../src/ai-gateway/tools'
import {
  createMatterReadTools,
  createMatterRunTools,
  createMatterWriteTools
} from '../../../src/ai-gateway/tools/matters'
import { createEmailReadTools } from '../../../src/ai-gateway/tools/email'
import {
  matterGetSchema,
  matterProgressMutateSchema,
  matterReviewUpdateSchema,
  matterRunControlSchema,
  matterUpdateProposeSchema
} from '../../../src/ai-gateway/tools/schemas'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import type { AgentContextMode } from '../../../src/ai-gateway/tools/policy'
import type { MailAgentDomainClient } from '../../../src/ai-gateway/python/domainClient'
import { mockDomain, okEnvelope, runTool } from './_helpers'

const MATTER_RUN = { matterId: 42, publicId: 'MAT-000042', runId: 7 }

/** Drive a write tool's full HITL two-call shape (needsApproval registers the approval record the
 *  guard then verifies at execute) — the write_preview.test.ts idiom. */
async function approveAndRun(tool: Tool, input: unknown, toolCallId = 'tc-1'): Promise<unknown> {
  const needsApproval = tool.needsApproval as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[] }
  ) => boolean | Promise<boolean>
  await needsApproval(input, { toolCallId, messages: [] })
  const exec = tool.execute as (i: unknown, o: unknown) => Promise<unknown>
  return exec(input, { toolCallId, messages: [], abortSignal: undefined })
}

/** Record every request the tool made so the wire shape (path + body) is assertable. */
function recordingDomain(payload: unknown = { ok: true }) {
  const calls: Array<{ url: string; body: unknown }> = []
  const domain = mockDomain((url, body) => {
    calls.push({ url, body: body === undefined ? undefined : JSON.parse(body) })
    return okEnvelope(payload)
  })
  return { domain, calls }
}

function buildRunTools(over?: { anchor?: typeof MATTER_RUN | null }) {
  return buildGatewayTools({
    domain: mockDomain(() => okEnvelope([])),
    approvalGuard: new ApprovalGuard(),
    contextMode: 'matter_followup',
    agentRunContext: {
      agentId: 'matter:MAT-000042',
      allowedTools: [],
      skills: ['email', 'search'],
      ...(over?.anchor === null ? {} : { matterRun: over?.anchor ?? MATTER_RUN })
    }
  })
}

describe('matter_update_propose — registration is anchored to a run (D6)', () => {
  test('registers only with a Matter+run anchor; silent (no approval hook)', () => {
    const tools = buildRunTools()
    expect(tools.matter_update_propose).toBeDefined()
    // artifact class + auditedReadTool → no needsApproval hook at all (report_write precedent).
    expect(
      (tools.matter_update_propose as { needsApproval?: unknown }).needsApproval
    ).toBeUndefined()
  })

  test('no anchor → absent, even in the matter_followup mode', () => {
    expect(buildRunTools({ anchor: null }).matter_update_propose).toBeUndefined()
  })

  test('a manual assembly never carries it (no run context exists there)', () => {
    const manual = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      approvalGuard: new ApprovalGuard(),
      contextMode: 'manual_chat'
    })
    expect(manual.matter_update_propose).toBeUndefined()
    expect(manual.matter_find).toBeDefined() // the rest of the family is there
  })
})

describe('matter_progress_mutate — curated 进展 lane 的写面 (task 08-25)', () => {
  test('owner-present venues hold it; a follow-up run structurally cannot write progress', () => {
    const build = (contextMode: AgentContextMode) =>
      buildGatewayTools({
        domain: mockDomain(() => okEnvelope({})),
        approvalGuard: new ApprovalGuard(),
        contextMode
      })

    expect(build('manual_chat').matter_progress_mutate).toBeDefined()
    expect(build('im_chat').matter_progress_mutate).toBeDefined()
    // 🔴 结构红线：跟进 run 对进展的维护**只有提案**这一条通道。class domain_write ⇒
    // matter_followup 矩阵行整类拒绝 ⇒ 这里必须是 undefined，哪怕带着 Matter 锚。
    // （untrusted_trigger / cron_headless 走的是另一条腰带 —— headless_excluded ⇒ 不进
    //  HEADLESS_TOOL_OPTIONS ⇒ 不进 allowedTools，由 tool_catalog 那侧的闸钉住。）
    expect(buildRunTools().matter_progress_mutate).toBeUndefined()
  })

  test('create posts the entry; the other three address one row by id', async () => {
    const { domain, calls } = recordingDomain({ version: 3 })
    const tools = createMatterWriteTools(domain, [], new ApprovalGuard(), {
      contextMode: 'manual_chat'
    })
    await approveAndRun(
      tools.matter_progress_mutate,
      {
        public_id: 'MAT-000042',
        operation: 'create',
        progress: {
          kind: 'decision',
          title: 'Simon 回邮确认 Q4 预算按 80 万走',
          happened_at: 1_786_690_800_000,
          refs: [{ type: 'email', message_id: '<a@b>' }]
        },
        expected_version: 2,
        idempotency_key: 'k-create'
      },
      'tc-create'
    )
    await approveAndRun(
      tools.matter_progress_mutate,
      {
        public_id: 'MAT-000042',
        operation: 'update',
        progress_id: 9,
        patch: { title: '按 82 万走' },
        expected_version: 3,
        idempotency_key: 'k-update'
      },
      'tc-update'
    )
    await approveAndRun(
      tools.matter_progress_mutate,
      {
        public_id: 'MAT-000042',
        operation: 'delete',
        progress_id: 9,
        expected_version: 4,
        idempotency_key: 'k-delete'
      },
      'tc-delete'
    )
    await approveAndRun(
      tools.matter_progress_mutate,
      {
        public_id: 'MAT-000042',
        operation: 'restore',
        progress_id: 9,
        expected_version: 5,
        idempotency_key: 'k-restore'
      },
      'tc-restore'
    )

    expect(calls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:8200/api/matters/MAT-000042/progress',
      'http://127.0.0.1:8200/api/matters/MAT-000042/progress/9',
      'http://127.0.0.1:8200/api/matters/MAT-000042/progress/9',
      'http://127.0.0.1:8200/api/matters/MAT-000042/progress/9/restore'
    ])
    expect(calls[0].body).toMatchObject({
      kind: 'decision',
      title: 'Simon 回邮确认 Q4 预算按 80 万走',
      happened_at: 1_786_690_800_000,
      refs: [{ type: 'email', message_id: '<a@b>' }],
      mutation: { source: 'ai_gateway', expected_version: 2, idempotency_key: 'k-create' }
    })
    // update 的 patch 直接铺开在 body 上（items 端点同形），delete/restore 只带 mutation。
    expect(calls[1].body).toMatchObject({ title: '按 82 万走' })
    expect(Object.keys(calls[2].body as object)).toEqual(['mutation'])
  })

  test('the schema keeps operation-conditional shape out of the model-facing JSON Schema', () => {
    // 🔴 两连败教训：分支约束（oneOf / not{required} / 条件必填）一旦进模型看到的 schema，
    // 模型漂移就会整轮打空。条件必填留在 superRefine（运行时，不进 JSON Schema）与 Python
    // （权威），模型看到的是一份扁平可选的 schema。
    // （`anyOf` 有意不在断言里：`body` 是 string|null 这种**类型**联合，不是分支约束。）
    const schema = z.toJSONSchema(matterProgressMutateSchema) as {
      required?: string[]
      properties?: Record<string, unknown>
    }
    const json = JSON.stringify(schema)
    expect(json).not.toContain('oneOf')
    expect(json).not.toContain('"not"')
    expect(schema.required).toEqual(['public_id', 'operation', 'expected_version'])
    // 扁平可选的另一半：五类 kind 仍然以 enum 的形式摆在模型面前。
    expect(json).toContain('"decision"')
    // 而写错 operation 的调用在运行时仍然被挡下（不是「不校验」）。
    expect(
      matterProgressMutateSchema.safeParse({
        public_id: 'MAT-000042',
        operation: 'update',
        expected_version: 1
      }).success
    ).toBe(false)
  })
})

describe('matter_update_propose — identity is stamped, never taken from the model', () => {
  test('the Matter + run ride in the PATH; the body is the proposal verbatim', async () => {
    const { domain, calls } = recordingDomain({ update_id: 5 })
    const tools = createMatterRunTools(domain, [], MATTER_RUN)
    await runTool(tools.matter_update_propose, {
      summary: '客户已确认启动日期',
      changes: [
        {
          id: 'chg_01',
          kind: 'field',
          target: { entity: 'matter', id: 'MAT-000042', field: 'status' },
          operation: 'replace',
          before: 'planned',
          after: 'active',
          sources: [{ resource_id: 91, evidence: '邮件正文第 3 段' }]
        }
      ],
      open_questions: ['是否需要同步给法务？'],
      confidence: 0.8
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/matters/MAT-000042/runs/7/proposal')
    const body = calls[0].body as Record<string, unknown>
    // 🔴 no matter_id / run_id / watermark keys leave the gateway — the server stamps them.
    expect(Object.keys(body).sort()).toEqual(['changes', 'confidence', 'open_questions', 'summary'])
  })

  test('the schema has no identity/watermark fields at all (they are unrepresentable)', () => {
    const parsed = matterUpdateProposeSchema.safeParse({
      summary: 's',
      changes: [],
      matter_id: 'MAT-000001',
      run_id: 99,
      anchored_matter_version: 3
    })
    // .strict() — a model that tries to address another Matter/run fails validation outright.
    expect(parsed.success).toBe(false)
  })

  test('a change carrying more than five sources is rejected (bounded evidence)', () => {
    const change = {
      id: 'chg_01',
      kind: 'fact',
      sources: Array.from({ length: 6 }, (_, i) => ({ resource_id: i + 1 }))
    }
    expect(matterUpdateProposeSchema.safeParse({ summary: 's', changes: [change] }).success).toBe(
      false
    )
  })
})

/** 0812 — 新发现的证据的结构化落地通道。zod 只让**歧义形状**不可表达；provider 到底算不算
 *  数、external_key 合不合既有约定，权威在 Python（`src/matters/resource_proposal.py`）。 */
describe('matter_update_propose — proposing a NEW resource link', () => {
  const parse = (changes: unknown[]) =>
    matterUpdateProposeSchema.safeParse({ summary: 's', changes })

  const NEW_RESOURCE = {
    id: 'chg_res',
    kind: 'resource',
    resource: {
      provider: 'notion',
      kind: 'doc',
      external_key: 'page:2f1a4c9e',
      title: 'Q3 rollout plan',
      canonical_url: 'https://www.notion.so/2f1a4c9e'
    },
    sources: []
  }

  test('accepts a resource identity built from the existing column names', () => {
    expect(parse([NEW_RESOURCE]).success).toBe(true)
  })

  test('rejects a free-form provider string (shape gate; membership is a server call)', () => {
    const bad = { ...NEW_RESOURCE, resource: { ...NEW_RESOURCE.resource, provider: 'Notion Inc.' } }
    expect(parse([bad]).success).toBe(false)
  })

  test('a resource identity may not ride on another change kind', () => {
    expect(parse([{ ...NEW_RESOURCE, kind: 'fact', text: 'x' }]).success).toBe(false)
  })

  test('confirming an existing link and proposing a new one are mutually exclusive', () => {
    const both = { ...NEW_RESOURCE, target: { entity: 'resource', id: 7 } }
    expect(parse([both]).success).toBe(false)
    // …but either one alone is fine
    expect(
      parse([{ id: 'c', kind: 'resource', target: { entity: 'resource', id: 7 } }]).success
    ).toBe(true)
  })

  test('a source is exactly one of resource_id / change_id', () => {
    const fact = (sources: unknown[]) => [{ id: 'chg_f', kind: 'fact', text: 't', sources }]
    expect(parse(fact([{ resource_id: 91 }])).success).toBe(true)
    expect(parse(fact([{ change_id: 'chg_res', evidence: '计划页时间表' }])).success).toBe(true)
    expect(parse(fact([{ resource_id: 91, change_id: 'chg_res' }])).success).toBe(false)
    expect(parse(fact([{ evidence: 'trust me' }])).success).toBe(false)
  })
})

/** 0825 dogfood —— curated 进展页恒空。`happened_at` 此前只收 int 毫秒，模型给 ISO 字符串
 *  就是 AI_TypeValidationError 打回**整个** matter_update_propose，重试那一发往往把 progress
 *  change 整条丢掉。一个可选字段不该有这个能力。 */
describe('matter_update_propose — progress.happened_at 宽收严归一', () => {
  const parseProgress = (happened_at: unknown) =>
    matterUpdateProposeSchema.safeParse({
      summary: 's',
      changes: [
        {
          id: 'chg_p',
          kind: 'progress',
          progress: { kind: 'progress', title: 'Simon 回邮确认按 80 万走', happened_at }
        }
      ]
    })

  const happenedAt = (result: ReturnType<typeof parseProgress>) =>
    result.success
      ? (result.data.changes[0] as { progress?: { happened_at?: number } }).progress?.happened_at
      : undefined

  test('epoch milliseconds pass through untouched', () => {
    const parsed = parseProgress(1_786_690_800_000)
    expect(parsed.success).toBe(true)
    expect(happenedAt(parsed)).toBe(1_786_690_800_000)
  })

  test('an ISO date / datetime is accepted and normalized to epoch ms', () => {
    expect(happenedAt(parseProgress('2026-08-20T10:00:00Z'))).toBe(
      Date.parse('2026-08-20T10:00:00Z')
    )
    expect(happenedAt(parseProgress('2026-08-20'))).toBe(Date.parse('2026-08-20'))
  })

  test('an unparseable date drops the optional field instead of failing the whole proposal', () => {
    const parsed = parseProgress('上周三')
    expect(parsed.success).toBe(true)
    expect(happenedAt(parsed)).toBeUndefined()
  })

  test('epoch SECONDS are deliberately NOT rescaled — Python drops them fail-closed', () => {
    // 🔴 matter 域纪律：秒值恒拒，不静默 ×1000（A3 三道门）。歧义的数字留给 Python 的
    // `timestamp_not_epoch_ms` 剔除明细，模型下一轮才看得见自己写错了什么；只有 ISO 字符串
    // 这种**无歧义**形态才在网关归一。
    expect(happenedAt(parseProgress(1_786_690_800))).toBe(1_786_690_800)
  })

  test('the model-facing JSON Schema gains a leaf anyOf, never a branch constraint', () => {
    const json = JSON.stringify(z.toJSONSchema(matterUpdateProposeSchema, { io: 'input' }))
    expect(json).not.toContain('oneOf')
    expect(json).not.toContain('"not"')
    // 毫秒仍是首选：数字分支的 describe 逐字留在模型眼前。
    expect(json).toContain('Never epoch seconds')
  })
})

describe('matter_run_control — start/cancel wire shape (D8)', () => {
  const writeTools = (
    domain: MailAgentDomainClient,
    contextMode: AgentContextMode = 'manual_chat'
  ) => createMatterWriteTools(domain, [], new ApprovalGuard(), { contextMode })

  test('start posts a mutation-only envelope and carries NO trigger_kind', async () => {
    const { domain, calls } = recordingDomain({ run: { id: 3 }, coalesced: false })
    await approveAndRun(writeTools(domain).matter_run_control, {
      public_id: 'MAT-000042',
      operation: 'start',
      expected_version: 4,
      idempotency_key: 'idem-1'
    })
    expect(calls[0].url).toContain('/matters/MAT-000042/runs')
    const body = calls[0].body as { mutation: Record<string, unknown> }
    expect(Object.keys(body)).toEqual(['mutation'])
    expect(body.mutation.expected_version).toBe(4)
    expect(body.mutation.source).toBe('ai_gateway')
  })

  test('cancel targets the run path; run_id is required for cancel and forbidden for start', async () => {
    const { domain, calls } = recordingDomain({ run: { id: 3 } })
    await approveAndRun(writeTools(domain).matter_run_control, {
      public_id: 'MAT-000042',
      operation: 'cancel',
      run_id: 3
    })
    expect(calls[0].url).toContain('/matters/MAT-000042/runs/3/cancel')
    expect(matterRunControlSchema.safeParse({ public_id: 'M', operation: 'cancel' }).success).toBe(
      false
    )
    expect(
      matterRunControlSchema.safeParse({ public_id: 'M', operation: 'start', run_id: 3 }).success
    ).toBe(false)
  })

  test("trigger_kind is not a field — a forged 'schedule' start cannot reach the wire", () => {
    // The schema has no such key, so zod DROPS it (the family's non-strict top-level shape) and
    // the domain client builds the body itself: nothing the model writes can become a trigger kind.
    const parsed = matterRunControlSchema.safeParse({
      public_id: 'MAT-000042',
      operation: 'start',
      trigger_kind: 'schedule'
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success && 'trigger_kind' in parsed.data).toBe(false)
  })
})

describe('matter_review_update — schema refinements (contracts §4.4)', () => {
  const base = { public_id: 'MAT-000042', update_id: 5, expected_version: 4 }

  test('reject requires a reason and forbids selection/edits', () => {
    expect(matterReviewUpdateSchema.safeParse({ ...base, decision: 'reject' }).success).toBe(false)
    expect(
      matterReviewUpdateSchema.safeParse({ ...base, decision: 'reject', reason: 'stale' }).success
    ).toBe(true)
    expect(
      matterReviewUpdateSchema.safeParse({
        ...base,
        decision: 'reject',
        reason: 'stale',
        selected_change_ids: ['chg_01']
      }).success
    ).toBe(false)
  })

  test('accept requires selected_change_ids to be PRESENT; [] is the summary-only case', () => {
    expect(matterReviewUpdateSchema.safeParse({ ...base, decision: 'accept' }).success).toBe(false)
    expect(
      matterReviewUpdateSchema.safeParse({ ...base, decision: 'accept', selected_change_ids: [] })
        .success
    ).toBe(true)
  })

  test('an edited change must reference a SELECTED change id', () => {
    expect(
      matterReviewUpdateSchema.safeParse({
        ...base,
        decision: 'accept',
        selected_change_ids: ['chg_01'],
        edited_changes: [{ change_id: 'chg_09', after: 'x' }]
      }).success
    ).toBe(false)
    expect(
      matterReviewUpdateSchema.safeParse({
        ...base,
        decision: 'accept',
        selected_change_ids: ['chg_01'],
        edited_changes: [{ change_id: 'chg_01', after: 'x' }]
      }).success
    ).toBe(true)
  })
})

describe('matter_review_update — the dynamic approval verdict (D8)', () => {
  /** The proposal the seam fetches: one `field` change + one `fact` change. */
  const UPDATE_PAYLOAD = {
    update: {
      id: 5,
      changes: [
        { id: 'chg_01', kind: 'field' },
        { id: 'chg_02', kind: 'fact' }
      ]
    }
  }

  function reviewTool(
    contextMode: AgentContextMode,
    payload: unknown = UPDATE_PAYLOAD,
    status?: number
  ) {
    const domain = mockDomain(() =>
      status != null
        ? { status, json: { status: 'error', error: { code: 'E_NOT_FOUND', message: 'x' } } }
        : okEnvelope(payload)
    )
    const tools = createMatterWriteTools(domain, [], new ApprovalGuard(), { contextMode })
    return tools.matter_review_update as {
      needsApproval: (input: unknown, ctx: { toolCallId: string }) => boolean | Promise<boolean>
    }
  }

  const ask = (tool: ReturnType<typeof reviewTool>, input: unknown) =>
    Promise.resolve(tool.needsApproval(input, { toolCallId: 'tc-1' }))

  const accept = (ids: string[]) => ({
    public_id: 'MAT-000042',
    update_id: 5,
    decision: 'accept',
    selected_change_ids: ids,
    expected_version: 4
  })
  const reject = {
    public_id: 'MAT-000042',
    update_id: 5,
    decision: 'reject',
    reason: 'not now',
    expected_version: 4
  }

  test('manual reject → card-free', async () => {
    expect(await ask(reviewTool('manual_chat'), reject)).toBe(false)
  })

  test('manual accept touching a field change → card', async () => {
    expect(await ask(reviewTool('manual_chat'), accept(['chg_01']))).toBe(true)
    expect(await ask(reviewTool('manual_chat'), accept(['chg_01', 'chg_02']))).toBe(true)
  })

  test('manual accept of non-field changes only → card-free', async () => {
    expect(await ask(reviewTool('manual_chat'), accept(['chg_02']))).toBe(false)
    // summary-only acceptance selects nothing → nothing to escalate
    expect(await ask(reviewTool('manual_chat'), accept([]))).toBe(false)
  })

  test.each(['im_chat', 'untrusted_trigger', 'cron_headless'] as const)(
    '%s → 恒卡 even for a reject (the manual venue is the only card-free one)',
    async (mode) => {
      expect(await ask(reviewTool(mode), reject)).toBe(true)
      expect(await ask(reviewTool(mode), accept(['chg_02']))).toBe(true)
    }
  )

  test('matter_followup: not a card — the tool cannot run there at all (class denied)', async () => {
    // A follow-up run never even sees this tool (applyContextModePolicy strips domain_write). If a
    // hand-built assembly smuggled it in, needsApproval returns false ON PURPOSE — pausing on a
    // card for a call that can never execute would be misleading — and execute hard-rejects.
    const tool = reviewTool('matter_followup')
    expect(await ask(tool, reject)).toBe(false)
    await expect(runTool(tool as unknown as Tool, reject)).rejects.toThrow(/E_CONTEXT_MODE_DENIED/)
  })

  test('unreadable / failing proposal fetch → fail-closed card', async () => {
    expect(await ask(reviewTool('manual_chat', undefined, 500), accept(['chg_02']))).toBe(true)
    // shape drift (no changes array anywhere) must not silently auto-allow
    expect(await ask(reviewTool('manual_chat', { update: {} }), accept(['chg_02']))).toBe(true)
  })

  test('a bare row (no `update` wrapper) is also understood', async () => {
    const bare = { id: 5, changes: [{ id: 'chg_01', kind: 'field' }] }
    expect(await ask(reviewTool('manual_chat', bare), accept(['chg_01']))).toBe(true)
    expect(await ask(reviewTool('manual_chat', bare), accept([]))).toBe(false)
  })

  test('accept/reject post to the matching endpoint with the right payload', async () => {
    const { domain, calls } = recordingDomain({ matter: { version: 5 } })
    const tools = createMatterWriteTools(domain, [], new ApprovalGuard(), {
      contextMode: 'manual_chat'
    })
    // 🔴 the approval seam itself GETs the proposal first, so index by URL, not by call order.
    const decisionCall = (kind: 'accept' | 'reject') =>
      calls.find((call) => call.url.endsWith(`/updates/5/${kind}`))?.body as Record<string, unknown>
    await approveAndRun(tools.matter_review_update, accept(['chg_02']), 'tc-accept')
    expect(decisionCall('accept')?.selected_change_ids).toEqual(['chg_02'])
    await approveAndRun(tools.matter_review_update, reject, 'tc-reject')
    expect(decisionCall('reject')?.reason).toBe('not now')
  })
})

describe('email read tools — 0812: no Matter narrowing left in EITHER venue', () => {
  test('the read tools carry no narrowing param at all (the options are gone)', async () => {
    const { domain, calls } = recordingDomain({ items: [] })
    const tools = createEmailReadTools(domain, [])
    await runTool(tools.email_list_filter, { limit: 20 })
    await runTool(tools.email_get, { internal_id: 51201 })
    expect(calls[0].url).not.toContain('matter_id')
    expect(calls[1].url).not.toContain('matter_scope')
  })

  test('0812 owner拍板: a follow-up run is NOT scoped to the anchor any more (full-library reads)', async () => {
    // The run's whole point is discovering NEW evidence — the old anchor→matterScopeFilter/
    // matterGetScope derivation locked it inside what was already linked (structurally unable to
    // see a new mail). The anchor now feeds ONLY matter_update_propose's identity; the email
    // reads carry neither narrowing param. 🔴 The MANUAL panel filter (事项对话 检索范围) that used
    // to be the other producer was removed in the same batch — 事项对话 reads the full library —
    // so both createEmailReadTools options were deleted rather than left permanently null.
    const { domain, calls } = recordingDomain({ items: [] })
    const tools = buildGatewayTools({
      domain,
      approvalGuard: new ApprovalGuard(),
      contextMode: 'matter_followup',
      agentRunContext: {
        agentId: 'matter:MAT-000042',
        allowedTools: [],
        skills: ['email', 'search'],
        matterRun: MATTER_RUN
      }
    })
    expect(tools.matter_update_propose).toBeDefined() // the anchor still binds the propose tool
    await runTool(tools.email_list_filter, { limit: 20 })
    await runTool(tools.email_get, { internal_id: 51201 })
    expect(calls[0].url).not.toContain('matter_id')
    expect(calls[1].url).not.toContain('matter_scope')
  })
})

describe('matter_get include=updates — the review loop had no way to learn an update_id', () => {
  // 0813 dogfood 轮 3: MATTER_GET_INCLUDES omitted 'updates' while the REST endpoint served it,
  // so matter_review_update (update_id REQUIRED) was structurally uncallable — the model could
  // never obtain a proposal number. Both sides' unit tests stayed green throughout.
  test('the schema admits "updates" and matter_get forwards it verbatim to REST', async () => {
    const { domain, calls } = recordingDomain({ matter: { public_id: 'MAT-000042' }, updates: [] })
    const parsed = matterGetSchema.parse({ public_id: 'MAT-000042', include: ['updates'] })
    expect(parsed.include).toEqual(['updates'])
    await runTool(createMatterReadTools(domain).matter_get, parsed)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('include=updates')
  })

  test('the update_id reaches the model and satisfies matter_review_update', async () => {
    const { domain } = recordingDomain({
      matter: { public_id: 'MAT-000042', version: 4 },
      updates: [{ id: 5, review_status: 'pending', changes: [{ id: 'chg_01', kind: 'field' }] }]
    })
    // 🔴 parse first: execute() does not re-validate, so feeding it a raw object would keep this
    // test green even with 'updates' missing from the enum — i.e. it would assert nothing.
    const out = (await runTool(
      createMatterReadTools(domain).matter_get,
      matterGetSchema.parse({ public_id: 'MAT-000042', include: ['updates'] })
    )) as { updates: Array<{ id: number }> }
    expect(out.updates[0].id).toBe(5)
    // The whole point of the fix: that number is exactly what the review tool demands.
    expect(
      matterReviewUpdateSchema.parse({
        public_id: 'MAT-000042',
        update_id: out.updates[0].id,
        decision: 'accept',
        selected_change_ids: ['chg_01'],
        expected_version: 4
      }).update_id
    ).toBe(5)
  })

  test('an unknown include value is still rejected (the enum is a whitelist, not a passthrough)', () => {
    expect(() => matterGetSchema.parse({ public_id: 'MAT-000042', include: ['secrets'] })).toThrow()
  })
})
