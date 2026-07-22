// @vitest-environment happy-dom
//
// useAgentContextSnapshot — attachment metadata assembly. Proves the hook wires
// mailApi.attachment.list into the snapshot as metadata-only descriptors (no textExcerpt), drops
// inline attachments (signature images), and degrades gracefully (attachment.list failure → empty
// list, snapshot still builds). The email metadata/body wiring is exercised by the pure builder
// tests (contextSnapshot.test.ts); here we focus on the new attachment leg.

import { describe, expect, test, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

import { useAgentContextSnapshot } from '../../../../src/shared/assistant/context/useAgentContextSnapshot'
import type {
  CapabilityContext,
  ContextScope
} from '../../../../src/shared/assistant/context/contextSnapshot'

// ── mock useMailApi ─────────────────────────────────────────────────────────────

const mockGet = vi.fn()
const mockAiFields = vi.fn()
const mockListByThread = vi.fn()
const mockBody = vi.fn()
const mockAttachmentList = vi.fn()

vi.mock('../../../../src/shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    email: {
      get: mockGet,
      aiFields: mockAiFields,
      listByThread: mockListByThread,
      body: mockBody
    },
    attachment: {
      list: mockAttachmentList
    }
  })
}))

// ── fixtures ────────────────────────────────────────────────────────────────────

const SCOPE: ContextScope = {
  surface: 'email-chat',
  anchorType: 'email',
  anchorId: 456,
  sessionId: null,
  backendKind: 'ai-sdk'
}
const CAPS: CapabilityContext = {
  thinkingEnabled: false,
  attachmentsEnabled: false,
  toolCallingEnabled: true,
  humanApprovalRequired: true,
  enabledSkills: []
}

const PDF_ROW = {
  id: 11,
  internal_id: 456,
  filename: 'Q3-plan.pdf',
  size_bytes: 1024,
  content_type: 'application/pdf',
  is_inline: false
}
const INLINE_ROW = {
  id: 12,
  internal_id: 456,
  filename: 'signature.png',
  size_bytes: 40,
  content_type: 'image/png',
  is_inline: true
}

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return {
    wrapper: ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children)
  }
}

function seedEmailReads(): void {
  mockGet.mockResolvedValue({
    thread_id: 't-1',
    subject: 'Q3 plan',
    sender_name: 'Alice',
    sender: 'alice@acme.test',
    date_received: '2026-07-20',
    mailbox: 'INBOX',
    notion_page_id: null
  })
  mockAiFields.mockResolvedValue({
    ai_priority: 'Normal',
    ai_action: null,
    processing_status: null,
    ai_review_status: null
  })
  mockListByThread.mockResolvedValue([])
  mockBody.mockResolvedValue({ content: 'the quarterly numbers are attached' })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useAgentContextSnapshot — attachment assembly', () => {
  test('injects non-inline attachments as metadata-only descriptors (inline dropped, no textExcerpt)', async () => {
    seedEmailReads()
    mockAttachmentList.mockResolvedValue([PDF_ROW, INLINE_ROW])
    const { wrapper } = makeWrapper()
    const { result } = renderHook(
      () =>
        useAgentContextSnapshot({
          activeInternalId: 456,
          scope: SCOPE,
          capabilities: CAPS,
          panelMode: 'dock',
          enabled: true
        }),
      { wrapper }
    )

    await waitFor(() => expect(result.current.snapshot?.attachments.length).toBe(1))
    const att = result.current.snapshot!.attachments[0]
    expect(att).toMatchObject({
      id: '11',
      name: 'Q3-plan.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
      parseStatus: 'metadata-only',
      trust: 'untrusted-user-content'
    })
    // metadata-only: no textExcerpt injected (content is read on demand via the tool).
    expect(att.textExcerpt ?? null).toBeNull()
    // inline attachment (signature.png) was filtered out of the injection面.
    expect(result.current.snapshot!.attachments.some((a) => a.name === 'signature.png')).toBe(false)
  })

  test('all-inline attachments → empty attachments list', async () => {
    seedEmailReads()
    mockAttachmentList.mockResolvedValue([INLINE_ROW])
    const { wrapper } = makeWrapper()
    const { result } = renderHook(
      () =>
        useAgentContextSnapshot({
          activeInternalId: 456,
          scope: SCOPE,
          capabilities: CAPS,
          panelMode: 'dock',
          enabled: true
        }),
      { wrapper }
    )
    await waitFor(() => expect(result.current.snapshot).not.toBeNull())
    // let any pending attachment query settle before asserting emptiness.
    await waitFor(() => expect(result.current.snapshot?.activeEmail?.subject).toBe('Q3 plan'))
    expect(result.current.snapshot!.attachments).toEqual([])
  })

  test('attachment.list failure degrades to an empty list without blocking the snapshot', async () => {
    seedEmailReads()
    mockAttachmentList.mockRejectedValue(new Error('attachment endpoint down'))
    const { wrapper } = makeWrapper()
    const { result } = renderHook(
      () =>
        useAgentContextSnapshot({
          activeInternalId: 456,
          scope: SCOPE,
          capabilities: CAPS,
          panelMode: 'dock',
          enabled: true
        }),
      { wrapper }
    )
    // the snapshot still builds from the email reads; attachments are simply empty.
    await waitFor(() => expect(result.current.snapshot?.activeEmail?.subject).toBe('Q3 plan'))
    expect(result.current.snapshot!.attachments).toEqual([])
  })
})
