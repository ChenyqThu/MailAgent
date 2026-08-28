// `/settings?tab=` 的枚举单源（task 08-24-l4-nav-shell Step B 从 router-instance 下沉）。
//
// 🔴 为什么是零依赖叶子：通知落地（notifications/navigation.ts 的
// `navigateNotificationRoute`）要 clamp `/settings` 深链的 tab，而它被 router-instance
// import —— 枚举留在 router-instance 就是 import 环（router-instance → navigation →
// router-instance）。issue #68 的纪律：正解是下沉常量，不是照抄一份加句「同源」注释。
// router-instance 原位 re-export，既有消费方（SettingsShell 等）不用动。
//
// Tab order mirrors the user-facing nav (DomainPanel 的设置域行)。

export const SETTINGS_TABS = [
  'general',
  'accounts',
  'sync',
  'ai',
  'connectors',
  'matters',
  'notifications',
  'integrations',
  'realtime',
  'remote',
  'island',
  'labs'
] as const

export type SettingsTab = (typeof SETTINGS_TABS)[number]

/** 非法/缺失值归 'general'（与 settingsRoute.validateSearch 同口径）。 */
export function clampSettingsTab(value: unknown): SettingsTab {
  return typeof value === 'string' && (SETTINGS_TABS as readonly string[]).includes(value)
    ? (value as SettingsTab)
    : 'general'
}
