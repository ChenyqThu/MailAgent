// @vitest-environment happy-dom
//
// SkillsSection — task 07-22 per-skill clarification notes.
//
// Covers:
//   1. calendar skill row carries the calendarChatNote (对外 Skill 面 vs chat 日历工具 澄清).
//   2. notion_agent row shows notionAgentMasterOff note ONLY when the master flag
//      MAILAGENT_NOTION_AGENT_TOOL intent is off (skill toggle still operable).
//
// Pure UI test — better-sqlite3 / IPC free. useMailApi + env-flag intent are module-mocked.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import type { SkillSummary } from '../../src/shared/api/types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

// Env-flag intent (notion master switch) — controlled per test via a mutable holder.
// Partial-mock the shared helpers module so useEnvFlagIntent is deterministic while
// resolveApiBaseUrl / the flag fetchers keep their real implementations.
const { notionMaster } = vi.hoisted(() => ({ notionMaster: { value: true } }))
vi.mock('@shared/components/settings/custom-ai/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/components/settings/custom-ai/shared')>()),
  useEnvFlagIntent: () => notionMaster.value,
  fetchSkillCreatorEnabled: async () => true
}))

// notion_agent's expandable config panel always mounts inside CollapsibleRegion — stub it so the
// test doesn't need the notionAgent IPC surface.
vi.mock('@shared/components/settings/custom-ai/NotionAgentSkillConfig', () => ({
  NotionAgentSkillConfig: () => createElement('div', { 'data-testid': 'notion-cfg' })
}))

// No leftover localStorage overrides → migrateLocalSkillOverrides is a no-op.
vi.mock('@shared/lib/skill_overrides', () => ({
  readSkillOverrides: () => ({}),
  writeSkillOverrides: vi.fn()
}))
vi.mock('@shared/state/toast', () => ({ toastError: vi.fn() }))

const { listSkills, listSkillEntrypoints, listSkillTrust, grantSkillTrust, revokeSkillTrust } = vi.hoisted(() => ({
  listSkills: vi.fn<() => Promise<SkillSummary[]>>(),
  listSkillEntrypoints: vi.fn(),
  listSkillTrust: vi.fn(),
  grantSkillTrust: vi.fn(),
  revokeSkillTrust: vi.fn()
}))
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    chat: {
      listSkills,
      setSkillEnabled: vi.fn(),
      listSkillEntrypoints,
      listSkillTrust,
      grantSkillTrust,
      revokeSkillTrust
    }
  })
}))

import { SkillsSection } from '../../src/shared/components/settings/custom-ai/SkillsSection'

function skill(partial: Partial<SkillSummary> & { name: string }): SkillSummary {
  return {
    name: partial.name,
    title: partial.title ?? partial.name,
    description: partial.description ?? `${partial.name} desc`,
    defaultEnabled: partial.defaultEnabled ?? true,
    enabled: partial.enabled ?? true,
    overridden: partial.overridden ?? false,
    sourceType: partial.sourceType ?? 'builtin',
    available: partial.available ?? true,
    unavailableReason: partial.unavailableReason ?? null,
    toolCount: partial.toolCount ?? 1,
    scopes: partial.scopes ?? [],
    installDir: partial.installDir ?? null,
    trustState: partial.trustState ?? null,
    lastError: partial.lastError ?? null
  } as SkillSummary
}

function renderUi() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return {
    ...render(createElement(QueryClientProvider, { client: qc }, createElement(SkillsSection))),
    queryClient: qc
  }
}

