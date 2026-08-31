// submit_feedback（task 08-27 P4a）—— 恒 HITL 的对外发送工具。
//
// 🔴 本文件最重要的一条：**审批卡弹出时 payload 还没发出去**。只断言「点了发送之后有回执」
//    是恒绿装饰 —— needsApproval 从来不发东西，那条断言删掉审批链也照样绿。所以每处都同时
//    断言 needsApproval 之后 submit 的调用次数**是 0**。
// 🔴 第二条：没有任何一条路径能把它变成「以后都自动」—— auto-reversible / per-tool 档 /
//    class 场地闸，三向都验。

import { describe, expect, test, vi } from 'vitest'

import type { Tool } from 'ai'

import { buildGatewayTools } from '../../../src/ai-gateway/tools'
import {
  createFeedbackTools,
  GATEWAY_FEEDBACK_TOOL_NAMES
} from '../../../src/ai-gateway/tools/feedback'
import { GATEWAY_TOOL_CLASSES } from '../../../src/ai-gateway/tools/policy'
import { CORE_UNGATED_GATEWAY_TOOLS } from '../../../src/ai-gateway/tools/skill_gating'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import { mockDomain, okEnvelope } from './_helpers'

const INPUT = {
  kind: '问题',
  title: '切换标签后正文停在上一封',
  detail: '开两个标签来回切',
  freq: '偶发'
}

function domain() {
  return mockDomain(() => okEnvelope({}))
}

/** 一个记录调用的假提交实现。 */
function fakeSubmit(id = 'blk-1') {
  return vi.fn().mockResolvedValue({ submissionBlockId: id })
}

function needsApprovalOf(tool: Tool, input: unknown, toolCallId: string): Promise<boolean> {
  const fn = tool.needsApproval as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[] }
  ) => boolean | Promise<boolean>
  return Promise.resolve(fn(input, { toolCallId, messages: [] }))
}

function executeOf(tool: Tool, input: unknown, toolCallId: string): Promise<unknown> {
  const fn = tool.execute as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }
  ) => Promise<unknown>
  return fn(input, { toolCallId, messages: [], abortSignal: undefined })
}

// ── 注册面 ───────────────────────────────────────────────────────────────────

describe('buildGatewayTools — submit_feedback 注册条件', () => {
  test('没给 submitFeedback → 不注册（与本批之前逐字节相同）', () => {
    const tools = buildGatewayTools({
      domain: domain(),
      approvalGuard: new ApprovalGuard(),
      contextMode: 'manual_chat'
    })
    expect(tools.submit_feedback).toBeUndefined()
  })

  test('给了 submitFeedback + guard → 注册', () => {
    const tools = buildGatewayTools({
      domain: domain(),
      approvalGuard: new ApprovalGuard(),
      submitFeedback: fakeSubmit(),
      contextMode: 'manual_chat'
    })
    for (const n of GATEWAY_FEEDBACK_TOOL_NAMES) expect(tools[n]).toBeDefined()
  })

  test('有 submitFeedback 但没 guard → 不注册（对外发送工具不能没有审批守卫）', () => {
    const tools = buildGatewayTools({
      domain: domain(),
      submitFeedback: fakeSubmit(),
      contextMode: 'manual_chat'
    })
    expect(tools.submit_feedback).toBeUndefined()
  })

  test('🔴 class outbound 的场地地板：headless / im 场地下不注册', () => {
    for (const mode of ['cron_headless', 'untrusted_trigger', 'im_chat'] as const) {
      const tools = buildGatewayTools({
        domain: domain(),
        approvalGuard: new ApprovalGuard(),
        submitFeedback: fakeSubmit(),
        contextMode: mode
      })
      expect(tools.submit_feedback, `mode=${mode}`).toBeUndefined()
    }
  })

  test('CORE_UNGATED：skill 全关也不掉（它的开关面不是 skill toggle）', () => {
    const tools = buildGatewayTools({
      domain: domain(),
      approvalGuard: new ApprovalGuard(),
      submitFeedback: fakeSubmit(),
      contextMode: 'manual_chat',
      skillGatingEnabled: true,
      advertisedSkills: []
    })
    expect(tools.submit_feedback).toBeDefined()
    expect(CORE_UNGATED_GATEWAY_TOOLS.has('submit_feedback')).toBe(true)
  })

  test('policy 单源里它是 outbound（不是 fail-close 到 exec 的漏网名）', () => {
    expect(GATEWAY_TOOL_CLASSES.submit_feedback).toBe('outbound')
  })
})

// ── 🔴 审批链：弹卡时什么都还没发出去 ────────────────────────────────────────

