// @vitest-environment happy-dom
//
// SystemCapabilitiesSection — R4 (task 07-05) 内置系统能力只读区 unit tests.
//
// Covers:
//   1. All openness flags off → section STILL renders (764f7aa8: the web capability is
//      an always-rendered writable toggle so users can turn it on) — no session/config
//      locked cards, moreNote shown.
//   2. Vacuum triad on (session/config/web) → 3 locked capability cards; each has a
//      DISABLED + checked switch with NO onCheckedChange (not interactive); moreNote
//      hidden when all three are on.
//   3. Partial (only session on) → session locked card + always-rendered web row +
//      moreNote shown.
//   4. Cross-ref rows (exec / skill-packs / custom-agents) render action buttons;
//      custom-agents → navigate('/agents'); exec → scrollIntoView on the anchor.
//   5. Locked switch is not interactive (disabled) — clicking triggers no navigation.
//
// Pure UI test — no better-sqlite3, no Electron IPC → plain vitest with happy-dom.
// Openness flag hooks are module-mocked; skillInstallEnabled goes through the real
// useQuery + a globally-stubbed fetch (mirrors the component's own path).

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import type { ChatOpennessFlags } from '../../src/shared/api/types'

// ---------------------------------------------------------------------------
// Mocks (declared before importing the component)
// ---------------------------------------------------------------------------

// i18n — identity translation so assertions use the key string
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

// TanStack Router — capture navigate() calls (cross-route jump to /agents)
const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate
}))

// Openness flag hooks — module-mocked so each test controls flag state directly
const { mockUseOpennessFlags, mockUseCustomAgentsEnabled } = vi.hoisted(() => ({
  mockUseOpennessFlags: vi.fn<() => ChatOpennessFlags>(),
  mockUseCustomAgentsEnabled: vi.fn<() => boolean>()
}))
vi.mock('@shared/components/agents/hooks', () => ({
  useOpennessFlags: () => mockUseOpennessFlags(),
  useCustomAgentsEnabled: () => mockUseCustomAgentsEnabled()
}))

// useMailApi is imported by other CustomAiSection subsections but not by
// SystemCapabilitiesSection; stub it so the module import doesn't fault.
vi.mock('@shared/hooks/useMailApi', () => ({ useMailApi: () => ({ chat: {} }) }))

// Stub global fetch — drives fetchSkillInstallEnabled (/chat/config.skillInstallEnabled)
const mockFetch = vi.fn<typeof fetch>()
vi.stubGlobal('fetch', mockFetch)

// ---------------------------------------------------------------------------
// Import component AFTER mocks are registered
// ---------------------------------------------------------------------------
import { SystemCapabilitiesSection } from '../../src/shared/components/settings/CustomAiSection'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQcWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}

function renderUi() {
  return render(createElement(SystemCapabilitiesSection), { wrapper: makeQcWrapper() })
}

/** Configure the mocked hooks + fetch for a given flag state. */
function setFlags(opts: {
  flags?: ChatOpennessFlags
  customAgents?: boolean
  skillInstall?: boolean
}): void {
  mockUseOpennessFlags.mockReturnValue(opts.flags ?? {})
  mockUseCustomAgentsEnabled.mockReturnValue(opts.customAgents ?? false)
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { skillInstallEnabled: opts.skillInstall ?? false } })
  } as unknown as Response)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SystemCapabilitiesSection — web always-on exception', () => {
  test('all openness flags off → section still renders web toggle, no locked cards, moreNote shown', async () => {
    setFlags({ flags: {}, customAgents: false, skillInstall: false })
    renderUi()

    // Give the skillInstall query a tick to settle (still false → no skill-packs row).
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    // 764f7aa8: 联网卡是恒渲染的可写例外（用户要能从这里开启联网）→ section 不再 return null。
    expect(screen.getByText('settings.systemCapabilities.title')).toBeTruthy()
    expect(screen.getByText('settings.systemCapabilities.web.title')).toBeTruthy()
    // session/config 只读锁定卡仅各自 flag===true 才渲染 → 全 off 时缺席。
    expect(screen.queryByText('settings.systemCapabilities.session.title')).toBeNull()
    expect(screen.queryByText('settings.systemCapabilities.config.title')).toBeNull()
    // 锁定族未全开 → 尾部 moreNote 在场。
    expect(screen.getByText('settings.systemCapabilities.moreNote')).toBeTruthy()
  })
})