beforeEach(() => {
  notionMaster.value = true
  listSkills.mockResolvedValue([
    skill({ name: 'email', title: 'Email' }),
    skill({ name: 'calendar', title: 'Calendar' }),
    skill({ name: 'skill_creator', title: 'Skill Creator', toolCount: 0 }),
    skill({ name: 'custom_agent', title: 'Custom Agent', toolCount: 0 }),
    skill({ name: 'notion_agent', title: 'Notion Agent', enabled: false, defaultEnabled: false })
  ])
  listSkillEntrypoints.mockResolvedValue([])
  listSkillTrust.mockResolvedValue({ skillName: '', currentPackageHash: null, trusts: [] })
  grantSkillTrust.mockResolvedValue({})
  revokeSkillTrust.mockResolvedValue({ id: 'trust-1', revoked: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SkillsSection — clarification notes', () => {
  test('calendar row carries the calendarChatNote', async () => {
    renderUi()
    await waitFor(() => expect(screen.getByText('Calendar')).toBeTruthy())
    // Exactly one calendar note (only the calendar skill row carries it).
    expect(screen.getAllByText('settings.skills.calendarChatNote')).toHaveLength(1)
  })

  test('notion_agent master OFF → shows notionAgentMasterOff note', async () => {
    notionMaster.value = false
    renderUi()
    await waitFor(() => expect(screen.getByText('Notion Agent')).toBeTruthy())
    expect(screen.getByText('settings.skills.notionAgentMasterOff')).toBeTruthy()
  })

  test('notion_agent master ON → no notionAgentMasterOff note', async () => {
    notionMaster.value = true
    renderUi()
    await waitFor(() => expect(screen.getByText('Notion Agent')).toBeTruthy())
    expect(screen.queryByText('settings.skills.notionAgentMasterOff')).toBeNull()
  })

  test('skill_creator and custom_agent notes deep-link to their builtin connector groups', async () => {
    renderUi()
    await waitFor(() => expect(screen.getByText('Skill Creator')).toBeTruthy())

    fireEvent.click(screen.getByText('settings.skills.skillCreatorChatNote'))
    fireEvent.click(screen.getByText('settings.skills.customAgentChatNote'))

    expect(navigate).toHaveBeenNthCalledWith(1, {
      to: '/connectors',
      search: { item: 'builtin:supply' }
    })
    expect(navigate).toHaveBeenNthCalledWith(2, {
      to: '/connectors',
      search: { item: 'builtin:agents' }
    })
  })

  test('user-created row grants trust for the server-listed entrypoint', async () => {
    listSkills.mockResolvedValue([
      skill({
        name: 'user-skill',
        title: 'User Skill',
        sourceType: 'user_created',
        trustState: 'stale',
        lastError: 'tampered:main.py'
      })
    ])
    listSkillEntrypoints.mockResolvedValue([
      { name: 'user-skill', dir: '/skills/user-skill', files: ['main.py'] }
    ])
    listSkillTrust.mockResolvedValue({
      skillName: 'user-skill',
      currentPackageHash: 'abcdef0123456789',
      trusts: []
    })
    renderUi()
    await waitFor(() => expect(screen.getByText('User Skill')).toBeTruthy())
    expect(screen.getByText('stale')).toBeTruthy()
    expect(screen.getByText('tampered:main.py')).toBeTruthy()
    fireEvent.click(screen.getByText('User Skill'))
    await waitFor(() => expect(screen.getByText('settings.skills.trustVersion')).toBeTruthy())
    const trustButton = screen.getByRole('button', { name: 'settings.skills.trustVersion' })
    await waitFor(() => expect(trustButton.hasAttribute('disabled')).toBe(false))
    await act(async () => {
      fireEvent.click(trustButton)
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(grantSkillTrust).toHaveBeenCalledWith(
        'user-skill',
        '/skills/user-skill/main.py',
        {
          argvPattern: [],
          cwdScope: ['/skills/user-skill'],
          readScopes: [],
          writeScopes: [],
          networkMode: 'off',
          secretNames: []
        }
      )
    )
  })

  test('revoking active trust refreshes both trust detail and resolved skill badge', async () => {
    listSkills.mockResolvedValue([
      skill({ name: 'user-skill', title: 'User Skill', sourceType: 'user_created', trustState: 'trusted' })
    ])
    listSkillEntrypoints.mockResolvedValue([
      { name: 'user-skill', dir: '/skills/user-skill', files: ['main.py'] }
    ])
    listSkillTrust.mockResolvedValue({
      currentPackageHash: 'abcdef0123456789',
      trusts: [{
        id: 'trust-1',
        skillName: 'user-skill',
        packageHash: 'abcdef0123456789',
        entrypoint: '/skills/user-skill/main.py',
        policy: {
          argvPattern: [], cwdScope: ['/skills/user-skill'], readScopes: [], writeScopes: [], networkMode: 'off', secretNames: []
        },
        trustedAt: 1,
        revokedAt: null,
        state: 'trusted'
      }]
    })
    const { queryClient } = renderUi()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    await waitFor(() => expect(screen.getByText('User Skill')).toBeTruthy())
    fireEvent.click(screen.getByText('User Skill'))
    await waitFor(() => expect(screen.getByText('settings.skills.revokeTrust')).toBeTruthy())
    fireEvent.click(screen.getByText('settings.skills.revokeTrust'))
    await waitFor(() => expect(revokeSkillTrust).toHaveBeenCalledWith('user-skill', 'trust-1'))
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['skill-trust', 'user-skill'] })
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['skills'] })
    })
  })
})
