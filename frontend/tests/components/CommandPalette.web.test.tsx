// @vitest-environment happy-dom
//
// G-A7 ① — web build gate for the AI search entry.
//
// On the remote web build, `runSearchAgent` always returns E_UNSUPPORTED (the
// LLM key lives on the desktop), so the palette must NOT surface the doomed
// "AI 理解…" entry row. The gate is a module-level `IS_WEB` constant derived
// from `import.meta.env.VITE_BUILD_TARGET` (the project-wide web/desktop
// signal, see factory.ts / StatusBar.tsx / EnvField.tsx). Because that constant
// is evaluated at module load, this lives in its own file so we can stub the
// env BEFORE importing the component (dynamic import after vi.stubEnv).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockSearch, mockListMailboxes, mockRunSearchAgent } = vi.hoisted(() => ({
  mockSearch: vi.fn(),
  mockListMailboxes: vi.fn(),
  mockRunSearchAgent: vi.fn()
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    email: {
      search: mockSearch,
      listMailboxes: mockListMailboxes,
      flag: vi.fn(),
      nlToDsl: vi.fn(),
      list: vi.fn(),
      listEnriched: vi.fn(),
      listByThread: vi.fn(),
      get: vi.fn(),
      body: vi.fn(),
      aiFields: vi.fn(),
      resync: vi.fn(),
      createDraft: vi.fn(),
      pin: vi.fn(),
      listPinnedIds: vi.fn()
    },
    llm: { run: vi.fn(), stats: vi.fn(), selftest: vi.fn() },
    attachment: { list: vi.fn(), localPath: vi.fn(), readDataUrl: vi.fn() },
    ai: { translate: vi.fn(), abortTranslate: vi.fn() },
    chat: { runSearchAgent: mockRunSearchAgent }
  })
}))

vi.mock('@shared/state/active-email', () => {
  const state = { activeInternalId: null, setActive: vi.fn() }
  function useActiveEmail<T = typeof state>(selector?: (s: typeof state) => T): T {
    return selector ? selector(state) : (state as unknown as T)
  }
  useActiveEmail.getState = () => state
  return { useActiveEmail }
})

vi.mock('@shared/state/mailbox', () => {
  const state = { active: '收件箱', setActive: vi.fn() }
  function useMailbox<T = typeof state>(selector?: (s: typeof state) => T): T {
    return selector ? selector(state) : (state as unknown as T)
  }
  useMailbox.getState = () => state
  return { useMailbox }
})

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@shared/state/toast', () => ({ toastSuccess: vi.fn(), toastError: vi.fn() }))

import i18n from '@shared/i18n'

beforeEach(async () => {
  vi.clearAllMocks()
  vi.useRealTimers()
  mockListMailboxes.mockResolvedValue([
    { mailbox: '收件箱', total: 100, unread: 5, flagged: 2, failed: 0 }
  ])
  mockSearch.mockResolvedValue({ items: [], total_indexed: 1247 })
  await i18n.changeLanguage('zh-CN')
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.resetModules()
})

// Stub the web build target, reset modules, then dynamically import BOTH the
// component and the palette store from the same (post-reset) module graph so
// setOpen() flips the very store instance the freshly-imported component reads.
async function renderWebPalette(): Promise<void> {
  vi.stubEnv('VITE_BUILD_TARGET', 'web')
  vi.resetModules()
  const { CommandPalette } = await import('@shared/components/command/CommandPalette')
  const { useCommandPalette } = await import('@shared/state/command-palette')
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={qc}>
      <CommandPalette />
    </QueryClientProvider>
  )
  useCommandPalette.getState().setOpen(true)
}

describe('CommandPalette — web build AI gate (G-A7 ①)', () => {
  test('web build does NOT render the AI entry row even with a non-empty query', async () => {
    await renderWebPalette()
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '新人培训' } })
    // Jump group + mailbox rows still appear; the AI entry must not.
    await waitFor(() => screen.getByText('收件箱'))
    expect(screen.queryByText(/AI 理解/)).toBeNull()
    // runSearchAgent is never reachable from the keyboard either.
    expect(mockRunSearchAgent).not.toHaveBeenCalled()
  })

  test('web build footer ⌘⏎ hint is not labelled "AI 搜索"', async () => {
    await renderWebPalette()
    await waitFor(() => screen.getByRole('dialog'))
    // Desktop labels ⌘⏎ as AI search; web keeps the new-window placeholder.
    expect(screen.queryByText('AI 搜索')).toBeNull()
  })

  test('web build ⌘Enter falls through to the highlighted row (Enter alias), never AI / no-op', async () => {
    const { useCommandPalette } = await (async () => {
      await renderWebPalette()
      return import('@shared/state/command-palette')
    })()
    const dialog = await waitFor(() => screen.getByRole('dialog'))
    // Default highlight = first jump row = the '收件箱' mailbox (web has no AI row).
    await waitFor(() => screen.getByText('收件箱'))
    fireEvent.keyDown(dialog, { key: 'Enter', metaKey: true })
    // Behaves like the baseline Enter alias: runs the highlighted row (closes the
    // palette), and never starts AI search on web.
    expect(mockRunSearchAgent).not.toHaveBeenCalled()
    expect(useCommandPalette.getState().open).toBe(false)
  })
})
