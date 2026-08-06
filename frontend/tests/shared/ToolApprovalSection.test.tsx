// @vitest-environment happy-dom
//
// ToolApprovalSection（08-05 WP-11）— Settings 工具审批档 unit tests.
//
// Covers:
//   1. loads GET /tool-prefs and renders every tool row grouped, with the seg tier control
//      (configurable rows enabled, fixed rows disabled).
//   2. picking a tier calls setToolPref and re-renders from the RETURNED payload.
//   3. dangerAuto → auto shows the one-time red confirm (no API call until confirmed).
//   4. the acceptEdits preset + Reset buttons hit their endpoints.
//   5. the send whitelist editor saves the parsed recipient list.
// (The group bulk menu rides a Radix Popover — portal interaction is covered by the
// ConnectorsSection precedent; the bulk ENDPOINT semantics are pinned server-side in
// tests/api/test_agent_tool_prefs.py::test_bulk_by_group_skips_fixed.)
//
// Pure UI tests — no better-sqlite3, no Electron IPC → plain vitest with happy-dom.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import type { ToolApprovalPrefsPayload } from '../../src/shared/api/types'

const {
  stableMailApi,
  mockGetToolPrefs,
  mockSetToolPref,
  mockBulkSetToolPrefs,
  mockApplyPreset,
  mockResetToolPrefs,
  mockSetSendWhitelist
} = vi.hoisted(() => {
  const mockGetToolPrefs = vi.fn()
  const mockSetToolPref = vi.fn()
  const mockBulkSetToolPrefs = vi.fn()
  const mockApplyPreset = vi.fn()
  const mockResetToolPrefs = vi.fn()
  const mockSetSendWhitelist = vi.fn()
  const stableMailApi = {
    chat: {
      getToolPrefs: mockGetToolPrefs,
      setToolPref: mockSetToolPref,
      bulkSetToolPrefs: mockBulkSetToolPrefs,
      applyToolPrefsPreset: mockApplyPreset,
      resetToolPrefs: mockResetToolPrefs,
      setSendWhitelist: mockSetSendWhitelist
    }
  }
  return {
    stableMailApi,
    mockGetToolPrefs,
    mockSetToolPref,
    mockBulkSetToolPrefs,
    mockApplyPreset,
    mockResetToolPrefs,
    mockSetSendWhitelist
  }
})

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => stableMailApi
}))

const mockToastError = vi.fn()
const mockToastSuccess = vi.fn()
vi.mock('@shared/state/toast', () => ({
  toastError: (...args: unknown[]) => mockToastError(...args),
  toastSuccess: (...args: unknown[]) => mockToastSuccess(...args)
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && 'tool' in opts ? `${key}:${String(opts.tool)}` : key
  })
}))

import { ToolApprovalSection } from '../../src/shared/components/settings/custom-ai/ToolApprovalSection'

function payload(overrides?: Partial<ToolApprovalPrefsPayload>): ToolApprovalPrefsPayload {
  return {
    tools: [
      {
        toolName: 'email_draft_reply',
        group: 'draft',
        defaultTier: 'auto',
        tier: null,
        effectiveTier: 'auto',
        configurable: true,
        dangerAuto: false
      },
      {
        toolName: 'calendar_event_delete',
        group: 'calendar',
        defaultTier: 'ask',
        tier: null,
        effectiveTier: 'ask',
        configurable: true,
        dangerAuto: true
      },
      {
        toolName: 'email_prepare_send',
        group: 'outbound',
        defaultTier: 'ask',
        tier: null,
        effectiveTier: 'ask',
        configurable: false,
        dangerAuto: false
      }
    ],
    sendWhitelist: [],
    acceptEditsPreset: ['email_draft_reply'],
    ...overrides
  }
}

