// @vitest-environment happy-dom
//
// demo-fidelity Phase 7 → S3 W2 — MailAgent agent-view component render smoke.
//
// Mounts the agent-view thread (AgentThread + AgentMessage + AgentComposer) on the
// AI SDK runtime seeded with initialMessages (the same mount AgentConversation uses
// for reload + the D6 read-only path) — the legacy ExternalStore runtime is deleted.
// Asserts the demo layout renders: assistant prose + user message, the empty-state
// welcome + centered composer + quick-action chips, the vendor-icon model picker /
// attachment toolbar (with controls), and readOnly composer suppression. The shared
// MarkdownText is mocked to a plain div (its internals are covered by its own tests).

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { ChatMessage, ChatSessionListItem } from '@shared/api/types'
import i18n from '@shared/i18n'

vi.mock('@shared/components/email/TranslatedBody', () => ({
  TranslatedBody: ({ text }: { text: string }) => <div data-testid="md">{text}</div>
}))

import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { chatMessageToUIMessage } from '@shared/assistant/uiMessage'
import {
  ChatComposerControlsProvider,
  type ChatComposerControls
} from '@shared/assistant/components/composerControls'
import { AgentThread } from '@shared/components/agents/AgentThread'
import { AgentQuickActions } from '@shared/components/agents/AgentQuickActions'
import { AgentThreadList } from '@shared/components/agents/AgentThreadList'

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
  // assistant-ui Viewport relies on observers happy-dom lacks; stub them.
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

/** Mount an AgentThread on the AI SDK runtime seeded with the given rows (the
 *  reload / D6 read-only mount shape). The transport never fires in these tests
 *  (no send), so a dummy loopback base is fine. */
function mountThread(
  messages: ChatMessage[],
  thread: React.ReactElement
): ReturnType<typeof render> {
  return render(
    <AiSdkRuntimeProvider
      gatewayBaseUrl=""
      sessionId={null}
      initialMessages={messages.map(chatMessageToUIMessage)}
    >
      {thread}
    </AiSdkRuntimeProvider>
  )
}

function stubControls(over: Partial<ChatComposerControls> = {}): ChatComposerControls {
  return {
    thinkingSupported: true,
    thinkingEnabled: true,
    onToggleThinking: vi.fn(),
    model: 'claude-sonnet-4-6',
    availableModels: ['claude-sonnet-4-6', 'gpt-4o', 'gemini-2.0-flash'],
    onModelChange: vi.fn(),
    modelPickerDisabled: false,
    mentions: [],
    onAddMention: vi.fn(),
    onRemoveMention: vi.fn(),
    attachments: [],
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    ...over
  }
}

describe('Agent view — demo-fidelity thread', () => {
  test('user + assistant messages render in the agent layout', async () => {
    mountThread(
      [
        fakeMessage({ id: 1, role: 'user', content: '帮我安排今天的邮件' }),
        fakeMessage({ id: 2, role: 'assistant', content: '好的，这是今天的待办。' })
      ],
      <AgentThread quickActions={<AgentQuickActions />} />
    )
    await waitFor(() => expect(screen.getByText('帮我安排今天的邮件')).toBeTruthy())
    expect(screen.getByText('好的，这是今天的待办。')).toBeTruthy()
  })

  test('empty thread shows the welcome + composer + quick-action chips', async () => {
    mountThread([], <AgentThread quickActions={<AgentQuickActions />} />)
    await waitFor(() => expect(screen.getByText(i18n.t('agentView.welcome'))).toBeTruthy())
    // composer present (LexicalComposerInput renders a contenteditable, not an aria-labelled input,
    // so assert the send button — our toolbar chrome — as the "composer rendered" signal).
    expect(screen.getByLabelText(i18n.t('chat.composer.send'))).toBeTruthy()
    // a quick-action category label sits below the centered composer
    expect(screen.getByText(i18n.t('agentView.quickActions.summarize.label'))).toBeTruthy()
  })

  test('readOnly suppresses the composer (D6 read-only mount)', async () => {
    mountThread(
      [fakeMessage({ id: 2, role: 'assistant', content: '历史回答' })],
      <AgentThread quickActions={<AgentQuickActions />} readOnly />
    )
    await waitFor(() => expect(screen.getByText('历史回答')).toBeTruthy())
    // readOnly drops the composer entirely → no send button.
    expect(screen.queryByLabelText(i18n.t('chat.composer.send'))).toBeNull()
  })

  test('composer toolbar (with controls) shows the model picker + attachment', async () => {
    // With controls, AgentComposer mounts AgentMentionButton → MentionPopover, which runs a useQuery
    // unconditionally → a QueryClientProvider is required (the search itself stays disabled while empty).
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <ChatComposerControlsProvider value={stubControls()}>
          <AiSdkRuntimeProvider gatewayBaseUrl="" sessionId={null}>
            <AgentThread quickActions={<AgentQuickActions />} />
          </AiSdkRuntimeProvider>
        </ChatComposerControlsProvider>
      </QueryClientProvider>
    )
    // model picker trigger shows the active model id (vendor icon is aria-hidden); @ is now in-field
    // (lexical trigger popover), so there is no separate @ button — only attach + model picker remain.
    await waitFor(() => expect(screen.getByText('claude-sonnet-4-6')).toBeTruthy())
    expect(screen.getByLabelText(i18n.t('chat.composer.attach'))).toBeTruthy()
  })
})

function fakeListItem(over: Partial<ChatSessionListItem>): ChatSessionListItem {
  const now = Date.now()
  return {
    id: 1,
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

describe('Agent view — unified history list (Phase 9)', () => {
  const handlers = {
    activeSessionId: null,
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onDelete: vi.fn(),
    onRename: vi.fn(),
    onArchive: vi.fn(),
    onRestore: vi.fn(),
    collapsed: false,
    onToggleCollapse: vi.fn()
  }

  test('email session shows its subject; general session shows the first user message', () => {
    render(
      <AgentThreadList
        items={[
          fakeListItem({ id: 1, anchor_type: 'email', email_id: 99, email_subject: '续约确认' }),
          fakeListItem({ id: 2, anchor_type: 'general', first_user_message: '帮我总结今天的邮件' })
        ]}
        {...handlers}
      />
    )
    expect(screen.getByText('续约确认')).toBeTruthy()
    expect(screen.getByText('帮我总结今天的邮件')).toBeTruthy()
  })

  test('empty unified list shows the empty-history hint', () => {
    render(<AgentThreadList items={[]} {...handlers} />)
    expect(screen.getByText(i18n.t('agentView.emptyHistory'))).toBeTruthy()
  })
})
