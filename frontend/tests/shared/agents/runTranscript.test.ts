// task 08-27 P4a（lane team-shell）— run transcript 消息拆分（runTranscript.ts）。
// 🔴 r8 §A.2：首条 user 消息是 4-7KB 任务契约 prompt，绝不进消息流 —— 摘进 seedPrompt。

import { describe, expect, test } from 'vitest'

import type { ChatMessage } from '@shared/api/types'
import {
  splitRunTranscript,
  triggerLabelKey
} from '../../../src/shared/components/agents/team/runTranscript'

function msg(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: 1,
    session_id: 1,
    role: 'user',
    content: '',
    tokens_input: null,
    tokens_output: null,
    cost_usd: null,
    model: null,
    status: 'done',
    error_message: null,
    metadata: null,
    thinking: null,
    ui_message_json: null,
    ...over
  } as ChatMessage
}

describe('splitRunTranscript', () => {
  test('摘掉首条 user 消息（任务契约 prompt），其余保序', () => {
    const seed = msg({ id: 1, role: 'user', content: 'CONTRACT_PROMPT_7KB' })
    const reply = msg({ id: 2, role: 'assistant', content: '干完了' })
    const followup = msg({ id: 3, role: 'user', content: '审批后补充' })
    const { seedPrompt, rest } = splitRunTranscript([seed, reply, followup])
    expect(seedPrompt).toBe('CONTRACT_PROMPT_7KB')
    expect(rest.map((m) => m.id)).toEqual([2, 3])
  })

  test('首条不是 user（异常形状）→ 不摘，宁可多显示', () => {
    const reply = msg({ id: 2, role: 'assistant', content: 'x' })
    const { seedPrompt, rest } = splitRunTranscript([reply])
    expect(seedPrompt).toBeNull()
    expect(rest.map((m) => m.id)).toEqual([2])
  })

  test('空消息集 → { null, [] }', () => {
    expect(splitRunTranscript([])).toEqual({ seedPrompt: null, rest: [] })
  })
})

describe('triggerLabelKey', () => {
  test('已知 kind 映射；未知/缺失回退 unknown', () => {
    expect(triggerLabelKey('schedule')).toBe('team.record.trigger.schedule')
    expect(triggerLabelKey('email_filter')).toBe('team.record.trigger.email')
    expect(triggerLabelKey('manual')).toBe('team.record.trigger.manual')
    expect(triggerLabelKey('made_up')).toBe('team.record.trigger.unknown')
    expect(triggerLabelKey(null)).toBe('team.record.trigger.unknown')
  })
})
