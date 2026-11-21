// @vitest-environment happy-dom

import { useEffect } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import i18n from '@shared/i18n'
import { InspectorProvider } from '@shared/assistant/inspector/InspectorProvider'
import { useSessionInspector } from '@shared/assistant/inspector/inspectorContext'
import type { SessionWorkspaceSnapshot } from '@shared/assistant/inspector/deriveSessionWorkspace'
import { formatSessionTranscriptMarkdown } from '@shared/assistant/formatSessionMarkdown'
import { AgentChatHeaderBar } from '@shared/components/agents/AgentChatHeaderBar'

vi.mock('@shared/assistant/assistantIdentity', () => ({
  useAssistantIdentity: () => ({ name: 'Jarvis', avatar: null })
}))

await i18n.changeLanguage('en-US')

beforeAll(() => {
  for (const key of ['ResizeObserver', 'IntersectionObserver'] as const) {
    if (!(key in globalThis)) {
      ;(globalThis as Record<string, unknown>)[key] = class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
        takeRecords(): [] {
          return []
        }
      }
    }
  }
})

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
})

function SeedSnapshot({ snapshot }: { readonly snapshot: SessionWorkspaceSnapshot }): null {
  const inspector = useSessionInspector()
  const publish = inspector?.publishSnapshot
  useEffect(() => {
    publish?.(snapshot)
  }, [publish, snapshot])
  return null
}

const ARTIFACT_SNAPSHOT: SessionWorkspaceSnapshot = {
  artifacts: [{ id: 'html:1', kind: 'html', title: 'compare.html', isHtml: true }],
  sources: { explicit: [], consulted: [] },
  links: [],
  skills: [],
  connectorsUsed: [],
  totalItems: 1
}

describe('AgentChatHeaderBar & formatSessionTranscriptMarkdown', () => {
  test('renders agent identity + title, hides empty workspace button, and triggers header actions', () => {
    const callbacks = {
      onNew: vi.fn(),
      onShare: vi.fn(),
      onToggleBrowser: vi.fn(),
      onTogglePin: vi.fn(),
      onRename: vi.fn(),
      onArchive: vi.fn(),
      onRestore: vi.fn(),
      onDelete: vi.fn()
    }

    const { rerender } = render(
      <InspectorProvider sessionKey="s:10" autoOpenWhenPopulated={false}>
        <AgentChatHeaderBar
          sessionId={10}
          sessionTitle="Architecture Sync"
          isPinned={false}
          isArchived={false}
          browserOpen={false}
          browserActive={false}
          {...callbacks}
        />
      </InspectorProvider>
    )

    expect(screen.getByText('Jarvis')).toBeTruthy()
    expect(screen.getByText('Architecture Sync')).toBeTruthy()
    expect(screen.queryByTestId('inspector-toggle-pill')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    fireEvent.click(screen.getByRole('button', { name: 'Share chat' }))
    fireEvent.click(screen.getByRole('button', { name: 'Browser' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }))

    expect(callbacks.onNew).toHaveBeenCalledTimes(1)
    expect(callbacks.onShare).toHaveBeenCalledTimes(1)
    expect(callbacks.onToggleBrowser).toHaveBeenCalledTimes(1)
    expect(callbacks.onTogglePin).toHaveBeenCalledTimes(1)

    // Populated workspace surfaces the header inspector button
    rerender(
      <InspectorProvider sessionKey="s:10" autoOpenWhenPopulated={false}>
        <SeedSnapshot snapshot={ARTIFACT_SNAPSHOT} />
        <AgentChatHeaderBar
          sessionId={10}
          sessionTitle="Architecture Sync"
          isPinned={false}
          isArchived={false}
          browserOpen={false}
          browserActive={false}
          {...callbacks}
        />
      </InspectorProvider>
    )

    const toggleBtn = screen.getByTestId('inspector-toggle-pill')
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggleBtn)
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true')

    // More menu exposes Rename, Archive, Delete
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    expect(callbacks.onArchive).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(callbacks.onDelete).toHaveBeenCalledTimes(1)

    // Inline title rename
    fireEvent.click(screen.getByRole('button', { name: 'Architecture Sync' }))
    const input = screen.getByLabelText('Rename') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Updated Title' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(callbacks.onRename).toHaveBeenCalledWith('Updated Title')
  })

  test('formatSessionTranscriptMarkdown skips system/tool noise and reads ui_message_json text', () => {
    const md = formatSessionTranscriptMarkdown('Design Review', [
      { role: 'system', content: 'compact marker', ui_message_json: null },
      { role: 'user', content: 'Fallback', ui_message_json: null },
      {
        role: 'assistant',
        content: 'Raw content',
        ui_message_json: JSON.stringify({
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: 'internal reasoning' },
            { type: 'text', text: 'Clear answer here.' }
          ]
        })
      }
    ])

    expect(md).toContain('# Design Review')
    expect(md).toContain('## User\n\nFallback')
    expect(md).toContain('## Assistant\n\nClear answer here.')
    expect(md).not.toContain('compact marker')
  })
})
