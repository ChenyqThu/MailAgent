// @vitest-environment happy-dom
//
// UpdateIndicator — TitleBar 更新 icon 按钮 (07-04)。
//   1. idle / checking / not-available / dev-disabled → 不渲染
//   2. available (enabled) → icon + 版本 tooltip; 点击 → api.updater.download()
//   3. downloading → 按钮 disabled (tooltip 带百分比); 点击不触发下载
//   4. downloaded (enabled) → icon + 版本 tooltip; 点击 → api.updater.quitAndInstall()
//   5. error → 回落可点; 点击 → api.updater.download() (重试)
//   6. notifyMode (enabled=false) → 点击开 GitHub Releases, 不调应用内 download

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { UpdaterStatus } from '@shared/api/types'

const mockDownload = vi.fn()
const mockQuitAndInstall = vi.fn()
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    updater: { download: mockDownload, quitAndInstall: mockQuitAndInstall }
  })
}))

import i18n from '@shared/i18n'
import { RELEASE_DOWNLOAD_URL } from '@shared/lib/appReleases'
import { setUpdaterStatus } from '@shared/state/updater'
import { UpdateIndicator } from '@shared/components/layout/UpdateIndicator'

await i18n.changeLanguage('zh-CN')

function seed(patch: Partial<UpdaterStatus>): void {
  setUpdaterStatus({
    state: 'idle',
    enabled: true,
    currentVersion: '1.2.3',
    latestVersion: null,
    downloadPercent: null,
    message: null,
    updatedAt: Date.now(),
    ...patch
  })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  // Reset the shared store so the next case starts from a clean idle state.
  seed({ state: 'idle', latestVersion: null })
})

describe('UpdateIndicator', () => {
  test.each(['idle', 'checking', 'not-available', 'dev-disabled'] as const)(
    'renders nothing in %s state',
    (state) => {
      seed({ state })
      render(<UpdateIndicator />)
      expect(screen.queryByRole('button')).toBeNull()
    }
  )

  test('available → download icon; click triggers api.updater.download()', () => {
    seed({ state: 'available', latestVersion: '1.3.0' })
    render(<UpdateIndicator />)

    const btn = screen.getByRole('button')
    expect(btn.getAttribute('aria-label')).toContain('1.3.0')
    expect(btn.hasAttribute('disabled')).toBe(false)

    fireEvent.click(btn)
    expect(mockDownload).toHaveBeenCalledTimes(1)
    expect(mockQuitAndInstall).not.toHaveBeenCalled()
  })

  test('downloading → disabled button with percent tooltip; click is inert', () => {
    seed({ state: 'downloading', latestVersion: '1.3.0', downloadPercent: 42 })
    render(<UpdateIndicator />)

    const btn = screen.getByRole('button')
    expect(btn.hasAttribute('disabled')).toBe(true)
    expect(btn.getAttribute('aria-label')).toContain('42')

    fireEvent.click(btn)
    expect(mockDownload).not.toHaveBeenCalled()
    expect(mockQuitAndInstall).not.toHaveBeenCalled()
  })

  test('downloaded → install icon; click triggers api.updater.quitAndInstall()', () => {
    seed({ state: 'downloaded', latestVersion: '1.3.0', downloadPercent: 100 })
    render(<UpdateIndicator />)

    const btn = screen.getByRole('button')
    expect(btn.getAttribute('aria-label')).toContain('1.3.0')

    fireEvent.click(btn)
    expect(mockQuitAndInstall).toHaveBeenCalledTimes(1)
    expect(mockDownload).not.toHaveBeenCalled()
  })

  test('error → still renders; click retries download', () => {
    seed({ state: 'error', message: 'GitHub 503' })
    render(<UpdateIndicator />)

    const btn = screen.getByRole('button')
    expect(btn.hasAttribute('disabled')).toBe(false)

    fireEvent.click(btn)
    expect(mockDownload).toHaveBeenCalledTimes(1)
  })

  test('notifyMode (enabled=false) available → opens GitHub Releases, no in-app download', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    seed({ state: 'available', latestVersion: '1.3.0', enabled: false })
    render(<UpdateIndicator />)

    fireEvent.click(screen.getByRole('button'))
    expect(openSpy).toHaveBeenCalledWith(RELEASE_DOWNLOAD_URL, '_blank', 'noopener,noreferrer')
    expect(mockDownload).not.toHaveBeenCalled()
    expect(mockQuitAndInstall).not.toHaveBeenCalled()
    openSpy.mockRestore()
  })

  test('notifyMode (enabled=false) downloaded → opens GitHub Releases, no quitAndInstall', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    seed({ state: 'downloaded', latestVersion: '1.3.0', enabled: false, downloadPercent: 100 })
    render(<UpdateIndicator />)

    fireEvent.click(screen.getByRole('button'))
    expect(openSpy).toHaveBeenCalledWith(RELEASE_DOWNLOAD_URL, '_blank', 'noopener,noreferrer')
    expect(mockQuitAndInstall).not.toHaveBeenCalled()
    openSpy.mockRestore()
  })
})
