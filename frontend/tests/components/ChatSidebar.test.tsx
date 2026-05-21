// @vitest-environment happy-dom
//
// Sprint 14 PR A — ChatSidebar component coverage.
// The sidebar is purely presentational: parent (AIChatPanel) owns sessions
// + activeSessionId + select/new/close callbacks. Coverage stays at the
// presentation layer:
//   1. empty sessions → empty-state copy renders
//   2. multiple sessions → list rendered, active item highlighted with
//      aria-current=true + accent ring, others use the switch aria-label
//   3. clicking an item → onSelectSession called with the right id
//   4. clicking the + button → onNewSession called
//   5. clicking the X button → onClose called
//   6. backend label routing (Notion Agent vs Custom API model id)
//   7. relative time formatter ladders (justNow / minutesAgo / hoursAgo / daysAgo)

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ChatSidebar } from '@shared/components/chat/ChatSidebar'
import type { ChatSession } from '@shared/api/types'
import i18n from '@shared/i18n'

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
})

afterEach(() => {
  cleanup()
})

function fakeSession(over: Partial<ChatSession>): ChatSession {
  return {
    id: 1,
    email_id: 101,
    backend_kind: 'custom-api',
    backend_model: 'claude-sonnet-4-6',
    backend_agent_page_id: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...over
  }
}

describe('ChatSidebar — empty', () => {
  test('renders the empty-state copy when sessions=[]', () => {
    render(
      <ChatSidebar
        sessions={[]}
        activeSessionId={null}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText(i18n.t('chat.sidebar.empty'))).toBeTruthy()
    expect(screen.queryByRole('option')).toBeNull()
  })
})

describe('ChatSidebar — list rendering', () => {
  test('renders one item per session ordered by props', () => {
    const sessions = [
      fakeSession({ id: 7, updated_at: Date.now() - 60_000 }),
      fakeSession({ id: 6, updated_at: Date.now() - 3_600_000 })
    ]
    render(
      <ChatSidebar
        sessions={sessions}
        activeSessionId={7}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getAllByRole('option')).toHaveLength(2)
  })

  test('active session gets aria-current=true; siblings have the switch label', () => {
    const sessions = [fakeSession({ id: 7 }), fakeSession({ id: 6 })]
    render(
      <ChatSidebar
        sessions={sessions}
        activeSessionId={7}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onClose={vi.fn()}
      />
    )
    const active = screen.getByLabelText(i18n.t('chat.sidebar.itemAriaActive'))
    expect(active.getAttribute('aria-current')).toBe('true')
    const inactive = screen.getByLabelText(i18n.t('chat.sidebar.itemAriaSwitch'))
    expect(inactive.getAttribute('aria-current')).toBeNull()
  })
})

