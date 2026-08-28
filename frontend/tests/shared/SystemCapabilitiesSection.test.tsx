// @vitest-environment happy-dom
//
// SystemCapabilitiesSection — R4 (task 07-05) 内置系统能力只读区 · task 07-22 能力可见性全景.
//
// Covers (07-22 恒渲染 + 全景):
//   1. 恒可用核心族（核心邮件操作 / KOS 查询）恒渲染为锁定态（checked + disabled switch）。
//   2. env-flag 锁定族恒渲染：flag on → 锁定态；flag=false → 禁用态（未启用 pill + 未选 disabled
//      switch）。session/config 经 mocked openness flags，calendar/self-mount 经 mocked env store。
//   3. 交叉引用行（exec / skillPacks / customAgents）恒渲染：on → 可点跳转；off → 置灰 + 未启用 pill。
//   4. 联网真开关恒渲染（764f7aa8）。
//   5. 锁定 switch 不可交互（disabled）—— 点击无副作用。
//
// Pure UI test — no better-sqlite3, no Electron IPC → plain vitest with happy-dom.
// Openness flag hooks + env store are module-mocked; skillInstallEnabled goes through the real
// useQuery + a globally-stubbed fetch (mirrors the component's own path).

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

// env store — module-mocked so calendar / self-mount env-flag intent + WebCapabilityRow read a
// controlled snapshot. `useEnvStore((s) => s.state)` → selector(mockState). applyEnvPatch is a stub
// (web toggle is not exercised here; the Tavily EnvField only renders when web is on).
const { envValues } = vi.hoisted(() => ({ envValues: {} as Record<string, string> }))
vi.mock('@shared/state/env', () => ({
  // The store selector reads `s.state`; mirror that shape (state → { status, snapshot }).
  useEnvStore: (selector: (s: unknown) => unknown) =>
    selector({ state: { status: 'ready', snapshot: { values: envValues, secretKeys: [] } } }),
  applyEnvPatch: vi.fn(async () => ({ ok: true, changedKeys: [] }))
}))
vi.mock('@shared/state/restart', () => ({
  useRestartStore: (selector: (s: unknown) => unknown) => selector({ markRestartRequired: vi.fn() })
}))
vi.mock('@shared/state/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }))
// EnvField pulls in IPC-heavy plumbing; stub to a marker (only renders when web is on, which these
// tests keep off via envValues).
vi.mock('@shared/components/settings/parts/EnvField', () => ({
  EnvField: () => createElement('div', { 'data-testid': 'env-field' })
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

/** Configure the mocked hooks + fetch + env snapshot for a given flag state. */
function setFlags(opts: {
  flags?: ChatOpennessFlags
  customAgents?: boolean
  skillInstall?: boolean
  env?: Record<string, string>
}): void {
  mockUseOpennessFlags.mockReturnValue(opts.flags ?? {})
  mockUseCustomAgentsEnabled.mockReturnValue(opts.customAgents ?? false)
  // Force web OFF so the Tavily EnvField block stays out of these assertions.
  for (const k of Object.keys(envValues)) delete envValues[k]
  Object.assign(envValues, { MAILAGENT_OPENNESS_WEB_TOOLS: 'false' }, opts.env ?? {})
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { skillInstallEnabled: opts.skillInstall ?? false } })
  } as unknown as Response)
}

/** The <Row> element whose label contains `title` (walk up from the title text). */
function rowFor(title: string): HTMLElement {
  let el: HTMLElement | null = screen.getByText(title)
  while (el && !(el.className || '').includes('flex items-center gap-3')) {
    el = el.parentElement
  }
  if (!el) throw new Error(`row not found for ${title}`)
  return el
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SystemCapabilitiesSection — always-rendered core families', () => {
  test('core email + KOS render as locked (checked + disabled) regardless of flags', async () => {
    setFlags({ flags: {}, customAgents: false, skillInstall: false })
    renderUi()

    await waitFor(() =>
      expect(screen.getByText('settings.systemCapabilities.coreEmail.title')).toBeTruthy()
    )
    expect(screen.getByText('settings.systemCapabilities.kos.title')).toBeTruthy()

    // Each core row's switch is checked + disabled (locked, never interactive).
    for (const title of [
      'settings.systemCapabilities.coreEmail.title',
      'settings.systemCapabilities.kos.title'
    ]) {
      const sw = within(rowFor(title)).getByRole('switch') as HTMLButtonElement
      expect(sw.disabled).toBe(true)
      expect(sw.getAttribute('data-state')).toBe('checked')
    }
  })
})

