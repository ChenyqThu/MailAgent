// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const { navigateMock } = vi.hoisted(() => ({
  navigateMock: vi.fn()
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
  useSearch: () => ({})
}))

vi.mock('@shared/components/connectors/ConnectorsConsolePage', () => ({
  ConnectorsConsolePage: () => (
    <div data-testid="connectors-console-mock">ConnectorsConsoleMock</div>
  )
}))

vi.mock('../../src/shared/components/settings/tabs/McpServiceTab', () => ({
  McpServiceTab: () => <div data-testid="mcp-service-mock">McpServiceMock</div>
}))

import i18n from '@shared/i18n'
import { clampSettingsTab, legacyAnchorForTab } from '@shared/lib/settingsTabs'
import { searchSettingsItems } from '@shared/components/settings/settingsSearchIndex'
import { SettingsSearchBar } from '@shared/components/settings/SettingsSearchBar'
import { ConnectorsTab } from '@shared/components/settings/tabs/ConnectorsTab'

await i18n.changeLanguage('zh-CN')

describe('Phase 2 — Settings tabs legacy redirects', () => {
  test('clampSettingsTab maps legacy tabs and clamps unknown values', () => {
    expect(clampSettingsTab('sync')).toBe('accounts')
    expect(clampSettingsTab('mcp')).toBe('connectors')
    expect(clampSettingsTab('remote')).toBe('realtime')
    expect(clampSettingsTab('island')).toBe('notifications')
    expect(clampSettingsTab('ai')).toBe('ai')
    expect(clampSettingsTab('integrations')).toBe('integrations')
    expect(clampSettingsTab('bogus')).toBe('general')
    expect(clampSettingsTab(undefined)).toBe('general')
  })

  test('legacyAnchorForTab returns expected section anchor IDs', () => {
    expect(legacyAnchorForTab('sync')).toBe('settings-accounts-sync')
    expect(legacyAnchorForTab('mcp')).toBe('settings-connectors-mcp')
    expect(legacyAnchorForTab('remote')).toBe('settings-realtime-remote')
    expect(legacyAnchorForTab('island')).toBe('settings-notifications-island')
    expect(legacyAnchorForTab('ai')).toBeUndefined()
  })
})

describe('Phase 2 — Global settings search index & bar', () => {
  beforeEach(() => {
    navigateMock.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  test('searchSettingsItems matches Ollama, Cloudflare, DavMail, MCP and respects includeMatters', () => {
    expect(searchSettingsItems('Ollama', false).some((e) => e.tab === 'ai')).toBe(true)
    expect(
      searchSettingsItems('Cloudflare', false).some(
        (e) => e.tab === 'realtime' && e.anchorId === 'settings-realtime-remote'
      )
    ).toBe(true)
    expect(searchSettingsItems('DavMail', false).some((e) => e.tab === 'accounts')).toBe(true)
    expect(
      searchSettingsItems('MCP', false).some((e) => e.tab === 'connectors' && e.section === 'mcp')
    ).toBe(true)

    expect(searchSettingsItems('matters', false).some((e) => e.tab === 'matters')).toBe(false)
    expect(searchSettingsItems('matters', true).some((e) => e.tab === 'matters')).toBe(true)
  })

  test('Cmd+F focuses search bar, filters results, navigates and dispatches focus-anchor event', () => {
    const events: CustomEvent<{ id: string }>[] = []
    const onFocusAnchor = (evt: Event) => events.push(evt as CustomEvent<{ id: string }>)
    window.addEventListener('mailagent:focus-anchor', onFocusAnchor)

    try {
      render(<SettingsSearchBar includeMatters={false} />)
      const input = screen.getByRole('combobox') as HTMLInputElement

      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      expect(document.activeElement).toBe(input)

      fireEvent.change(input, { target: { value: 'Cloudflare' } })
      const option = screen.getByRole('option', { name: /CF_AUDIENCE/i })
      fireEvent.click(option)

      expect(navigateMock).toHaveBeenCalledWith({
        to: '/settings',
        search: {
          tab: 'realtime',
          anchor: 'settings-realtime-remote'
        }
      })
      expect(events.map((e) => e.detail.id)).toContain('settings-realtime-remote')
    } finally {
      window.removeEventListener('mailagent:focus-anchor', onFocusAnchor)
    }
  })
})

describe('Phase 2 — ConnectorsTab section switcher', () => {
  afterEach(() => {
    cleanup()
  })

  test('renders ConnectorsConsolePage by default and switches to McpServiceTab', () => {
    const { rerender } = render(<ConnectorsTab />)

    expect(screen.getByTestId('connectors-console-mock')).toBeTruthy()
    expect(screen.queryByTestId('mcp-service-mock')).toBeNull()

    const mcpTab = screen.getByRole('tab', { name: i18n.t('settings.connectorsTab.mcp') })
    fireEvent.click(mcpTab)

    expect(screen.getByTestId('mcp-service-mock')).toBeTruthy()
    expect(document.getElementById('settings-connectors-mcp')).not.toBeNull()

    // Respects prop transitions (e.g. external deep-link / search jump updates initialSection)
    rerender(<ConnectorsTab initialSection="mcp" />)
    expect(screen.getByTestId('mcp-service-mock')).toBeTruthy()

    rerender(<ConnectorsTab initialSection="connectors" />)
    expect(screen.getByTestId('connectors-console-mock')).toBeTruthy()
  })
})
