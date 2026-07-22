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
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import type { SkillSummary } from '../../src/shared/api/types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

// Env-flag intent (notion master switch) — controlled per test via a mutable holder.
// Partial-mock the shared helpers module so useEnvFlagIntent is deterministic while
// resolveApiBaseUrl / the flag fetchers keep their real implementations.
const { notionMaster } = vi.hoisted(() => ({ notionMaster: { value: true } }))
vi.mock('@shared/components/settings/custom-ai/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/components/settings/custom-ai/shared')>()),
  useEnvFlagIntent: () => notionMaster.value
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

const { listSkills } = vi.hoisted(() => ({ listSkills: vi.fn<() => Promise<SkillSummary[]>>() }))
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ chat: { listSkills, setSkillEnabled: vi.fn() } })
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
    scopes: partial.scopes ?? []
  } as SkillSummary
}

function renderUi() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(createElement(QueryClientProvider, { client: qc }, createElement(SkillsSection)))
}

beforeEach(() => {
  notionMaster.value = true
  listSkills.mockResolvedValue([
    skill({ name: 'email', title: 'Email' }),
    skill({ name: 'calendar', title: 'Calendar' }),
    skill({ name: 'notion_agent', title: 'Notion Agent', enabled: false, defaultEnabled: false })
  ])
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
})