describe('submit_feedback — 恒 HITL', () => {
  test('needsApproval=true 且此刻 submit 调用次数为 0', async () => {
    const submit = fakeSubmit()
    const tools = createFeedbackTools(submit, [], new ApprovalGuard(), {
      contextMode: 'manual_chat'
    })
    const needs = await needsApprovalOf(tools.submit_feedback, INPUT, 'tc-fb-1')
    expect(needs).toBe(true)
    // 🔴 这一行才是本文件的重点：卡弹出来了，但一个字节都还没出去。
    expect(submit).not.toHaveBeenCalled()
  })

  test('批准后（第二轮 execute）才真的提交，并回一个编号', async () => {
    const submit = fakeSubmit('blk-42')
    const tools = createFeedbackTools(submit, [], new ApprovalGuard(), {
      contextMode: 'manual_chat'
    })
    await needsApprovalOf(tools.submit_feedback, INPUT, 'tc-fb-2')
    expect(submit).not.toHaveBeenCalled()
    const out = (await executeOf(tools.submit_feedback, INPUT, 'tc-fb-2')) as {
      submission_id: string
      submitted_by: string
      screenshot_attached: boolean
    }
    expect(submit).toHaveBeenCalledTimes(1)
    expect(out.submission_id).toBe('blk-42')
    // 回执要说清是谁代发的。
    expect(out.submitted_by).toBe('main_agent')
    // agent 截不了图 —— 这一项恒 false。
    expect(out.screenshot_attached).toBe(false)
  })

  test('🔴 auto-reversible 不能免卡（edit tier + outbound）', async () => {
    const submit = fakeSubmit()
    const tools = createFeedbackTools(submit, [], new ApprovalGuard(), {
      contextMode: 'manual_chat',
      approvalMode: 'auto-reversible'
    })
    expect(await needsApprovalOf(tools.submit_feedback, INPUT, 'tc-fb-3')).toBe(true)
    expect(submit).not.toHaveBeenCalled()
  })

  test('🔴 per-tool 档也不能免卡 —— 工厂根本不接 toolApprovalPrefs', async () => {
    const submit = fakeSubmit()
    // 就算 buildGatewayTools 拿到了一张把它标成 auto 的档位表，也传不进这个工厂。
    const tools = buildGatewayTools({
      domain: domain(),
      approvalGuard: new ApprovalGuard(),
      submitFeedback: submit,
      contextMode: 'manual_chat',
      toolApprovalPrefs: {
        tools: { submit_feedback: { tier: 'auto', source: 'owner' } },
        sendRecipientWhitelist: []
      }
    })
    expect(await needsApprovalOf(tools.submit_feedback, INPUT, 'tc-fb-4')).toBe(true)
    expect(submit).not.toHaveBeenCalled()
  })

  test('未经 needsApproval 直接 execute → 守卫拒绝，且一个字节都没发出去', async () => {
    const submit = fakeSubmit()
    const tools = createFeedbackTools(submit, [], new ApprovalGuard(), {
      contextMode: 'manual_chat'
    })
    await expect(executeOf(tools.submit_feedback, INPUT, 'tc-never-approved')).rejects.toThrow()
    expect(submit).not.toHaveBeenCalled()
  })
})

// ── 「改一改」与 schema ──────────────────────────────────────────────────────

describe('submit_feedback — 改一改 / schema', () => {
  test('提交失败时错误直达模型（它才能如实告诉用户没发出去）', async () => {
    const submit = vi.fn().mockRejectedValue(new Error('feedback submit failed (status 403)'))
    const tools = createFeedbackTools(submit, [], new ApprovalGuard(), {
      contextMode: 'manual_chat'
    })
    await needsApprovalOf(tools.submit_feedback, INPUT, 'tc-fb-5')
    await expect(executeOf(tools.submit_feedback, INPUT, 'tc-fb-5')).rejects.toThrow(/403/)
  })

  test('schema 拒绝空标题（模型得自己改，不能提交一条没抬头的反馈）', async () => {
    const tools = createFeedbackTools(fakeSubmit(), [], new ApprovalGuard(), {
      contextMode: 'manual_chat'
    })
    const schema = (
      tools.submit_feedback as { inputSchema: { safeParse(v: unknown): { success: boolean } } }
    ).inputSchema
    expect(schema.safeParse({ kind: '问题', title: '' }).success).toBe(false)
    expect(schema.safeParse({ kind: '问题', title: 'ok' }).success).toBe(true)
    // 🔴 没有截图字段：agent 截不了图，schema 层就不给它这个念想。
    expect(schema.safeParse({ kind: '问题', title: 'ok', screenshot: 'x' }).success).toBe(true)
  })
})
