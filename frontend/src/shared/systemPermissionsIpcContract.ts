/**
 * macOS 系统权限（Accessibility / Screen Recording）跨进程契约 —— Electron 主进程 TCC 探针与
 * 渲染层兜底调用共用，防止 IPC channel 名与 System Settings URL 两处漂移。
 */

export type SystemPermissionKind = 'accessibility' | 'screen_recording'

export type SystemPermissionState = 'granted' | 'denied' | 'unknown' | 'unsupported'

export interface SystemPermissionsStatus {
  platform: string
  accessibility: SystemPermissionState
  screen_recording: SystemPermissionState
  /** 诊断来源：Electron 主进程探针或 Python 后端兜底。 */
  source?: 'electron' | 'backend'
}

export interface OpenSystemPermissionResult {
  ok: boolean
  kind: SystemPermissionKind | string
  opened: boolean
}

export const SYSTEM_PERMISSIONS_IPC = {
  check: 'systemPermissions:check',
  open: 'systemPermissions:open'
} as const

export const SYSTEM_PERMISSION_URLS: Record<SystemPermissionKind, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen_recording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
} as const
