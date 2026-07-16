// @vitest-environment happy-dom
//
// codex r2 [D] (task 07-15 harness-chat) — sendDisabled must gate the composer's REAL submit path,
// not just the Send button: assistant-ui's ComposerPrimitive.Input Enter requestSubmit()s the Root
// form, whose composed handler calls send() unless the user onSubmit prevented default. Pins, on
// the real AI SDK runtime + real ThreadComposer:
//   1. busy → the Input textarea is disabled and the Send button is disabled.
//   2. busy → a form submit (the Enter path's landing point) sends NOTHING (no /api/ai/chat POST).
//   3. not busy → the same form submit sends (control assertion: the gate, not the harness,
//      blocked it).
//
// codex r3 P2 — the AGENT composer's real interaction paths, which all bypass the Root form:
//   4. Lexical Enter (submitMode 'none' while busy — the Enter path calls aui.composer().send()
//      directly).
//   5. slash-command execute (the '/' trigger popover appends straight through the thread).
//   6. follow-up chips (ThreadPrimitive.Suggestion autoSend in AgentThread).
// Each pinned busy→nothing / unblocked→sends on the real runtime + real components.

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAui } from '@assistant-ui/react'

import type { ChatMessage } from '@shared/api/types'
import i18n from '@shared/i18n'

// AgentMessage renders assistant prose through TranslatedBody (markdown + translate machinery) —
// mock it to a plain div, mirroring AgentView.test.tsx (its internals have their own tests).
vi.mock('@shared/components/email/TranslatedBody', () => ({
  TranslatedBody: ({ text }: { text: string }) => <div data-testid="md">{text}</div>
}))

import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { chatMessageToUIMessage } from '@shared/assistant/uiMessage'
import {
  ChatComposerControlsProvider,
  type ChatComposerControls
} from '@shared/assistant/components/composerControls'
import { ThreadComposer } from '@shared/assistant/components/composer'
import { AgentComposer } from '@shared/components/agents/AgentComposer'
import { AgentThread } from '@shared/components/agents/AgentThread'

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
  // assistant-ui Viewport / lexical rely on observers happy-dom lacks; stub them.
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
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function stubControls(over: Partial<ChatComposerControls> = {}): ChatComposerControls {
  return {
    thinkingSupported: false,
    thinkingEnabled: false,
    onToggleThinking: vi.fn(),
    model: 'claude-sonnet-4-6',
    availableModels: [],
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

const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })

function Harness({ sendDisabled }: { sendDisabled: boolean }): React.ReactElement {
  return (
    <QueryClientProvider client={qc}>
      <AiSdkRuntimeProvider gatewayBaseUrl="http://127.0.0.1:1" sessionId={7}>
        <ChatComposerControlsProvider value={stubControls({ sendDisabled })}>
          <ThreadComposer />
        </ChatComposerControlsProvider>
      </AiSdkRuntimeProvider>
    </QueryClientProvider>
  )
}

function chatPosts(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/ai/chat')).length
}

describe('codex r2 [D] — sendDisabled gates the whole composer, not just the Send button', () => {
  test('busy → Input disabled + Send disabled; form submit sends nothing; unblocked submit sends', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    const { rerender, container } = render(<Harness sendDisabled={false} />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)

    // type while enabled (a disabled textarea can't be typed into — that's part of the fence)
    fireEvent.change(textarea, { target: { value: 'hello there' } })

    // flip busy → the Input is disabled and Send is disabled
    rerender(<Harness sendDisabled={true} />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true)
    const send = screen.getByRole('button', { name: /send|发送/i }) as HTMLButtonElement
    expect(send.disabled).toBe(true)

    // the Enter path lands here: a form submit while busy must NOT send
    const form = container.querySelector('form')!
    fireEvent.submit(form)
    await new Promise((r) => setTimeout(r, 80))
    expect(chatPosts(fetchMock)).toBe(0)

    // control assertion: unblock → the SAME submit path sends (so the gate did the blocking above)
    rerender(<Harness sendDisabled={false} />)
    fireEvent.submit(container.querySelector('form')!)
    await waitFor(() => expect(chatPosts(fetchMock)).toBe(1))
  })
})

// ── codex r3 P2 — the AGENT composer's real interaction paths ────────────────────────────────────

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

/** Captures the aui client from inside the runtime provider so the test can drive composer state
 *  through the REAL runtime (lexical mirrors composer text via its SyncPlugin). */
