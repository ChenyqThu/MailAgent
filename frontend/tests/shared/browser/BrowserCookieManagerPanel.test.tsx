// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import i18n from '@shared/i18n'

await i18n.changeLanguage('zh-CN')

const toastSuccessMock = vi.fn()
const toastErrorMock = vi.fn()

vi.mock('@shared/state/toast', () => ({
  toastSuccess: toastSuccessMock,
  toastError: toastErrorMock,
  toastInfo: vi.fn()
}))

const mockManagedCookieDomains = vi.fn()
const mockClearManagedCookies = vi.fn()
const mockChromeProfiles = vi.fn()
const mockChromeCookieDomains = vi.fn()
const mockImportChromeCookies = vi.fn()

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    connector: {
      managedCookieDomains: mockManagedCookieDomains,
      clearManagedCookies: mockClearManagedCookies,
      chromeProfiles: mockChromeProfiles,
      chromeCookieDomains: mockChromeCookieDomains,
      importChromeCookies: mockImportChromeCookies
    }
  })
}))

const { BrowserCookieManagerPanel } = await import(
  '@shared/components/browser/BrowserCookieManagerPanel'
)

beforeEach(() => {
  toastSuccessMock.mockReset()
  toastErrorMock.mockReset()
  mockManagedCookieDomains.mockReset()
  mockClearManagedCookies.mockReset()
  mockChromeProfiles.mockReset()
  mockChromeCookieDomains.mockReset()
  mockImportChromeCookies.mockReset()

  mockManagedCookieDomains.mockResolvedValue({
    domains: [
      { domain: 'notion.so', count: 4 },
      { domain: 'oa.internal', count: 2 }
    ],
    total_cookies: 6
  })
  mockClearManagedCookies.mockResolvedValue({ cleared: 4, domain: 'notion.so' })
  mockChromeProfiles.mockResolvedValue({
    profiles: [{ profile_id: 'Default', name: 'Personal', user_name: 'u@corp.com', has_cookies: true }]
  })
  mockChromeCookieDomains.mockResolvedValue({
    profile_id: 'Default',
    domains: [
      { domain: 'github.com', count: 5, sensitive: false },
      { domain: 'oa.internal', count: 3, sensitive: false },
      { domain: 'chase.com', count: 2, sensitive: true }
    ],
    total_cookies: 10
  })
  mockImportChromeCookies.mockResolvedValue({
    ok: true,
    profile_id: 'Default',
    matched: 8,
    imported: 8,
    skipped: 0
  })
})

afterEach(() => {
  cleanup()
})

describe('BrowserCookieManagerPanel', () => {
  test('lists stored login domains, clears single domain and all domains with confirmation', async () => {
    render(<BrowserCookieManagerPanel initialTab="stored" />)

    await screen.findByText('notion.so')
    expect(screen.getByText('oa.internal')).toBeTruthy()

    const clearNotionBtn = screen.getByLabelText('清除此站点登录态 notion.so')
    fireEvent.click(clearNotionBtn)

    await waitFor(() => {
      expect(mockClearManagedCookies).toHaveBeenCalledWith({ domain: 'notion.so' })
    })

    // Two-step clear all
    fireEvent.click(screen.getByRole('button', { name: '清除全部登录态' }))
    const confirmBtn = screen.getByRole('button', { name: /确认清空全部/ })
    fireEvent.click(confirmBtn)
    await waitFor(() => {
      expect(mockClearManagedCookies).toHaveBeenCalledWith({})
    })
  })

  test('pre-selects non-sensitive Chrome domains, supports selection toggles, and imports domain subset', async () => {
    const onImported = vi.fn()
    render(<BrowserCookieManagerPanel initialTab="import" onImported={onImported} />)

    await screen.findByText('github.com')
    expect(screen.getByText('敏感/金融')).toBeTruthy()

    const githubBox = screen.getByRole('checkbox', { name: /github\.com/ })
    const chaseBox = screen.getByRole('checkbox', { name: /chase\.com/ })
    expect(githubBox.getAttribute('aria-checked')).toBe('true')
    expect(chaseBox.getAttribute('aria-checked')).toBe('false')

    // Clear selection -> import button disabled
    fireEvent.click(screen.getByRole('button', { name: '清空选择' }))
    const importBtn = screen.getByRole('button', { name: /导入所选登录态/ }) as HTMLButtonElement
    expect(importBtn.disabled).toBe(true)

    // Select non-sensitive again -> 2 selected -> submit
    fireEvent.click(screen.getByRole('button', { name: '全选非敏感' }))
    expect(importBtn.disabled).toBe(false)
    fireEvent.click(importBtn)

    await waitFor(() => {
      expect(mockImportChromeCookies).toHaveBeenCalledWith({
        profile_id: 'Default',
        domain_filters: ['github.com', 'oa.internal']
      })
    })
    expect(onImported).toHaveBeenCalledTimes(1)
    // Switches back to stored tab after import
    await screen.findByText('notion.so')
  })
})
