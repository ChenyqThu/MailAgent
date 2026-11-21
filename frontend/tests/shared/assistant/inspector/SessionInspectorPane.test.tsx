// @vitest-environment happy-dom

import { useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { SessionWorkspaceSnapshot } from '@shared/assistant/inspector/deriveSessionWorkspace'
import { InspectorProvider } from '@shared/assistant/inspector/InspectorProvider'
import { InspectorTogglePill } from '@shared/assistant/inspector/InspectorTogglePill'
import { SessionInspectorPane } from '@shared/assistant/inspector/SessionInspectorPane'
import {
  useSessionInspector
} from '@shared/assistant/inspector/inspectorContext'
import {
  buildContextUsageView,
  type ContextUsageView
} from '@shared/assistant/components/contextUsage.lib'
import { useActiveEmail } from '@shared/state/active-email'
import { useManagedBrowserUi } from '@shared/state/managed-browser-ui'

const navigateMock = vi.fn()
const libraryTextMock = vi.fn()

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock
}))

vi.mock('@shared/components/library/hooks', () => ({
  useLibraryApi: () => ({
    text: libraryTextMock
  })
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
  navigateMock.mockReset()
  libraryTextMock.mockReset()
  libraryTextMock.mockResolvedValue({ markdown: '# Live Server Text\n\nUpdated content' })
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
})

const POPULATED_SNAPSHOT: SessionWorkspaceSnapshot = {
  artifacts: [
    {
      id: 'library:77',
      kind: 'library',
      title: 'q4-brief.md',
      virtualPath: 'notes/q4-brief.md',
      fileId: 77,
      writeCount: 2,
      content: 'Fallback content',
      isMarkdown: true
    }
  ],
  sources: {
    explicit: [
      {
        key: 'email:42',
        kind: 'email',
        origin: 'explicit',
        title: 'Vendor Renewal Email',
        internalId: 42
      }
    ],
    consulted: [
      {
        key: 'kos:pricing-faq',
        kind: 'kos',
        origin: 'consulted',
        title: 'Pricing FAQ'
      }
    ]
  },
  links: [
    {
      url: 'https://docs.example.com/sla',
      title: 'Enterprise SLA',
      hostname: 'docs.example.com',
      source: 'source-part'
    }
  ],
  skills: [{ key: 'skill:sla-review', name: 'sla-review', kind: 'skill' }],
  connectorsUsed: [
    {
      connectorId: 'notion',
      displayName: 'Notion',
      callCount: 3,
      actions: ['search', 'fetch']
    }
  ],
  totalItems: 6
}

const SAMPLE_USAGE = buildContextUsageView(64_000, 200_000)

function SeedInspector({
  snapshot,
  contextUsage = null,
  sessionId = 10
}: {
  readonly snapshot: SessionWorkspaceSnapshot
  readonly contextUsage?: ContextUsageView | null
  readonly sessionId?: number | null
}): null {
  const inspector = useSessionInspector()
  const publishSnapshot = inspector?.publishSnapshot
  const publishContextUsage = inspector?.publishContextUsage
  const publishSessionId = inspector?.publishSessionId

  useEffect(() => {
    publishSnapshot?.(snapshot)
  }, [publishSnapshot, snapshot])

  useEffect(() => {
    publishContextUsage?.(contextUsage)
  }, [publishContextUsage, contextUsage])

  useEffect(() => {
    publishSessionId?.(sessionId)
  }, [publishSessionId, sessionId])

  return null
}

function renderHarness(
  snapshot: SessionWorkspaceSnapshot,
  usage: ContextUsageView | null = null,
  autoOpenWhenPopulated = false
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <InspectorProvider
        sessionKey="test:10"
        shortcutEnabled={true}
        autoOpenWhenPopulated={autoOpenWhenPopulated}
      >
        <SeedInspector snapshot={snapshot} contextUsage={usage} sessionId={10} />
        <InspectorTogglePill />
        <SessionInspectorPane presentation="push" />
      </InspectorProvider>
    </QueryClientProvider>
  )
}