describe('SystemCapabilitiesSection — env-flag families on/off', () => {
  test('session/config/calendar/self-mount all render; on → locked, off → disabled state', async () => {
    // session on (true), config off (false); calendar off via env, self-mount on via env default.
    setFlags({
      flags: { sessionToolsEnabled: true, configToolsEnabled: false },
      env: { MAILAGENT_CALENDAR_AGENT_TOOLS: 'false' }
      // MAILAGENT_SKILL_SELF_MOUNT unset → default ON
    })
    renderUi()

    await waitFor(() =>
      expect(screen.getByText('settings.systemCapabilities.session.title')).toBeTruthy()
    )
    // All four families ALWAYS render (07-22: off = disabled state, not hidden).
    expect(screen.getByText('settings.systemCapabilities.config.title')).toBeTruthy()
    expect(screen.getByText('settings.systemCapabilities.calendar.title')).toBeTruthy()
    expect(screen.getByText('settings.systemCapabilities.selfMount.title')).toBeTruthy()

    // session ON → locked (checked); config OFF → disabled (unchecked); calendar OFF → unchecked;
    // self-mount ON (env default) → checked. All switches disabled (never interactive here).
    const state = (title: string): string | null =>
      (within(rowFor(title)).getByRole('switch') as HTMLButtonElement).getAttribute('data-state')
    expect(state('settings.systemCapabilities.session.title')).toBe('checked')
    expect(state('settings.systemCapabilities.config.title')).toBe('unchecked')
    expect(state('settings.systemCapabilities.calendar.title')).toBe('unchecked')
    expect(state('settings.systemCapabilities.selfMount.title')).toBe('checked')

    // The two OFF rows carry the 未启用 (disabledBadge) pill; the disabled tip is present.
    expect(
      within(rowFor('settings.systemCapabilities.config.title')).getByText(
        'settings.systemCapabilities.disabledBadge'
      )
    ).toBeTruthy()
    expect(
      within(rowFor('settings.systemCapabilities.calendar.title')).getByText(
        'settings.systemCapabilities.disabledBadge'
      )
    ).toBeTruthy()
  })

  test('undefined openness flag (unreachable/old backend) → treated as ON (locked)', async () => {
    setFlags({ flags: {} }) // session/config undefined
    renderUi()

    await waitFor(() =>
      expect(screen.getByText('settings.systemCapabilities.session.title')).toBeTruthy()
    )
    const sw = within(rowFor('settings.systemCapabilities.session.title')).getByRole(
      'switch'
    ) as HTMLButtonElement
    expect(sw.getAttribute('data-state')).toBe('checked') // !== false → on
  })

  test('clicking a locked switch does not navigate or throw (not interactive)', async () => {
    setFlags({ flags: { sessionToolsEnabled: true } })
    renderUi()

    await waitFor(() =>
      expect(screen.getByText('settings.systemCapabilities.session.title')).toBeTruthy()
    )
    const sw = within(rowFor('settings.systemCapabilities.session.title')).getByRole('switch')
    fireEvent.click(sw)
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(sw.getAttribute('data-state')).toBe('checked')
  })
})

describe('SystemCapabilitiesSection — web always-on toggle', () => {
  test('web row renders even when its flag intent is off', async () => {
    setFlags({ flags: {}, env: { MAILAGENT_OPENNESS_WEB_TOOLS: 'false' } })
    renderUi()

    await waitFor(() =>
      expect(screen.getByText('settings.systemCapabilities.web.title')).toBeTruthy()
    )
    // web switch is a REAL toggle (not disabled here since env store is ready + not web build).
    const sw = within(rowFor('settings.systemCapabilities.web.title')).getByRole(
      'switch'
    ) as HTMLButtonElement
    expect(sw.getAttribute('data-state')).toBe('unchecked')
  })
})

describe('SystemCapabilitiesSection — cross-reference rows always render', () => {
  test('exec / skill-packs / custom-agents rows render action buttons when enabled', async () => {
    setFlags({ flags: { execToolsEnabled: true }, customAgents: true, skillInstall: true })
    renderUi()

    await waitFor(() =>
      expect(
        screen.getByText('settings.systemCapabilities.crossRef.skillPacks.action')
      ).toBeTruthy()
    )
    for (const key of ['exec', 'skillPacks', 'customAgents']) {
      const btn = screen.getByText(
        `settings.systemCapabilities.crossRef.${key}.action`
      ) as HTMLElement
      // enabled → button not disabled
      const button = btn.closest('button') as HTMLButtonElement
      expect(button.disabled).toBe(false)
    }
  })

  test('cross-ref rows off → still render, button disabled + 未启用 pill', async () => {
    setFlags({
      flags: { execToolsEnabled: false },
      customAgents: false,
      skillInstall: false
    })
    renderUi()

    // custom-agents row is present even with customAgents=false (07-22 恒渲染).
    await waitFor(() =>
      expect(
        screen.getByText('settings.systemCapabilities.crossRef.customAgents.title')
      ).toBeTruthy()
    )
    const execBtn = screen
      .getByText('settings.systemCapabilities.crossRef.exec.action')
      .closest('button') as HTMLButtonElement
    expect(execBtn.disabled).toBe(true)
    // 未启用 pill on the exec row.
    expect(
      within(rowFor('settings.systemCapabilities.crossRef.exec.title')).getByText(
        'settings.systemCapabilities.disabledBadge'
      )
    ).toBeTruthy()
  })

  test('custom-agents cross-ref (enabled) → navigate to /agents', async () => {
    setFlags({ flags: {}, customAgents: true, skillInstall: false })
    renderUi()

    await waitFor(() =>
      expect(
        screen.getByText('settings.systemCapabilities.crossRef.customAgents.action')
      ).toBeTruthy()
    )
    fireEvent.click(screen.getByText('settings.systemCapabilities.crossRef.customAgents.action'))
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/agents' })
  })

  test('exec cross-ref (enabled) → scrollIntoView on the anchor element', async () => {
    setFlags({ flags: { execToolsEnabled: true }, customAgents: false, skillInstall: false })

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
