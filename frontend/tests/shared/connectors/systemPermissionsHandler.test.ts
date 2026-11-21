// @vitest-environment node
//
// Wave 3 — Electron 主进程 TCC 权威探针与 System Settings 跳转 IPC 单测。

import { beforeEach, describe, expect, test, vi } from 'vitest'

const { handleMock, openExternalMock, isTrustedMock, getMediaMock, getSourcesMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  openExternalMock: vi.fn(),
  isTrustedMock: vi.fn(),
  getMediaMock: vi.fn(),
  getSourcesMock: vi.fn()
}))

vi.mock('electron', () => ({
  desktopCapturer: { getSources: getSourcesMock },
  ipcMain: { handle: handleMock },
  shell: { openExternal: openExternalMock },
  systemPreferences: {
    isTrustedAccessibilityClient: isTrustedMock,
    getMediaAccessStatus: getMediaMock
  }
}))

import {
  mapScreenMediaStatus,
  openSystemPermissionSettings,
  probeSystemPermissions,
  registerSystemPermissionsHandlers,
  requestSystemPermissionSettings
} from '../../../src/electron/main/handlers/system_permissions'
import {
  SYSTEM_PERMISSIONS_IPC,
  SYSTEM_PERMISSION_URLS
} from '../../../src/shared/systemPermissionsIpcContract'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('system_permissions Electron handler', () => {
  test('mapScreenMediaStatus 正确收敛 Electron MediaAccessStatus', () => {
    expect(mapScreenMediaStatus('granted')).toBe('granted')
    expect(mapScreenMediaStatus('denied')).toBe('denied')
    expect(mapScreenMediaStatus('restricted')).toBe('denied')
    expect(mapScreenMediaStatus('not-determined')).toBe('unknown')
    expect(mapScreenMediaStatus('unknown')).toBe('unknown')
  })

  test('darwin 下查询 isTrustedAccessibilityClient(false) 与 getMediaAccessStatus("screen")', () => {
    const prefs = {
      isTrustedAccessibilityClient: vi.fn(() => true),
      getMediaAccessStatus: vi.fn(() => 'denied')
    }
    const out = probeSystemPermissions('darwin', prefs)
    expect(prefs.isTrustedAccessibilityClient).toHaveBeenCalledWith(false)
    expect(prefs.getMediaAccessStatus).toHaveBeenCalledWith('screen')
    expect(out).toEqual({
      platform: 'darwin',
      accessibility: 'granted',
      screen_recording: 'denied',
      source: 'electron'
    })
  })

  test('非 darwin 平台优雅返回 unsupported', () => {
    const prefs = {
      isTrustedAccessibilityClient: vi.fn(() => true),
      getMediaAccessStatus: vi.fn(() => 'granted')
    }
    expect(probeSystemPermissions('win32', prefs)).toEqual({
      platform: 'win32',
      accessibility: 'unsupported',
      screen_recording: 'unsupported',
      source: 'electron'
    })
    expect(prefs.isTrustedAccessibilityClient).not.toHaveBeenCalled()
  })

  test('openSystemPermissionSettings 严格白名单放行并在 darwin 调 shell.openExternal', async () => {
    const opener = { openExternal: vi.fn(async () => {}) }

    const acc = await openSystemPermissionSettings('accessibility', 'darwin', opener)
    expect(acc).toEqual({ ok: true, kind: 'accessibility', opened: true })
    expect(opener.openExternal).toHaveBeenCalledWith(SYSTEM_PERMISSION_URLS.accessibility)

    const screenRes = await openSystemPermissionSettings('screen_recording', 'darwin', opener)
    expect(screenRes).toEqual({ ok: true, kind: 'screen_recording', opened: true })
    expect(opener.openExternal).toHaveBeenCalledWith(SYSTEM_PERMISSION_URLS.screen_recording)

    const bad = await openSystemPermissionSettings('arbitrary', 'darwin', opener)
    expect(bad).toEqual({ ok: false, kind: 'arbitrary', opened: false })
    expect(opener.openExternal).toHaveBeenCalledTimes(2)

    const nonMac = await openSystemPermissionSettings('accessibility', 'linux', opener)
    expect(nonMac).toEqual({ ok: true, kind: 'accessibility', opened: false })
  })

  test('requestSystemPermissionSettings 触发原生授权或回退系统设置', async () => {
    const prefs = {
      isTrustedAccessibilityClient: vi.fn((_prompt: boolean) => false),
      getMediaAccessStatus: vi.fn(() => 'not-determined')
    }
    const opener = { openExternal: vi.fn(async () => {}) }
    const captureScreen = vi.fn(async () => [])

    const acc = await requestSystemPermissionSettings(
      'accessibility',
      'darwin',
      prefs,
      captureScreen,
      opener
    )
    expect(prefs.isTrustedAccessibilityClient).toHaveBeenCalledWith(true)
    expect(acc).toMatchObject({
      ok: true,
      kind: 'accessibility',
      prompted: true,
      opened: false,
      status: { accessibility: 'denied' }
    })

    const scrPrompt = await requestSystemPermissionSettings(
      'screen_recording',
      'darwin',
      prefs,
      captureScreen,
      opener
    )
    expect(captureScreen).toHaveBeenCalledTimes(1)
    expect(opener.openExternal).not.toHaveBeenCalled()
    expect(scrPrompt.prompted).toBe(true)
    expect(scrPrompt.opened).toBe(false)

    prefs.getMediaAccessStatus.mockReturnValue('denied')
    const scrDenied = await requestSystemPermissionSettings(
      'screen_recording',
      'darwin',
      prefs,
      captureScreen,
      opener
    )
    expect(opener.openExternal).toHaveBeenCalledWith(SYSTEM_PERMISSION_URLS.screen_recording)
    expect(scrDenied.opened).toBe(true)
    expect(scrDenied.status?.screen_recording).toBe('denied')
  })

  test('registerSystemPermissionsHandlers 注册三个 IPC 通道', () => {
    registerSystemPermissionsHandlers()
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toEqual([
      SYSTEM_PERMISSIONS_IPC.check,
      SYSTEM_PERMISSIONS_IPC.open,
      SYSTEM_PERMISSIONS_IPC.request
    ])
  })
})
