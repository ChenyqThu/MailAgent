// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))
vi.mock('@shared/components/settings/custom-ai/shared', () => ({
  fetchSkillCreatorEnabled: async () => true
}))
vi.mock('@shared/state/toast', () => ({ toastError: vi.fn() }))

const { listSkillDrafts, getSkillDraft, readSkillDraftFile, publishSkillDraft, discardSkillDraft } = vi.hoisted(() => ({
  listSkillDrafts: vi.fn(),
  getSkillDraft: vi.fn(),
  readSkillDraftFile: vi.fn(),
  publishSkillDraft: vi.fn(),
  discardSkillDraft: vi.fn()
}))
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    chat: {
      listSkillDrafts,
      getSkillDraft,
      readSkillDraftFile,
      publishSkillDraft,
      discardSkillDraft
    }
  })
}))

import { SkillDraftsSection } from '../../src/shared/components/settings/custom-ai/SkillDraftsSection'

function renderUi() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    createElement(QueryClientProvider, { client }, createElement(SkillDraftsSection))
  )
}

beforeEach(() => {
  const draft = {
    id: 'weekly-helper-012345abcdef',
    name: 'weekly-helper',
    status: 'valid',
    manifest: {},
    validation: { valid: true, package_hash: 'abc' },
    sourceSessionId: null,
    createdAt: 1,
    updatedAt: 2,
    files: [{ path: 'SKILL.md', bytes: 20 }]
  }
  listSkillDrafts.mockResolvedValue([draft])
  getSkillDraft.mockResolvedValue(draft)
  readSkillDraftFile.mockResolvedValue('# Weekly helper')
  publishSkillDraft.mockResolvedValue({})
  discardSkillDraft.mockResolvedValue(draft)
  vi.stubGlobal('confirm', vi.fn(() => true))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('SkillDraftsSection', () => {
  test('expands server facts and publishes enabled by default', async () => {
    renderUi()
    await waitFor(() => expect(screen.getByText('weekly-helper')).toBeTruthy())
    fireEvent.click(screen.getByText('weekly-helper'))
    await waitFor(() => expect(screen.getByText('# Weekly helper')).toBeTruthy())
    expect(screen.getByText('SKILL.md')).toBeTruthy()
    fireEvent.click(screen.getByText('settings.skillDrafts.publish'))
    await waitFor(() =>
      expect(publishSkillDraft).toHaveBeenCalledWith('weekly-helper-012345abcdef', true)
    )
  })

  test('discard requires confirmation and calls the owner API', async () => {
    renderUi()
    await waitFor(() => expect(screen.getByText('weekly-helper')).toBeTruthy())
    fireEvent.click(screen.getByText('weekly-helper'))
    await waitFor(() => expect(screen.getByText('settings.skillDrafts.discard')).toBeTruthy())
    fireEvent.click(screen.getByText('settings.skillDrafts.discard'))
    await waitFor(() =>
      expect(discardSkillDraft).toHaveBeenCalledWith('weekly-helper-012345abcdef')
    )
  })
})
