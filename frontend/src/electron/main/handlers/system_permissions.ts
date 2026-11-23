// macOS TCC 权限权威探针与系统设置跳转 IPC（Wave 3，`desktop_use` 诊断用）。
//
// 🔴 为什么必须在 Electron 主进程查而不是纯靠 Python 子进程：macOS TCC 按「拥有 GUI/签名身份的
// 宿主 App bundle」授 Accessibility / Screen Recording 权限；由 Electron 主进程直接调
// `systemPreferences` 比子进程里的 ctypes 探针更权威。非 Electron / 单测环境仍退回
// Python `/api/connector/system-permissions`。

import { desktopCapturer, shell, systemPreferences } from 'electron'

import { typedIpcHandle } from '../ipc/typedHandle'

import {
  SYSTEM_PERMISSIONS_IPC,
  SYSTEM_PERMISSION_URLS,
  type OpenSystemPermissionResult,
  type RequestSystemPermissionResult,
  type SystemPermissionKind,
  type SystemPermissionsStatus,
  type SystemPermissionState
} from '@shared/systemPermissionsIpcContract'

export interface SystemPreferencesProbe {
  isTrustedAccessibilityClient: (prompt: boolean) => boolean
  getMediaAccessStatus: (mediaType: 'microphone' | 'camera' | 'screen') => string
}

export interface ExternalUrlOpener {
  openExternal: (url: string) => Promise<void>
}

export type ScreenCaptureProbe = () => Promise<unknown>

const defaultScreenCaptureProbe: ScreenCaptureProbe = async () => {
  await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1, height: 1 }
  })
}

export function mapScreenMediaStatus(raw: string): SystemPermissionState {
  if (raw === 'granted') return 'granted'
  if (raw === 'denied' || raw === 'restricted') return 'denied'
  return 'unknown'
}

export function isSystemPermissionKind(value: unknown): value is SystemPermissionKind {
  return value === 'accessibility' || value === 'screen_recording'
}

export function probeSystemPermissions(
  platform: NodeJS.Platform = process.platform,
  prefs: SystemPreferencesProbe = systemPreferences
): SystemPermissionsStatus {
  if (platform !== 'darwin') {
    return {
      platform,
      accessibility: 'unsupported',
      screen_recording: 'unsupported',
      source: 'electron'
    }
  }
  let accessibility: SystemPermissionState = 'unknown'
  let screenRecording: SystemPermissionState = 'unknown'
  try {
    accessibility = prefs.isTrustedAccessibilityClient(false) ? 'granted' : 'denied'
  } catch {
    accessibility = 'unknown'
  }
  try {
    screenRecording = mapScreenMediaStatus(prefs.getMediaAccessStatus('screen'))
  } catch {
    screenRecording = 'unknown'
  }
  return {
    platform,
    accessibility,
    screen_recording: screenRecording,
    source: 'electron'
  }
}

export async function openSystemPermissionSettings(
  kind: unknown,
  platform: NodeJS.Platform = process.platform,
  opener: ExternalUrlOpener = shell
): Promise<OpenSystemPermissionResult> {
  if (!isSystemPermissionKind(kind)) {
    return { ok: false, kind: typeof kind === 'string' ? kind : '', opened: false }
  }
  if (platform !== 'darwin') {
    return { ok: true, kind, opened: false }
  }
  try {
    await opener.openExternal(SYSTEM_PERMISSION_URLS[kind])
    return { ok: true, kind, opened: true }
  } catch {
    return { ok: false, kind, opened: false }
  }
}

export async function requestSystemPermissionSettings(
  kind: unknown,
  platform: NodeJS.Platform = process.platform,
  prefs: SystemPreferencesProbe = systemPreferences,
  captureScreen: ScreenCaptureProbe = defaultScreenCaptureProbe,
  opener: ExternalUrlOpener = shell
): Promise<RequestSystemPermissionResult> {
  if (!isSystemPermissionKind(kind)) {
    return {
      ok: false,
      kind: typeof kind === 'string' ? kind : '',
      prompted: false,
      opened: false
    }
  }
  if (platform !== 'darwin') {
    return {
      ok: true,
      kind,
      prompted: false,
      opened: false,
      status: probeSystemPermissions(platform, prefs)
    }
  }

  if (kind === 'accessibility') {
    let prompted = false
    let grantedNow = false
    try {
      grantedNow = prefs.isTrustedAccessibilityClient(true)
      prompted = !grantedNow
    } catch {
      const opened = await openSystemPermissionSettings(kind, platform, opener)
      return {
        ok: opened.ok,
        kind,
        prompted: false,
        opened: opened.opened,
        status: probeSystemPermissions(platform, prefs)
      }
    }
    return {
      ok: true,
      kind,
      prompted,
      opened: false,
      status: probeSystemPermissions(platform, prefs)
    }
  }

  let beforeStatus: SystemPermissionState = 'unknown'
  try {
    beforeStatus = mapScreenMediaStatus(prefs.getMediaAccessStatus('screen'))
  } catch {
    beforeStatus = 'unknown'
  }
  let prompted = false
  try {
    await captureScreen()
    prompted = beforeStatus !== 'granted'
  } catch {
    prompted = false
  }
  const after = probeSystemPermissions(platform, prefs)
  let opened = false
  if (after.screen_recording !== 'granted' && beforeStatus === 'denied') {
    const paneRes = await openSystemPermissionSettings(kind, platform, opener)
    opened = paneRes.opened
  }
  return {
    ok: true,
    kind,
    prompted,
    opened,
    status: after
  }
}

/** 注册系统权限查询与跳转 System Settings IPC（由 `registerSettingsHandlers` 接入启动流）。 */
export function registerSystemPermissionsHandlers(): void {
  typedIpcHandle(
    SYSTEM_PERMISSIONS_IPC.check,
    (): SystemPermissionsStatus => probeSystemPermissions()
  )
  typedIpcHandle(
    SYSTEM_PERMISSIONS_IPC.open,
    (_event, kind: unknown): Promise<OpenSystemPermissionResult> =>
      openSystemPermissionSettings(kind)
  )
  typedIpcHandle(
    SYSTEM_PERMISSIONS_IPC.request,
    (_event, kind: unknown): Promise<RequestSystemPermissionResult> =>
      requestSystemPermissionSettings(kind)
  )
}
