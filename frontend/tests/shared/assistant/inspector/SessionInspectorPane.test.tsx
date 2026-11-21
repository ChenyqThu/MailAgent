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
const libraryPublishArtifactBundleMock = vi.fn()
const libraryIssueArtifactPreviewTokenMock = vi.fn()
const connectorListMock = vi.fn()
const connectorInvokeToolMock = vi.fn()

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock
}))

vi.mock('@shared/components/library/hooks', () => ({
  useLibraryApi: () => ({
    text: libraryTextMock,
    publishArtifactBundle: libraryPublishArtifactBundleMock,
    issueArtifactPreviewToken: libraryIssueArtifactPreviewTokenMock
  })
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    connector: {
      list: connectorListMock,
      invokeTool: connectorInvokeToolMock
    }
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
  libraryPublishArtifactBundleMock.mockReset()
  libraryIssueArtifactPreviewTokenMock.mockReset()
  connectorListMock.mockReset()
  connectorListMock.mockResolvedValue([])
  connectorInvokeToolMock.mockReset()
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electron?: unknown }).electron
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

    // Click HTML Artifact -> widens to 540px and renders sandboxed iframe with Source toggle
    fireEvent.click(screen.getByText('diagram.html'))
    expect(pane.className).toContain('w-[540px]')
    const iframe = screen.getByTitle('diagram.html')
    expect(iframe.tagName).toBe('IFRAME')
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    expect(screen.getByText('<html><body><h1>Arch</h1></body></html>')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    // Click Library Artifact -> widens to 540px preview & fetches live library text
    fireEvent.click(screen.getByText('q4-brief.md'))
    expect(pane.className).toContain('w-[540px]')
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

  test('renders persisted HTML via libpreview:// in Electron, supports versions, mobile viewport, and studio expand', () => {
    ;(window as unknown as { electron?: unknown }).electron = { ipcRenderer: {} }
    const studioSnapshot: SessionWorkspaceSnapshot = {
      ...POPULATED_SNAPSHOT,
      artifacts: [
        {
          id: 'artifact:q4-board',
          kind: 'html',
          title: 'Q4 Board',
          slug: 'q4-board',
          artifactType: 'dashboard',
          version: 2,
          fileId: 202,
          virtualPath: 'agent-docs/artifacts/q4-board/v2/index.html',
          content: '<!doctype html><html><body>v2</body></html>',
          isHtml: true,
          isMarkdown: false,
          versions: [
            {
              version: 1,
              fileId: 201,
              virtualPath: 'agent-docs/artifacts/q4-board/v1/index.html',
              content: '<!doctype html><html><body>v1</body></html>',
              changeNote: 'Initial draft'
            },
            {
              version: 2,
              fileId: 202,
              virtualPath: 'agent-docs/artifacts/q4-board/v2/index.html',
              content: '<!doctype html><html><body>v2</body></html>',
              changeNote: 'Added KPI row'
            }
          ]
        }
      ],
      totalItems: 1
    }

    renderHarness(studioSnapshot)
    fireEvent.click(screen.getByTestId('inspector-toggle-pill'))
    expect(screen.getByText('v2')).toBeTruthy()

    fireEvent.click(screen.getByText('Q4 Board'))
    const pane = screen.getByTestId('session-inspector-pane')
    expect(pane.className).toContain('w-[540px]')

    // Uses libpreview:// src (not srcDoc) when Electron + fileId + virtualPath are present
    const iframeV2 = screen.getByTitle('Q4 Board') as HTMLIFrameElement
    expect(iframeV2.getAttribute('src')).toBe(
      'libpreview://library/agent-docs/artifacts/q4-board/v2/index.html'
    )
    expect(iframeV2.hasAttribute('srcdoc')).toBe(false)

    // Switch back to v1
    fireEvent.click(screen.getByRole('button', { name: 'v1' }))
    const iframeV1 = screen.getByTitle('Q4 Board') as HTMLIFrameElement
    expect(iframeV1.getAttribute('src')).toBe(
      'libpreview://library/agent-docs/artifacts/q4-board/v1/index.html'
    )

    // Toggle mobile viewport
    fireEvent.click(screen.getByRole('button', { name: 'Mobile viewport' }))
    expect(screen.getByTitle('Q4 Board').className).toContain('w-[390px]')

    // Toggle expand studio width
    fireEvent.click(screen.getByRole('button', { name: 'Expand preview' }))
    expect(pane.className).toContain('w-[min(920px,64vw)]')
    fireEvent.click(screen.getByRole('button', { name: 'Compact preview' }))
    expect(pane.className).toContain('w-[540px]')
  })

  test('navigates to Artifact Server setup when disconnected and publishes inline HTML via MCP when no bundle dir exists', async () => {
    const htmlSnapshot: SessionWorkspaceSnapshot = {
      ...POPULATED_SNAPSHOT,
      artifacts: [
        {
          id: 'file-path:notes/q4-board.html',
          kind: 'html',
          title: 'q4-board.html',
          virtualPath: 'notes/q4-board.html',
          content: '<!doctype html><html><body>v1</body></html>',
          isHtml: true,
          isMarkdown: false
        }
      ],
      totalItems: 1
    }

    renderHarness(htmlSnapshot)
    fireEvent.click(screen.getByTestId('inspector-toggle-pill'))
    fireEvent.click(screen.getByText('q4-board.html'))

    // Disconnected -> Cloud shortcut jumps to self-hosted preset in Settings
    const setupBtn = await screen.findByRole('button', {
      name: 'Configure Artifact Server in Connectors to share'
    })
    fireEvent.click(setupBtn)
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/settings',
      search: { tab: 'connectors', item: 'preset:artifact_server' }
    })

    cleanup()
    connectorListMock.mockResolvedValue([
      { connector_id: 'artifact_server', enabled: true, status: 'connected' }
    ])
    connectorInvokeToolMock.mockResolvedValue({
      connector_id: 'artifact_server',
      tool_name: 'artifact_publish',
      content: JSON.stringify({
        ok: true,
        slug: 'q4-boardhtml',
        version: 1,
        review_url: 'https://canvas.chenge.ink/a/q4-boardhtml/v/1?t=tok',
        share_url: 'https://canvas.chenge.ink/s/tok?v=1'
      }),
      images: [],
      is_error: false,
      truncated: false
    })

    renderHarness(htmlSnapshot)
    fireEvent.click(screen.getByTestId('inspector-toggle-pill'))
    fireEvent.click(screen.getByText('q4-board.html'))

    const publishBtn = await screen.findByRole('button', { name: 'Publish' })
    fireEvent.click(publishBtn)

    await waitFor(() =>
      expect(connectorInvokeToolMock).toHaveBeenCalledWith(
        'artifact_server',
        'artifact_publish',
        {
          slug: 'q4-boardhtml',
          title: 'q4-board.html',
          artifact_type: 'app',
          html: '<!doctype html><html><body>v1</body></html>'
        }
      )
    )

    expect(await screen.findByRole('button', { name: 'Open review' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy share link' })).toBeTruthy()
  })

  test('prefers libraryApi.publishArtifactBundle for versioned artifacts and opens browser preview token via Globe button', async () => {
    connectorListMock.mockResolvedValue([
      { connector_id: 'artifact_server', enabled: true, status: 'connected' }
    ])
    libraryPublishArtifactBundleMock.mockResolvedValue({
      ok: true,
      slug: 'omada-ap-board',
      title: 'Omada AP Monitor',
      version: 1,
      local_version: 1,
      file_count: 1,
      size_bytes: 980400,
      review_url: 'https://canvas.chenge.ink/a/omada-ap-board/v/1',
      share_url: 'https://canvas.chenge.ink/s/omada-tok?v=1'
    })
    libraryIssueArtifactPreviewTokenMock.mockResolvedValue({
      ok: true,
      token: 'preview-tok-1',
      slug: 'omada-ap-board',
      version: 1,
      entry_path: 'index.html',
      preview_url: 'http://127.0.0.1:8200/api/library/artifacts/preview/preview-tok-1/index.html',
      ttl_seconds: 86400
    })
    const winOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null)

    const bundleSnapshot: SessionWorkspaceSnapshot = {
      ...POPULATED_SNAPSHOT,
      artifacts: [
        {
          id: 'artifact:omada-ap-board',
          kind: 'html',
          title: 'Omada AP Monitor',
          slug: 'omada-ap-board',
          artifactType: 'app',
          version: 1,
          fileId: 301,
          fileCount: 1,
          virtualPath: 'agent-docs/artifacts/omada-ap-board/v1/index.html',
          isHtml: true,
          isMarkdown: false,
          versions: [
            {
              version: 1,
              fileId: 301,
              fileCount: 1,
              virtualPath: 'agent-docs/artifacts/omada-ap-board/v1/index.html',
              changeNote: 'Initial AP health console'
            }
          ]
        }
      ],
      totalItems: 1
    }

    renderHarness(bundleSnapshot)
    fireEvent.click(screen.getByTestId('inspector-toggle-pill'))
    fireEvent.click(screen.getByText('Omada AP Monitor'))

    const browserBtn = await screen.findByRole('button', { name: 'Open in system browser' })
    fireEvent.click(browserBtn)
    await waitFor(() =>
      expect(libraryIssueArtifactPreviewTokenMock).toHaveBeenCalledWith({
        slug: 'omada-ap-board',
        version: 1
      })
    )
    expect(winOpenSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:8200/api/library/artifacts/preview/preview-tok-1/index.html',
      '_blank',
      'noopener'
    )
    winOpenSpy.mockRestore()

    const publishBtn = await screen.findByRole('button', { name: 'Publish' })
    fireEvent.click(publishBtn)

    await waitFor(() =>
      expect(libraryPublishArtifactBundleMock).toHaveBeenCalledWith({
        slug: 'omada-ap-board',
        version: 1,
        title: 'Omada AP Monitor',
        artifact_type: 'app',
        change_note: 'Initial AP health console'
      })
    )
    expect(connectorInvokeToolMock).not.toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: 'Open review' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy share link' })).toBeTruthy()
  })
})
