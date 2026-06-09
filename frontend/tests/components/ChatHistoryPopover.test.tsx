// @vitest-environment happy-dom
//
// task 06-08-chat §3.1 — ChatHistoryPopover component coverage.
// Ports the old ChatSidebar.test.tsx (the data model + item rendering carry
// over verbatim) and adds popover-specific behaviour:
//   1. empty sessions → empty-state copy + agent/footer header chrome
//   2. multiple sessions → list rendered, active item highlighted
//   3. clicking an item → onSelectSession(id) + onClose
//   4. clicking + → onNewSession + onClose
//   5. header label routes to the active agent + footer "not shared" copy
//   6. backend label routing (Notion Agent vs Custom API model id)
//   7. preview fallback ladder + relative time formatter
//   8. inline delete confirm flow (does not bubble to onSelectSession)

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ChatHistoryPopover } from '@shared/components/chat/ChatHistoryPopover'
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

describe('ChatHistoryPopover — empty + chrome', () => {
  test('renders empty-state copy + agent header + footer when sessions=[]', () => {
    render(
      <ChatHistoryPopover
        backendKind="custom-api"
        sessions={[]}
        activeSessionId={null}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText(i18n.t('chat.sidebar.empty'))).toBeTruthy()
    expect(screen.queryByRole('option')).toBeNull()
    // Header label is "{Custom AI} · Recent" and the footer reminds the user.
    expect(
      screen.getByText(
        i18n.t('chat.sidebar.recentTitle', { agent: i18n.t('chat.backend.customApi') })
      )
    ).toBeTruthy()
    expect(screen.getByText(i18n.t('chat.sidebar.notShared'))).toBeTruthy()
  })

  test('header label follows the active backend kind (notion-agent)', () => {
    render(
      <ChatHistoryPopover
        backendKind="notion-agent"
        sessions={[]}
        activeSessionId={null}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(
      screen.getByText(
        i18n.t('chat.sidebar.recentTitle', { agent: i18n.t('chat.backend.notionAgent') })
      )
    ).toBeTruthy()
  })
})

describe('ChatHistoryPopover — list rendering', () => {
  test('renders one item per session', () => {
    const sessions = [
      fakeSession({ id: 7, updated_at: Date.now() - 60_000 }),
      fakeSession({ id: 6, updated_at: Date.now() - 3_600_000 })
    ]
    render(
      <ChatHistoryPopover
        backendKind="custom-api"
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
      <ChatHistoryPopover
        backendKind="custom-api"
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

describe('ChatHistoryPopover — callbacks', () => {
  test('clicking a session calls onSelectSession(id) + onClose', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    const sessions = [fakeSession({ id: 7 }), fakeSession({ id: 6 })]
    render(
      <ChatHistoryPopover
        backendKind="custom-api"
        sessions={sessions}
        activeSessionId={7}
        onSelectSession={onSelect}
        onNewSession={vi.fn()}
        onClose={onClose}
      />
    )
    fireEvent.click(screen.getByLabelText(i18n.t('chat.sidebar.itemAriaSwitch')))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(6)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('clicking + button calls onNewSession + onClose', () => {
    const onNew = vi.fn()
    const onClose = vi.fn()
    render(
      <ChatHistoryPopover
        backendKind="custom-api"
        sessions={[fakeSession({ id: 7 })]}
        activeSessionId={7}
        onSelectSession={vi.fn()}
        onNewSession={onNew}
        onClose={onClose}
      />
    )
    fireEvent.click(screen.getByLabelText(i18n.t('chat.sidebar.newSession')))
    expect(onNew).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('Escape closes the popover', () => {
    const onClose = vi.fn()
    render(
      <ChatHistoryPopover
        backendKind="custom-api"
        sessions={[fakeSession({ id: 7 })]}
        activeSessionId={7}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onClose={onClose}
      />
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('ChatHistoryPopover — backend label routing', () => {
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
      <ChatHistoryPopover
        backendKind="notion-agent"
        sessions={sessions}
        activeSessionId={7}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onClose={vi.fn()}
      />
    )
    // Notion Agent label appears both in the header chrome and the item row.
    expect(screen.getAllByText(i18n.t('chat.backend.notionAgent')).length).toBeGreaterThan(0)
  })

  test('custom-api session shows the bare model id', () => {
    const sessions = [fakeSession({ id: 7, backend_kind: 'custom-api', backend_model: 'gpt-5.4' })]
    render(
      <ChatHistoryPopover
        backendKind="custom-api"
        sessions={sessions}
        activeSessionId={7}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('gpt-5.4')).toBeTruthy()
  })
})

describe('ChatHistoryPopover — preview fallback', () => {
  test('with preview string renders preview as primary, backend label in meta', () => {
    const sessions = [
      fakeSession({ id: 7, backend_kind: 'custom-api', backend_model: 'claude-sonnet-4-6' })
    ]
    render(
      <ChatHistoryPopover
        backendKind="custom-api"
        sessions={sessions}
        activeSessionId={7}
        previews={{ 7: '帮我总结这封邮件' }}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('帮我总结这封邮件')).toBeTruthy()
    expect(screen.getByText(/claude-sonnet-4-6/)).toBeTruthy()
  })

  test('missing preview key (loading) falls back to backend label as primary', () => {
    const sessions = [fakeSession({ id: 7, backend_model: 'gpt-5.4' })]
    render(
      <ChatHistoryPopover
        backendKind="custom-api"
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
})

describe('ChatHistoryPopover — delete affordance', () => {
  test('without onDeleteSession the trash icon does NOT render', () => {
    render(
      <ChatHistoryPopover
        backendKind="custom-api"
        sessions={[fakeSession({ id: 7 })]}
        activeSessionId={7}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.queryByLabelText(i18n.t('chat.sidebar.delete'))).toBeNull()
  })

  test('inline confirm flow commits with the session id', () => {
    const onDelete = vi.fn()
    render(
      <ChatHistoryPopover
        backendKind="custom-api"
        sessions={[fakeSession({ id: 7 })]}
        activeSessionId={7}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onClose={vi.fn()}
        onDeleteSession={onDelete}
      />
    )
    fireEvent.click(screen.getByLabelText(i18n.t('chat.sidebar.delete')))
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText(i18n.t('chat.sidebar.deleteConfirm')))
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledWith(7)
  })

  test('clicking trash does NOT bubble to onSelectSession', () => {
    const onSelect = vi.fn()
    const onDelete = vi.fn()
    render(
      <ChatHistoryPopover
        backendKind="custom-api"
        sessions={[fakeSession({ id: 7 })]}
        activeSessionId={7}
        onSelectSession={onSelect}
        onNewSession={vi.fn()}
        onClose={vi.fn()}
        onDeleteSession={onDelete}
      />
    )
    fireEvent.click(screen.getByLabelText(i18n.t('chat.sidebar.delete')))
    fireEvent.click(screen.getByLabelText(i18n.t('chat.sidebar.deleteConfirm')))
    expect(onSelect).not.toHaveBeenCalled()
  })
})

describe('ChatHistoryPopover — relative time formatter', () => {
  test('< 1 min ago → justNow', () => {
    render(
      <ChatHistoryPopover
        backendKind="custom-api"
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
      <ChatHistoryPopover
        backendKind="custom-api"
        sessions={[fakeSession({ id: 7, updated_at: Date.now() - 5 * 60_000 })]}
        activeSessionId={7}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText(i18n.t('chat.sidebar.minutesAgo', { n: 5 }))).toBeTruthy()
  })

  test('2 d ago → daysAgo', () => {
    render(
      <ChatHistoryPopover
        backendKind="custom-api"
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