beforeEach(() => {
  mockGetToolPrefs.mockResolvedValue(payload())
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function renderSection(): Promise<void> {
  render(createElement(ToolApprovalSection))
  await waitFor(() => expect(screen.getByText('email_draft_reply')).toBeTruthy())
}

describe('ToolApprovalSection', () => {
  test('renders grouped tool rows; fixed rows are disabled, configurable rows enabled', async () => {
    await renderSection()
    expect(screen.getByText('settings.ai.toolPrefs.group.draft')).toBeTruthy()
    expect(screen.getByText('settings.ai.toolPrefs.group.outbound')).toBeTruthy()
    // fixed (send) row: the seg buttons are disabled + the fixedAsk pill shows
    expect(screen.getByText('settings.ai.toolPrefs.fixedAsk')).toBeTruthy()
    const sendSeg = screen.getByRole('group', {
      name: 'settings.ai.toolPrefs.tier.label · email_prepare_send'
    })
    for (const btn of Array.from(sendSeg.querySelectorAll('button'))) {
      expect((btn as HTMLButtonElement).disabled).toBe(true)
    }
    const draftSeg = screen.getByRole('group', {
      name: 'settings.ai.toolPrefs.tier.label · email_draft_reply'
    })
    for (const btn of Array.from(draftSeg.querySelectorAll('button'))) {
      expect((btn as HTMLButtonElement).disabled).toBe(false)
    }
  })

  test('picking a tier calls setToolPref and re-renders from the returned payload', async () => {
    const updated = payload()
    updated.tools[0] = { ...updated.tools[0], tier: 'ask', effectiveTier: 'ask' }
    mockSetToolPref.mockResolvedValue(updated)
    await renderSection()
    const draftSeg = screen.getByRole('group', {
      name: 'settings.ai.toolPrefs.tier.label · email_draft_reply'
    })
    const askBtn = Array.from(draftSeg.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'settings.ai.toolPrefs.tier.ask'
    ) as HTMLButtonElement
    fireEvent.click(askBtn)
    await waitFor(() => expect(mockSetToolPref).toHaveBeenCalledWith('email_draft_reply', 'ask'))
    // override present → the row shows the clear-override affordance
    await waitFor(() =>
      expect(screen.getByText('settings.ai.toolPrefs.clearOverride')).toBeTruthy()
    )
  })

  test('dangerAuto → auto shows the one-time red confirm; API only fires after confirming', async () => {
    mockSetToolPref.mockResolvedValue(payload())
    await renderSection()
    const calSeg = screen.getByRole('group', {
      name: 'settings.ai.toolPrefs.tier.label · calendar_event_delete'
    })
    const autoBtn = Array.from(calSeg.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'settings.ai.toolPrefs.tier.auto'
    ) as HTMLButtonElement
    fireEvent.click(autoBtn)
    expect(mockSetToolPref).not.toHaveBeenCalled()
    expect(
      screen.getByText('settings.ai.toolPrefs.dangerConfirmTitle:calendar_event_delete')
    ).toBeTruthy()
    fireEvent.click(screen.getByText('settings.ai.toolPrefs.confirm'))
    await waitFor(() =>
      expect(mockSetToolPref).toHaveBeenCalledWith('calendar_event_delete', 'auto')
    )
  })

  test('check 08-05 — group bulk AUTO on a group holding a dangerAuto row routes through the red confirm', async () => {
    // Regression pin: without this, 「outbound/calendar 组批量 auto」 would silently set the
    // danger tool to auto (the bulk endpoint does not re-check), bypassing the one-time confirm.
    mockBulkSetToolPrefs.mockResolvedValue(payload())
    await renderSection()
    const bulkTrigger = screen.getByLabelText(
      'settings.ai.toolPrefs.bulk.label · settings.ai.toolPrefs.group.calendar'
    )
    fireEvent.click(bulkTrigger)
    const autoItem = await screen.findByText('settings.ai.toolPrefs.bulk.auto')
    fireEvent.click(autoItem)
    // no API call yet — the red confirm appears, naming the danger tool
    expect(mockBulkSetToolPrefs).not.toHaveBeenCalled()
    expect(
      screen.getByText('settings.ai.toolPrefs.dangerConfirmTitle:calendar_event_delete')
    ).toBeTruthy()
    fireEvent.click(screen.getByText('settings.ai.toolPrefs.confirm'))
    await waitFor(() =>
      expect(mockBulkSetToolPrefs).toHaveBeenCalledWith({ tier: 'auto', group: 'calendar' })
    )
    // and a bulk ASK on the same group never confirms (danger only guards the auto direction)
    mockBulkSetToolPrefs.mockClear()
    fireEvent.click(bulkTrigger)
    const askItem = await screen.findByText('settings.ai.toolPrefs.bulk.ask')
    fireEvent.click(askItem)
    await waitFor(() =>
      expect(mockBulkSetToolPrefs).toHaveBeenCalledWith({ tier: 'ask', group: 'calendar' })
    )
  })

  test('acceptEdits preset + Reset buttons hit their endpoints', async () => {
    mockApplyPreset.mockResolvedValue({ ...payload(), updated: 15 })
    mockResetToolPrefs.mockResolvedValue({ ...payload(), removed: 3 })
    await renderSection()
    fireEvent.click(screen.getByText('settings.ai.toolPrefs.preset'))
    await waitFor(() => expect(mockApplyPreset).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByText('settings.ai.toolPrefs.reset'))
    await waitFor(() => expect(mockResetToolPrefs).toHaveBeenCalledTimes(1))
  })

  test('send whitelist editor parses comma/newline entries and saves', async () => {
    mockSetSendWhitelist.mockResolvedValue(['a@corp.test', '@corp.test'])
    await renderSection()
    const textarea = screen.getByPlaceholderText(
      'settings.ai.toolPrefs.sendWhitelist.placeholder'
    ) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'a@corp.test, @corp.test\n' } })
    fireEvent.click(screen.getByText('settings.ai.toolPrefs.sendWhitelist.save'))
    await waitFor(() =>
      expect(mockSetSendWhitelist).toHaveBeenCalledWith(['a@corp.test', '@corp.test'])
    )
  })
})
