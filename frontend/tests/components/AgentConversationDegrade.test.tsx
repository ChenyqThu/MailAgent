// @vitest-environment happy-dom
//
// S3 W2 (D6 + D7) — AgentConversation routing after the legacy engine deletion.
//
//   D7: the gateway being unreachable no longer silently swaps engines (there is
//       none) — the pane surfaces an error notice (+ retry when the /health probe
//       can re-run) and keeps the active session readable; no composer mounts.
//   D6: an EXISTING session whose persisted backend_kind isn't 'ai-sdk' (old
//       custom-api / retired notion-agent) renders READ-ONLY with a notice.

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { ChatMessage, ChatSessionListItem } from '@shared/api/types'
import type { UseGeneralChatReturn } from '@shared/hooks/useGeneralChat'
import i18n from '@shared/i18n'

vi.mock('@shared/components/email/TranslatedBody', () => ({
  TranslatedBody: ({ text }: { text: string }) => <div data-testid="md">{text}</div>
}))

// AgentConversation calls useNavigate at the top level — stub the router hook so the
// test doesn't need a RouterProvider (same pattern as CommandPalette.test).
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn()
}))

const { stableMailApi } = vi.hoisted(() => {
  const stableMailApi = {
    settings: { secretsStatus: vi.fn(async () => ({ llmApiKey: true })) },
    chat: { newSession: vi.fn() },
    email: { get: vi.fn(), body: vi.fn() },
    llm: { upstreamModels: vi.fn(async () => []), enabledModels: vi.fn(async () => []) }
  }
  return { stableMailApi }
})
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => stableMailApi
}))
// Model list rides its own hook — stub it so the test doesn't depend on its query shape.
vi.mock('@shared/hooks/useLlmModels', () => ({
  useEnabledModels: () => ({ models: ['claude-sonnet-4-6'] })
}))

import { AgentConversation } from '@shared/components/agents/AgentConversation'

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  }
  if (!('IntersectionObserver' in globalThis)) {
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): [] {
        return []
      }
    }
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = (): void => {}
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function fakeMessage(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: 1,
    session_id: 10,
    role: 'assistant',
    content: '',
    tokens_input: null,
    tokens_output: null,
    cost_usd: null,
    model: null,
    status: 'complete',
    error_message: null,
    metadata: null,
    thinking: null,
    ui_message_json: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...over
  }
}

function fakeChat(over: Partial<UseGeneralChatReturn> = {}): UseGeneralChatReturn {
  return {
    messages: [],
    error: null,
    activeSessionId: null,
    messagesSessionId: null,
    navEpoch: 0,
    sessions: [],
    clearError: vi.fn(),
    newSession: vi.fn(),
    selectSession: vi.fn(async () => {}),
    adoptSession: vi.fn(),
    deleteSession: vi.fn(),
    refreshSessions: vi.fn(async () => {}),
    ...over
  }
}

function fakeItem(over: Partial<ChatSessionListItem>): ChatSessionListItem {
  const now = Date.now()
  return {
    id: 10,
    email_id: null,
    anchor_type: 'general',
    anchor_id: null,
    backend_kind: 'ai-sdk',
    backend_model: null,
    backend_agent_page_id: null,
    created_at: now,
    updated_at: now,
    first_user_message: null,
    message_count: 1,
    email_subject: null,
    email_sender: null,
    ...over
  }
}

function mount(chat: UseGeneralChatReturn, activeItem: ChatSessionListItem | null): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AgentConversation chat={chat} activeItem={activeItem} />
    </QueryClientProvider>
  )
}

describe('AgentConversation — D7 gateway unavailable (error face, no silent engine swap)', () => {
  test('no gateway base URL (vitest default) → error notice, no composer, placeholder body', async () => {
    // Under vitest the runtime resolves to 'legacy'/no port → aiSdkEnabled=false →
    // gatewayUnavailable. Before S3 this silently dropped to the legacy engine; now
    // the notice carries the state and nothing sendable mounts.
    mount(fakeChat(), null)
    await waitFor(() =>
      expect(document.querySelector('[data-gateway-error-notice]')).toBeTruthy()
    )
    expect(screen.getByText(i18n.t('chat.aiSdk.degraded'))).toBeTruthy()
    // No probe available (base URL null) → no retry button.
    expect(screen.queryByText(i18n.t('chat.aiSdk.retryProbe'))).toBeNull()
    // No composer / no legacy engine mount.
    expect(screen.queryByLabelText(i18n.t('chat.composer.send'))).toBeNull()
  })

  test('probe-able gateway that fails /health → retry button re-runs the probe', async () => {
    // Web build → resolveAiGatewayBaseUrl()==='' (same-origin) → the
    // /health probe is enabled; make it fail so gatewayDegraded flips on.
    vi.stubEnv('VITE_BUILD_TARGET', 'web')
    const fetchMock = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED')
    })
    vi.stubGlobal('fetch', fetchMock)

    mount(fakeChat(), null)
    // The probe retries once (react-query retry:1, ~1s backoff) before isError flips.
    await waitFor(
      () => expect(document.querySelector('[data-gateway-error-notice]')).toBeTruthy(),
      { timeout: 5000 }
    )
    const retry = screen.getByText(i18n.t('chat.aiSdk.retryProbe'))
    const callsBefore = fetchMock.mock.calls.length
    fireEvent.click(retry)
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore))
  })

  test('gateway down but the active session has history → transcript stays readable (read-only)', async () => {
    vi.stubEnv('VITE_BUILD_TARGET', 'web')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED')
      })
    )
    const chat = fakeChat({
      activeSessionId: 10,
      messagesSessionId: 10,
      messages: [
        fakeMessage({ id: 1, role: 'user', content: '之前问过的问题' }),
        fakeMessage({ id: 2, role: 'assistant', content: '之前的回答内容' })
      ]
    })
    mount(chat, fakeItem({ id: 10, backend_kind: 'ai-sdk' }))
    // Wait for the probe to settle (degraded flips after the retry backoff)…
    await waitFor(
      () => expect(document.querySelector('[data-gateway-error-notice]')).toBeTruthy(),
      { timeout: 5000 }
    )
    // …then the transcript is readable but not sendable.
    await waitFor(() => expect(screen.getByText('之前的回答内容')).toBeTruthy())
    expect(screen.queryByLabelText(i18n.t('chat.composer.send'))).toBeNull()
  })
})

describe('AgentConversation — D6 legacy-kind session renders read-only', () => {
  test('custom-api history session → read-only notice + plain-text transcript, no composer', async () => {
    const chat = fakeChat({
      activeSessionId: 10,
      messagesSessionId: 10,
      messages: [
        fakeMessage({ id: 1, role: 'user', content: '旧引擎的问题' }),
        fakeMessage({ id: 2, role: 'assistant', content: '旧引擎的回答' })
      ]
    })
    mount(chat, fakeItem({ id: 10, backend_kind: 'custom-api' }))
    await waitFor(() =>
      expect(document.querySelector('[data-legacy-readonly-notice]')).toBeTruthy()
    )
    expect(screen.getByText(i18n.t('chat.aiSdk.readOnlyLegacy'))).toBeTruthy()
    await waitFor(() => expect(screen.getByText('旧引擎的回答')).toBeTruthy())
    expect(screen.queryByLabelText(i18n.t('chat.composer.send'))).toBeNull()
  })
})