describe('SessionInspectorPane & InspectorTogglePill', () => {
  test('hides toggle pill on empty session and does not auto-open on bare anchor-only snapshot', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <InspectorProvider sessionKey="test:10" shortcutEnabled={true} autoOpenWhenPopulated={true}>
          <SeedInspector
            snapshot={{
              artifacts: [],
              sources: {
                explicit: [
                  {
                    key: 'email:1',
                    kind: 'email',
                    origin: 'explicit',
                    title: 'Anchored Email',
                    internalId: 1
                  }
                ],
                consulted: []
              },
              links: [],
              skills: [],
              connectorsUsed: [],
              totalItems: 1
            }}
            sessionId={10}
          />
          <InspectorTogglePill />
          <SessionInspectorPane presentation="push" />
        </InspectorProvider>
      </QueryClientProvider>
    )

    expect(screen.queryByTestId('session-inspector-pane')).toBeNull()

    rerender(
      <QueryClientProvider client={qc}>
        <InspectorProvider sessionKey="test:10" shortcutEnabled={true} autoOpenWhenPopulated={true}>
          <SeedInspector snapshot={POPULATED_SNAPSHOT} sessionId={10} />
          <InspectorTogglePill />
          <SessionInspectorPane presentation="push" />
        </InspectorProvider>
      </QueryClientProvider>
    )

    expect(screen.getByTestId('session-inspector-pane')).toBeTruthy()
  })

  test('opens 280px floating overview, switches to 520px artifact preview, toggles icon-only connector mute, and supports Cmd+.', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: writeTextMock }
    })

    const denseSnapshot: SessionWorkspaceSnapshot = {
      ...POPULATED_SNAPSHOT,
      artifacts: [
        ...POPULATED_SNAPSHOT.artifacts,
        {
          id: 'html:1',
          kind: 'html',
          title: 'diagram.html',
          content: '<html><body><h1>Arch</h1></body></html>',
          isHtml: true
        },
        {
          id: 'file:2',
          kind: 'file',
          title: 'summary.txt',
          content: 'Summary body'
        }
      ],
      totalItems: 8
    }

    renderHarness(denseSnapshot, SAMPLE_USAGE)

    const pill = screen.getByTestId('inspector-toggle-pill')
    expect(pill.textContent).toContain('8')
    fireEvent.click(pill)

    const pane = screen.getByTestId('session-inspector-pane')
    expect(pane.className).toContain('w-[280px]')
    expect(screen.getByText('q4-brief.md')).toBeTruthy()
    expect(screen.getByText('diagram.html')).toBeTruthy()
    expect(screen.getByText('Vendor Renewal Email')).toBeTruthy()
    expect(screen.getByText('Pricing FAQ')).toBeTruthy()
    expect(screen.getByText('Enterprise SLA')).toBeTruthy()
    expect(screen.getByText('sla-review')).toBeTruthy()
    expect(screen.getByText('Notion')).toBeTruthy()
    expect(screen.getByText('64K / 200K')).toBeTruthy()

    // Filter narrows items (visible when totalItems >= 8)
    const filterInput = screen.getByPlaceholderText('Filter artifacts, sources, links…')
    fireEvent.change(filterInput, { target: { value: 'Notion' } })
    expect(screen.queryByText('q4-brief.md')).toBeNull()
    expect(screen.getByText('Notion')).toBeTruthy()
    fireEvent.change(filterInput, { target: { value: '' } })

    // Icon-only connector mute toggle flips aria-label cleanly
    const muteBtn = screen.getByRole('button', { name: 'Mute in session' })
    expect(muteBtn.textContent).toBe('')
    fireEvent.click(muteBtn)
    expect(screen.getByRole('button', { name: 'Unmute' })).toBeTruthy()

    // Click HTML Artifact -> widens to 520px and renders sandboxed iframe with Source toggle
    fireEvent.click(screen.getByText('diagram.html'))
    expect(pane.className).toContain('w-[520px]')
    const iframe = screen.getByTitle('diagram.html')
    expect(iframe.tagName).toBe('IFRAME')
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    expect(screen.getByText('<html><body><h1>Arch</h1></body></html>')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    // Click Library Artifact -> widens to 520px preview & fetches live library text
    fireEvent.click(screen.getByText('q4-brief.md'))
    expect(pane.className).toContain('w-[520px]')
    await waitFor(() => {
      expect(screen.getByText(/Live Server Text/)).toBeTruthy()
    })

    // Copy button copies preview content
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith('# Live Server Text\n\nUpdated content')
    })

    // Open original navigates to /library with file id
    fireEvent.click(screen.getByRole('button', { name: 'Open original' }))
    expect(navigateMock).toHaveBeenCalledWith({ to: '/library', search: { file: 77 } })

    // Back returns to 280px overview
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(pane.className).toContain('w-[280px]')

    // Clicking email source sets active email & navigates to /
    const setActiveSpy = vi.spyOn(useActiveEmail.getState(), 'setActive')
    fireEvent.click(screen.getByText('Vendor Renewal Email'))
    expect(setActiveSpy).toHaveBeenCalledWith(42, { navTarget: true })
    expect(navigateMock).toHaveBeenCalledWith({ to: '/' })
    setActiveSpy.mockRestore()

    // Clicking link hands off to built-in browser; trailing action opens system browser
    useManagedBrowserUi.getState().setPendingUrl(null)
    const winOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    fireEvent.click(screen.getByText('Enterprise SLA'))
    expect(useManagedBrowserUi.getState().pendingUrl).toBe('https://docs.example.com/sla')
    expect(winOpenSpy).not.toHaveBeenCalled()

    useManagedBrowserUi.getState().setPendingUrl(null)
    fireEvent.click(screen.getByLabelText('Open in system browser: Enterprise SLA'))
    expect(winOpenSpy).toHaveBeenCalledWith(
      'https://docs.example.com/sla',
      '_blank',
      'noopener,noreferrer'
    )
    expect(useManagedBrowserUi.getState().pendingUrl).toBeNull()
    winOpenSpy.mockRestore()

    // Cmd+. toggles pane closed then open
    fireEvent.keyDown(document, { key: '.', metaKey: true })
    expect(screen.queryByTestId('session-inspector-pane')).toBeNull()
    fireEvent.keyDown(document, { key: '.', metaKey: true })
    expect(screen.getByTestId('session-inspector-pane')).toBeTruthy()
  })
})
