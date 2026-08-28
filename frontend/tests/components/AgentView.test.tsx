// @vitest-environment happy-dom
//
// demo-fidelity Phase 7 → S3 W2 — MailAgent agent-view component render smoke.
//
// Mounts the agent-view thread (AgentThread + AgentMessage + AgentComposer) on the
// AI SDK runtime seeded with initialMessages (the same mount AgentConversation uses
// for reload + the D6 read-only path) — the legacy ExternalStore runtime is deleted.
// Asserts the demo layout renders: assistant prose + user message, the empty-state
// welcome + centered composer + quick-action chips, the shared ModelPicker (chip variant) /
// attachment toolbar (with controls), and readOnly composer suppression. The shared
// MarkdownText is mocked to a plain div (its internals are covered by its own tests).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { ChatMessage, ChatSessionListItem } from '@shared/api/types'
import i18n from '@shared/i18n'

vi.mock('@shared/components/email/TranslatedBody', () => ({
  TranslatedBody: ({ text }: { text: string }) => <div data-testid="md">{text}</div>
}))

import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { chatMessageToUIMessage } from '@shared/assistant/uiMessage'
import { ChatComposerControlsProvider } from '@shared/assistant/components/composerControls'
import { type ChatComposerControls } from '@shared/assistant/components/composerControlsContext'
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
    // W8 (08-04) — availableModels 升成富对象数组；这里给「零元数据」形态（provider 表不可达时
    // useComposerModels 就是这么退化的），确保 picker 在最贫瘠的输入下也照常渲染。
    availableModels: ['claude-sonnet-4-6', 'gpt-4o', 'gemini-2.0-flash'].map((ref) => ({
      ref,
      providerId: 'default',
      providerLabel: null,
      protocol: null,
      modelId: ref,
      displayName: ref,
      capabilities: null,
      maxOutput: null
    })),
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

  test('composer toolbar (with controls) shows the model picker + "+" menu', async () => {
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
    // (lexical trigger popover), so there is no separate @ button — only the "+" menu (08-04 WP6:
    // attachment + connectors live behind it) + model picker remain.
    await waitFor(() => expect(screen.getByText('claude-sonnet-4-6')).toBeTruthy())
    expect(screen.getByLabelText(i18n.t('chat.composer.plus'))).toBeTruthy()
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
    onPin: vi.fn(),
    onStar: vi.fn(),
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

  // 08-27 标签工作区批：对话域的页面自管列充当二级栏，展开态定宽 336
  //（rail 56 + 336 = 392，与其他域左列边界对齐）。改这个数 = 改左列总宽契约，
  // 要与 .nav-panel(336) / nav-shell NAV_W_EXPANDED(392) 一起动。
  test('展开态列宽 336（392px 左列对齐契约）；折叠仍是 48px rail', () => {
    const { container } = render(<AgentThreadList items={[]} {...handlers} />)
    expect(container.querySelector('aside')?.className).toContain('w-[336px]')
  })

  // 会话列 = 对话域的二级栏：nav shell 折叠时整列 `display:none` 而**不卸载**（保滚动
  // 位置与分组展开态，同 InboxLayout 的邮件列）。接线在 AgentViewLayout —— 少了它，
  // rail 的开合按钮在对话域就是空转（点了只翻全局偏好，列一动不动）。
  test('navHidden → 整列 hidden（不卸载）；与列自己的 rail 折叠叠加时 hidden 赢', () => {
    const { container, rerender } = render(<AgentThreadList items={[]} {...handlers} />)
    const aside = container.querySelector('aside')
    // 🔴 token 级判定（classList）不是子串 —— 基线 className 里本来就有 overflow-hidden，
    // `toContain('hidden')` 会恒真。
    expect(aside?.classList.contains('hidden')).toBe(false)

    rerender(<AgentThreadList items={[]} {...handlers} navHidden />)
    // 同一个 DOM 节点（没被卸载重建），只是多了 hidden。
    expect(container.querySelector('aside')).toBe(aside)
    expect(aside?.classList.contains('hidden')).toBe(true)

    rerender(<AgentThreadList items={[]} {...handlers} collapsed navHidden />)
    expect(container.querySelector('aside')?.classList.contains('hidden')).toBe(true)
  })

  // 上一条测的是「给了 navHidden 会怎样」，这条测**接线本身在不在**：AgentViewLayout
  // 不读 useNavCollapsed / 不传这个 prop 的话，上一条照样绿而 rail 的开合按钮在对话域
  // 空转（本批复核抓到的就是这个形态）。判声明与使用，同 composer_attachment_frame 的
  // 三场地闸的写法。
  test('接线在场：AgentViewLayout 读 useNavCollapsed 并把它传给会话列', () => {
    const raw = readFileSync(
      resolve(process.cwd(), 'src/shared/components/agents/AgentViewLayout.tsx'),
      'utf8'
    )
    // 🔴 先剥注释再判 —— 这个文件的注释里就写着这两个名字（讲的正是这条接线），
    // 直接对全文 match 的话「把那行注释掉」这种回归照样绿。
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    // canary：剥完还得剩下东西，正则写坏把整个文件吃光时先在这里红。
    expect(code.length).toBeGreaterThan(raw.length / 2)
    expect(code).toContain('useNavCollapsed')
    expect(code).toMatch(/navHidden=\{navHidden\}/)
  })
})

