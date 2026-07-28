// @vitest-environment happy-dom
//
// SystemDocApprovalCard (update_system_md) — render + the doc-label contract gate.
//
// The card had no test file, and its DOC_LABEL_KEYS map is hand-copied from the
// `update_system_md` zod enum. A missing key does not crash: `t()` is skipped and the raw
// docName renders, so the only symptom is a bare English word in a Chinese approval card —
// invisible to every other test. This file pins the key set to its canonical source
// (updateSystemMdSchema) and pins that every key resolves in BOTH locales.
//
// 🔴 The gate compares against the zod enum, NOT against Settings' StandingDocsSection.
// StandingDocsSection lists 5 docs (it edits memory.md too); this card renders for
// update_system_md only, whose doc_name enum has 4 values — memory is deliberately not an
// update_system_md target (identity boundary, ai-gateway/tools/profile.ts:18). Asserting the
// two components' key sets are equal would be asserting the wrong contract.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import { SystemDocApprovalCard } from '@shared/assistant/tools/generic/SystemDocApprovalCard'
import { updateSystemMdSchema } from '../../../../src/ai-gateway/tools/schemas'
import zhCN from '../../../../src/shared/i18n/locales/zh-CN/common.json'
import enUS from '../../../../src/shared/i18n/locales/en-US/common.json'

await i18n.changeLanguage('zh-CN')

function mockProps(over: Partial<ToolCallMessagePartProps>): ToolCallMessagePartProps {
  return {
    type: 'tool-call',
    toolName: 'update_system_md',
    toolCallId: 'tc1',
    args: { doc_name: 'user', content: 'hello' },
    argsText: '{}',
    result: undefined,
    isError: undefined,
    status: { type: 'requires-action', reason: 'interrupt' },
    approval: { id: 'apr-1' }, // pending: approved === undefined
    addResult: vi.fn(),
    resume: vi.fn(),
    respondToApproval: vi.fn(),
    ...over
  } as unknown as ToolCallMessagePartProps
}

afterEach(() => {
  cleanup()
})

// ---- the contract gate ------------------------------------------------------

const ENUM_DOCS = updateSystemMdSchema.shape.doc_name.options as readonly string[]
const zhDocs = (zhCN as Record<string, any>).chat.systemDocApprovalCard.doc
const enDocs = (enUS as Record<string, any>).chat.systemDocApprovalCard.doc

describe('doc labels ↔ updateSystemMdSchema', () => {
  // Driven through render rather than by importing the card's DOC_LABEL_KEYS: a doc missing
  // from that map does not throw, it silently falls back to the raw doc name, so rendering is
  // where the bug is actually observable. This one loop covers BOTH failure modes — a missing
  // map entry (raw 'soul' renders) and a missing translation (the i18n key path renders).
  test.each([...ENUM_DOCS])('%s renders a localized label, never the raw doc name', (doc) => {
    render(<SystemDocApprovalCard {...mockProps({ args: { doc_name: doc, content: 'body' } })} />)
    expect(screen.getByText(`Agent 提议改写 ${zhDocs[doc]} 文档`)).toBeTruthy()
    expect(screen.queryByText(new RegExp(`改写 ${doc} 文档`))).toBeNull()
  })

  test('both locales define exactly the enum docs — no missing, no orphan', () => {
    // memory is deliberately absent from the enum (memory.md is written by
    // agent_memory_update / auto-capture, never by update_system_md — identity boundary,
    // ai-gateway/tools/profile.ts:18). Settings' StandingDocsSection lists 5 docs because it
    // is the editor for all of them; do NOT "align" the two key sets.
    expect(ENUM_DOCS).not.toContain('memory')
    expect(Object.keys(zhDocs).sort()).toEqual([...ENUM_DOCS].sort())
    expect(Object.keys(enDocs).sort()).toEqual([...ENUM_DOCS].sort())
  })
})

// ---- render -----------------------------------------------------------------

describe('SystemDocApprovalCard — pending (approval-requested)', () => {
  test('offers real approve + reject buttons (not the buttonless trace-card spinner)', () => {
    render(<SystemDocApprovalCard {...mockProps({})} />)
    expect(screen.getByText('允许')).toBeTruthy()
    expect(screen.getByText('取消')).toBeTruthy()
  })

  test('soul/agent/rules get the high-risk title + safety-floor note; user does not', () => {
    render(
      <SystemDocApprovalCard {...mockProps({ args: { doc_name: 'rules', content: 'body' } })} />
    )
    expect(screen.getByText('⚠️ 改写身份 / 规则文档')).toBeTruthy()
    expect(screen.getByText(/PRODUCT_SAFETY_FLOOR/)).toBeTruthy()
    cleanup()

    render(
      <SystemDocApprovalCard {...mockProps({ args: { doc_name: 'user', content: 'body' } })} />
    )
    expect(screen.getByText('改写 Standing Context 文档')).toBeTruthy()
    expect(screen.queryByText(/PRODUCT_SAFETY_FLOOR/)).toBeNull()
  })

  test('shows the FULL proposed content (M4b HIGH-2: the review surface is never truncated)', () => {
    const content = `FIRST-LINE\n${'filler\n'.repeat(200)}LAST-LINE`
    const { container } = render(
      <SystemDocApprovalCard {...mockProps({ args: { doc_name: 'user', content } })} />
    )
    // both ends present ⇒ nothing was clipped (the card is scrollable, not truncated).
    expect(container.textContent).toContain('FIRST-LINE')
    expect(container.textContent).toContain('LAST-LINE')
    expect(
      screen.getByText(
        `${[...content].length} 字符（批准后按此写入；如需改动让 agent 重新提议或到 Settings 编辑）`
      )
    ).toBeTruthy()
  })

  test('unknown docName degrades to the raw string (never blank, never a missing-key path)', () => {
    render(
      <SystemDocApprovalCard {...mockProps({ args: { doc_name: 'memory', content: 'body' } })} />
    )
    // Unreachable in production (zod rejects it upstream); asserted so the fallback stays a
    // plain echo rather than leaking an i18n key path like chat.systemDocApprovalCard.doc.memory.
    expect(screen.getByText('Agent 提议改写 memory 文档')).toBeTruthy()
  })
})

describe('SystemDocApprovalCard — approve / reject wire respondToApproval', () => {
  test('approve → respondToApproval({ approved: true })', () => {
    const respond = vi.fn()
    render(<SystemDocApprovalCard {...mockProps({ respondToApproval: respond })} />)
    fireEvent.click(screen.getByText('允许'))
    expect(respond).toHaveBeenCalledWith({ approved: true })
  })

  test('reject → respondToApproval({ approved: false })', () => {
    const respond = vi.fn()
    render(<SystemDocApprovalCard {...mockProps({ respondToApproval: respond })} />)
    fireEvent.click(screen.getByText('取消'))
    expect(respond).toHaveBeenCalledWith({ approved: false })
  })
})

describe('SystemDocApprovalCard — terminal phases', () => {
  test('done → localized "已更新 <label> 文档", no buttons', () => {
    render(
      <SystemDocApprovalCard
        {...mockProps({
          args: { doc_name: 'agent', content: 'body' },
          status: { type: 'complete' },
          approval: { id: 'apr-1', approved: true },
          result: { doc_name: 'agent', content_hash: 'abc', user_edited: false }
        })}
      />
    )
    expect(screen.getByText('已更新 AGENT（操作笔记） 文档')).toBeTruthy()
    expect(screen.queryByText('允许')).toBeNull()
  })
})