describe('SystemCapabilitiesSection — vacuum triad', () => {
  test('session/config/web on → 3 locked cards, disabled+checked switches, no moreNote', async () => {
    setFlags({
      flags: { sessionToolsEnabled: true, configToolsEnabled: true, webToolsEnabled: true },
      customAgents: false,
      skillInstall: false
    })
    renderUi()

    await waitFor(() =>
      expect(screen.getByText('settings.systemCapabilities.session.title')).toBeTruthy()
    )
    expect(screen.getByText('settings.systemCapabilities.config.title')).toBeTruthy()
    expect(screen.getByText('settings.systemCapabilities.web.title')).toBeTruthy()

    // Three locked switches — each disabled + checked, NONE interactive.
    const switches = screen.getAllByRole('switch')
    expect(switches).toHaveLength(3)
    for (const sw of switches) {
      expect((sw as HTMLButtonElement).disabled).toBe(true)
      expect(sw.getAttribute('data-state')).toBe('checked')
    }

    // Locked pill present (3×) and moreNote absent (all three vacuum flags on).
    expect(screen.getAllByText('settings.systemCapabilities.lockedBadge').length).toBeGreaterThan(0)
    expect(screen.queryByText('settings.systemCapabilities.moreNote')).toBeNull()
  })

  test('clicking a locked switch does not navigate or throw (not interactive)', async () => {
    setFlags({
      flags: { sessionToolsEnabled: true },
      customAgents: false,
      skillInstall: false
    })
    renderUi()

    await waitFor(() =>
      expect(screen.getByText('settings.systemCapabilities.session.title')).toBeTruthy()
    )
    // 现在 section 恒含联网真开关 → getByRole('switch') 会撞多个。收窄到锁定卡的 switch
    // （LockedCapabilityControl 的 aria-label = lockedBadge）。
    const sw = screen.getByLabelText('settings.systemCapabilities.lockedBadge')
    fireEvent.click(sw)
    // Disabled switch: no side effects (no navigate, still checked).
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(sw.getAttribute('data-state')).toBe('checked')
  })

  test('session locked card + always-rendered web row + moreNote (config off)', async () => {
    setFlags({
      flags: { sessionToolsEnabled: true, configToolsEnabled: false, webToolsEnabled: false },
      customAgents: false,
      skillInstall: false
    })
    renderUi()

    await waitFor(() =>
      expect(screen.getByText('settings.systemCapabilities.session.title')).toBeTruthy()
    )
    expect(screen.queryByText('settings.systemCapabilities.config.title')).toBeNull()
    // 联网卡恒渲染 → 即便 webToolsEnabled flag 为 false 也在场（它读 .env 意图值非 flag）。
    expect(screen.getByText('settings.systemCapabilities.web.title')).toBeTruthy()
    expect(screen.getByText('settings.systemCapabilities.moreNote')).toBeTruthy()
  })
})

describe('SystemCapabilitiesSection — cross-reference rows', () => {
  test('exec / skill-packs / custom-agents rows render by flag', async () => {
    setFlags({
      flags: { execToolsEnabled: true },
      customAgents: true,
      skillInstall: true
    })
    renderUi()

    // skillPacks comes from the async /chat/config fetch — wait on it (the slowest);
    // exec + custom-agents are synchronous mocks and are present by then.
    await waitFor(() =>
      expect(
        screen.getByText('settings.systemCapabilities.crossRef.skillPacks.action')
      ).toBeTruthy()
    )
    expect(screen.getByText('settings.systemCapabilities.crossRef.exec.action')).toBeTruthy()
    expect(
      screen.getByText('settings.systemCapabilities.crossRef.customAgents.action')
    ).toBeTruthy()
  })

  test('custom-agents cross-ref → navigate to /agents', async () => {
    setFlags({ flags: {}, customAgents: true, skillInstall: false })
    renderUi()

    await waitFor(() =>
      expect(
        screen.getByText('settings.systemCapabilities.crossRef.customAgents.action')
      ).toBeTruthy()
    )
    fireEvent.click(screen.getByText('settings.systemCapabilities.crossRef.customAgents.action'))
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/agents', search: { tab: 'agents' } })
  })

  test('exec cross-ref → scrollIntoView on the anchor element', async () => {
    setFlags({ flags: { execToolsEnabled: true }, customAgents: false, skillInstall: false })

    // The scroll anchor lives in CustomAiSection; here we plant it manually.
    const scrollSpy = vi.fn()
    const anchor = document.createElement('div')
    anchor.id = 'settings-exec-policy'
    anchor.scrollIntoView = scrollSpy
    document.body.appendChild(anchor)

    renderUi()

    await waitFor(() =>
      expect(screen.getByText('settings.systemCapabilities.crossRef.exec.action')).toBeTruthy()
    )
    fireEvent.click(screen.getByText('settings.systemCapabilities.crossRef.exec.action'))
    expect(scrollSpy).toHaveBeenCalledTimes(1)

    document.body.removeChild(anchor)
  })
})