let capturedAui: ReturnType<typeof useAui> | null = null
function AuiProbe(): null {
  capturedAui = useAui()
  return null
}

function AgentHarness({
  sendDisabled,
  initialMessages = [],
  children
}: {
  sendDisabled: boolean
  initialMessages?: ChatMessage[]
  children: React.ReactNode
}): React.ReactElement {
  return (
    <QueryClientProvider client={qc}>
      <ChatComposerControlsProvider value={stubControls({ sendDisabled })}>
        <AiSdkRuntimeProvider
          gatewayBaseUrl="http://127.0.0.1:1"
          sessionId={7}
          initialMessages={initialMessages.map(chatMessageToUIMessage)}
        >
          <AuiProbe />
          {children}
        </AiSdkRuntimeProvider>
      </ChatComposerControlsProvider>
    </QueryClientProvider>
  )
}

function stubChatFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('codex r3 P2 — sendDisabled gates the agent composer paths (Lexical Enter / slash / follow-up)', () => {
  afterEach(() => {
    capturedAui = null
  })

  test('Lexical Enter — busy sends nothing (submitMode none); unblocked Enter sends', async () => {
    const fetchMock = stubChatFetch()
    const { rerender, container } = render(
      <AgentHarness sendDisabled={true}>
        <AgentComposer />
      </AgentHarness>
    )
    const editable = container.querySelector('[contenteditable="true"]')!
    expect(editable).toBeTruthy()

    // put text in the composer through the real runtime (SyncPlugin mirrors it into lexical)
    act(() => capturedAui!.composer().setText('hello there'))
    // the Lexical Enter path calls aui.composer().send() directly — busy turns it off entirely
    fireEvent.keyDown(editable, { key: 'Enter' })
    await new Promise((r) => setTimeout(r, 80))
    expect(chatPosts(fetchMock)).toBe(0)

    // control assertion: unblock → the SAME Enter path sends
    rerender(
      <AgentHarness sendDisabled={false}>
        <AgentComposer />
      </AgentHarness>
    )
    act(() => capturedAui!.composer().setText('hello there'))
    fireEvent.keyDown(editable, { key: 'Enter' })
    await waitFor(() => expect(chatPosts(fetchMock)).toBe(1))
  })

  test('slash execute — busy: picking a slash command appends nothing; unblocked: it sends', async () => {
    const fetchMock = stubChatFetch()
    const label = i18n.t('agentView.quickActions.summarize.label')
    const { rerender } = render(
      <AgentHarness sendDisabled={true}>
        <AgentComposer />
      </AgentHarness>
    )

    // typing '/' (mirrored through the runtime) opens the trigger popover with the slash commands
    act(() => capturedAui!.composer().setText('/'))
    const item = await screen.findByText(label)
    fireEvent.click(item)
    await new Promise((r) => setTimeout(r, 80))
    expect(chatPosts(fetchMock)).toBe(0)

    // control assertion: unblock → the SAME popover pick appends through the thread → sends
    rerender(
      <AgentHarness sendDisabled={false}>
        <AgentComposer />
      </AgentHarness>
    )
    act(() => capturedAui!.composer().setText('/'))
    fireEvent.click(await screen.findByText(label))
    await waitFor(() => expect(chatPosts(fetchMock)).toBe(1))
  })

  test('follow-up chip — busy: chip disabled + click sends nothing; unblocked: click sends', async () => {
    const fetchMock = stubChatFetch()
    const followUp = '接下来需要我做什么？'
    const seeded = [fakeMessage({ id: 2, role: 'assistant', content: '已经总结完了。' })]
    const { rerender } = render(
      <AgentHarness sendDisabled={true} initialMessages={seeded}>
        <AgentThread followUps={[followUp]} />
      </AgentHarness>
    )
    const chip = (await screen.findByText(followUp)).closest('button')!
    expect(chip.disabled).toBe(true)
    fireEvent.click(chip)
    await new Promise((r) => setTimeout(r, 80))
    expect(chatPosts(fetchMock)).toBe(0)

    // control assertion: unblock → the SAME chip autoSends through the runtime
    rerender(
      <AgentHarness sendDisabled={false} initialMessages={seeded}>
        <AgentThread followUps={[followUp]} />
      </AgentHarness>
    )
    const enabledChip = (await screen.findByText(followUp)).closest('button')!
    expect(enabledChip.disabled).toBe(false)
    fireEvent.click(enabledChip)
    await waitFor(() => expect(chatPosts(fetchMock)).toBe(1))
  })
})
