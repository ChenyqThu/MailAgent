// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))
const pluginFlag = vi.hoisted(() => ({ enabled: false }))
vi.mock('@shared/components/settings/custom-ai/shared', () => ({
  fetchSkillCreatorEnabled: async () => true,
  fetchAgentPluginsEnabled: async () => pluginFlag.enabled
}))
vi.mock('@shared/state/toast', () => ({ toastError: vi.fn() }))

const { listSkillDrafts, getSkillDraft, readSkillDraftFile, publishSkillDraft, discardSkillDraft, importAgentPlugin } = vi.hoisted(() => ({
  listSkillDrafts: vi.fn(),
  getSkillDraft: vi.fn(),
  readSkillDraftFile: vi.fn(),
  publishSkillDraft: vi.fn(),
  discardSkillDraft: vi.fn(),
  importAgentPlugin: vi.fn()
}))
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    chat: {
      listSkillDrafts,
      getSkillDraft,
      readSkillDraftFile,
      publishSkillDraft,
      discardSkillDraft,
      importAgentPlugin
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
  pluginFlag.enabled = false
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
  importAgentPlugin.mockResolvedValue({ plugin: { name: 'demo', source: 'upload' }, skills: [], mcpServers: [] })
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

  test('plugin import entry follows the agent plugins flag', async () => {
    pluginFlag.enabled = true
    const { container } = renderUi()
    expect(await screen.findByText('settings.skillDrafts.pluginImport')).toBeTruthy()
    expect(container.querySelector('input[type="file"][accept*=".zip"]')).toBeTruthy()
  })

  test('plugin import entry is hidden when the flag is off', async () => {
    renderUi()
    await waitFor(() => expect(screen.getByText('weekly-helper')).toBeTruthy())
    expect(screen.queryByText('settings.skillDrafts.pluginImport')).toBeNull()
  })

  test('plugin import renders component outcomes and detected MCP servers', async () => {
    pluginFlag.enabled = true
    importAgentPlugin.mockResolvedValue({
      plugin: { name: 'mixed-plugin', version: '1.0.0', source: 'upload' },
      skills: [
        { path: 'skills/good', status: 'ready', draftId: 'good-012345abcdef' },
        { path: 'skills/bad', status: 'invalid', errors: ['SKILL.md is empty'] },
        { path: 'skills/中文', status: 'unsupported', errors: ['name is unsupported'] }
      ],
      mcpServers: [{ name: 'calendar-mcp', status: 'detected_not_imported' }]
    })
    const { container } = renderUi()
    await screen.findByText('settings.skillDrafts.pluginImport')
    const input = container.querySelector('input[type="file"]')
    if (!(input instanceof HTMLInputElement)) throw new Error('plugin file input missing')
    const file = new File([new Uint8Array([1, 2, 3])], 'plugin.zip', { type: 'application/zip' })
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(importAgentPlugin).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('skills/good: ready')).toBeTruthy()
    expect(screen.getByText(/skills\/bad: invalid/)).toBeTruthy()
    expect(screen.getByText(/SKILL\.md is empty/)).toBeTruthy()
    expect(screen.getByText(/skills\/中文: unsupported/)).toBeTruthy()
    expect(screen.getByText(/name is unsupported/)).toBeTruthy()
    expect(screen.getByText('settings.skillDrafts.mcpDetected')).toBeTruthy()
  })
})