// ── 08-06 owner dogfood ④：star 收进「…」菜单，行首图标表达星标态 ─────────────────────
//
// owner 原话：「会话列表，不要把 star 按钮直接铺出来，放在…菜单里，只是 star 后，会话前面的
// icon（现在是线条 chat icon）换成实心黄色 star icon 来标识就好了。」
//
// 覆盖的契约：
//   1. 行上**不再常驻** star 按钮（每行少一个恒在的动作面）；
//   2. 星标态由**行首图标**表达：线条 chat/mail → 实心琥珀 star（用 `--c-impt`，不是 warn/fail
//      —— 后两个在本 app 恒表示「出问题了」）；
//   3. 星标动作搬进已有的「…」菜单，且与**置顶**是分开的两项（pin 排序、star 标识，两件事）。
describe('Agent view — 会话行星标（08-06 ④）', () => {
  const handlers = {
    activeSessionId: null,
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onDelete: vi.fn(),
    onRename: vi.fn(),
    onArchive: vi.fn(),
    onRestore: vi.fn(),
    onPin: vi.fn(),
    onStar: vi.fn(),
    collapsed: false,
    onToggleCollapse: vi.fn()
  }
  const starIcon = (root: HTMLElement): Element | null =>
    root.querySelector('svg.lucide-star[fill="currentColor"]')

  test('🔴 行上不再常驻 star 按钮（搬进「…」菜单之前它是每行第一个可点的东西）', () => {
    render(
      <AgentThreadList
        items={[fakeListItem({ id: 1, first_user_message: 'hi', starred: 1 })]}
        {...handlers}
      />
    )
    // 菜单没打开时，整棵树里不该有星标动作的可点面。
    expect(screen.queryByRole('button', { name: i18n.t('agentView.unstar') })).toBeNull()
    expect(screen.queryByRole('button', { name: i18n.t('agentView.star') })).toBeNull()
  })

  test('🔴 星标态 = 行首实心琥珀星；未星标仍是线条 chat 图标', () => {
    const { container, rerender } = render(
      <AgentThreadList
        items={[fakeListItem({ id: 1, first_user_message: 'hi', starred: 0 })]}
        {...handlers}
      />
    )
    expect(starIcon(container)).toBeNull()

    rerender(
      <AgentThreadList
        items={[fakeListItem({ id: 1, first_user_message: 'hi', starred: 1 })]}
        {...handlers}
      />
    )
    const star = starIcon(container)
    expect(star).toBeTruthy()
    // 琥珀（--c-impt），不是 accent/warn/fail。
    expect(star!.getAttribute('class')).toContain('text-impt')
  })

  // 🔴 本批引入的退化，必须补回：改动前星标是一颗带 `aria-pressed` 的按钮，读屏两态都能读出；
  // 改成纯视觉图标后若不给可及名，状态就只能从「…」菜单的动作文案倒推。**两态都要有名**
  // （不是只在星标时加一句）—— 那才是与 `aria-pressed` 等价的 parity。
  test('🔴 星标态对读屏可见：行首图标两态各有可及名', () => {
    const { rerender } = render(
      <AgentThreadList
        items={[fakeListItem({ id: 1, first_user_message: 'hi', starred: 1 })]}
        {...handlers}
      />
    )
    expect(screen.getByRole('img', { name: i18n.t('agentView.starred') })).toBeTruthy()
    expect(screen.queryByRole('img', { name: i18n.t('agentView.notStarred') })).toBeNull()

    rerender(
      <AgentThreadList
        items={[fakeListItem({ id: 1, first_user_message: 'hi', starred: 0 })]}
        {...handlers}
      />
    )
    expect(screen.getByRole('img', { name: i18n.t('agentView.notStarred') })).toBeTruthy()
    expect(screen.queryByRole('img', { name: i18n.t('agentView.starred') })).toBeNull()
  })

  test('「…」菜单里能加星 / 取消星标，且与置顶分开两项', async () => {
    handlers.onStar.mockClear()
    handlers.onPin.mockClear()
    const { rerender } = render(
      <AgentThreadList
        items={[fakeListItem({ id: 7, first_user_message: 'hi', starred: 0 })]}
        {...handlers}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: i18n.t('agentView.more') }))
    const starItem = await screen.findByRole('button', { name: i18n.t('agentView.star') })
    // 置顶是**另一项**（两件事：pin 管排序、star 管标识），断言要在菜单还开着的时候做 ——
    // 点了星标菜单就收了。
    expect(screen.getByRole('button', { name: i18n.t('agentView.pin') })).toBeTruthy()
    fireEvent.click(starItem)
    expect(handlers.onStar).toHaveBeenCalledWith(7, true)
    expect(handlers.onPin).not.toHaveBeenCalled()

    // 已星标的行：同一项翻成「取消星标」。
    rerender(
      <AgentThreadList
        items={[fakeListItem({ id: 7, first_user_message: 'hi', starred: 1 })]}
        {...handlers}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: i18n.t('agentView.more') }))
    fireEvent.click(await screen.findByRole('button', { name: i18n.t('agentView.unstar') }))
    expect(handlers.onStar).toHaveBeenLastCalledWith(7, false)
  })
})