describe('ChatSidebar — callbacks', () => {
  test('clicking a session calls onSelectSession(id)', () => {
    const onSelect = vi.fn()
    const sessions = [fakeSession({ id: 7 }), fakeSession({ id: 6 })]
    render(
      <ChatSidebar
        sessions={sessions}
        activeSessionId={7}
        onSelectSession={onSelect}
        onNewSession={vi.fn()}
        onClose={vi.fn()}
      />
    )
    const target = screen.getByLabelText(i18n.t('chat.sidebar.itemAriaSwitch'))
    fireEvent.click(target)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(6)
  })

  test('clicking + button calls onNewSession', () => {
    const onNew = vi.fn()
    render(
      <ChatSidebar
        sessions={[fakeSession({ id: 7 })]}
        activeSessionId={7}
        onSelectSession={vi.fn()}
        onNewSession={onNew}
        onClose={vi.fn()}
      />
    )
    const buttons = screen.getAllByLabelText(i18n.t('chat.sidebar.newSession'))
    fireEvent.click(buttons[0])
    expect(onNew).toHaveBeenCalledTimes(1)
  })

  test('clicking X button calls onClose', () => {
    const onClose = vi.fn()
    render(
      <ChatSidebar
        sessions={[fakeSession({ id: 7 })]}
        activeSessionId={7}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onClose={onClose}
      />
    )
    fireEvent.click(screen.getByLabelText(i18n.t('chat.sidebar.close')))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('ChatSidebar — backend label routing', () => {
  test('notion-agent session shows the Notion Agent label', () => {
    const sessions = [
      fakeSession({
        id: 7,
        backend_kind: 'notion-agent',
        backend_model: null,
        backend_agent_page_id: 'page_abc'
      })
    ]
    render(
      <ChatSidebar
        sessions={sessions}
        activeSessionId={7}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText(i18n.t('chat.backend.notionAgent'))).toBeTruthy()
  })

  test('custom-api session shows the bare model id', () => {
    const sessions = [
      fakeSession({ id: 7, backend_kind: 'custom-api', backend_model: 'gpt-5.4' })
    ]
    render(
      <ChatSidebar
        sessions={sessions}
        activeSessionId={7}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('gpt-5.4')).toBeTruthy()
  })

  test('custom-api with null model falls back to the Custom API translation', () => {
    const sessions = [
      fakeSession({ id: 7, backend_kind: 'custom-api', backend_model: null })
    ]
    render(
      <ChatSidebar
        sessions={sessions}
        activeSessionId={7}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText(i18n.t('chat.backend.customApi'))).toBeTruthy()
  })
})

describe('ChatSidebar — preview (Sprint 14 PR G polish)', () => {
  test('with preview string renders preview as primary, backend label demoted to meta line', () => {
    const sessions = [
      fakeSession({ id: 7, backend_kind: 'custom-api', backend_model: 'claude-sonnet-4-6' })
    ]
    render(
      <ChatSidebar
        sessions={sessions}
        activeSessionId={7}
        previews={{ 7: '帮我总结这封邮件' }}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('帮我总结这封邮件')).toBeTruthy()
    // Backend label still appears on the meta line, alongside the time.
    expect(screen.getByText(/claude-sonnet-4-6/)).toBeTruthy()
  })

  test('missing preview key (still loading) falls back to backend label as primary', () => {
    const sessions = [fakeSession({ id: 7, backend_model: 'gpt-5.4' })]
    render(
      <ChatSidebar
        sessions={sessions}
        activeSessionId={7}
        previews={{}}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('gpt-5.4')).toBeTruthy()
  })

  test('explicit null preview (assistant-only session) falls back to backend label', () => {
    const sessions = [fakeSession({ id: 7, backend_model: 'gpt-5.4' })]
    render(
      <ChatSidebar
        sessions={sessions}
        activeSessionId={7}
        previews={{ 7: null }}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('gpt-5.4')).toBeTruthy()
  })

  test('previews omitted entirely (legacy callers) still renders', () => {
    const sessions = [fakeSession({ id: 7, backend_model: 'claude-opus-4-7' })]
    render(
      <ChatSidebar
        sessions={sessions}
        activeSessionId={7}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('claude-opus-4-7')).toBeTruthy()
  })
})

describe('ChatSidebar — relative time formatter', () => {
  test('< 1 min ago → justNow', () => {
    render(
      <ChatSidebar
        sessions={[fakeSession({ id: 7, updated_at: Date.now() - 30_000 })]}
        activeSessionId={7}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText(i18n.t('chat.sidebar.justNow'))).toBeTruthy()
  })

  test('5 min ago → minutesAgo with n=5', () => {
    render(
      <ChatSidebar
        sessions={[fakeSession({ id: 7, updated_at: Date.now() - 5 * 60_000 })]}
        activeSessionId={7}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText(i18n.t('chat.sidebar.minutesAgo', { n: 5 }))).toBeTruthy()
  })

  test('3 h ago → hoursAgo', () => {
    render(
      <ChatSidebar
        sessions={[fakeSession({ id: 7, updated_at: Date.now() - 3 * 3_600_000 })]}
        activeSessionId={7}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText(i18n.t('chat.sidebar.hoursAgo', { n: 3 }))).toBeTruthy()
  })

  test('2 d ago → daysAgo', () => {
    render(
      <ChatSidebar
        sessions={[fakeSession({ id: 7, updated_at: Date.now() - 2 * 86_400_000 })]}
        activeSessionId={7}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText(i18n.t('chat.sidebar.daysAgo', { n: 2 }))).toBeTruthy()
  })
})
