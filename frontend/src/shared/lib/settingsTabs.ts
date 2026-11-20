// `/settings?tab=` 的枚举单源（Phase 2 收敛为 8+1 个分组清晰的 Tab，并保留旧 URL 参数重定）。
//
// 零依赖叶子模块：通知落地（notifications/navigation.ts）、导航注册（navigation/registry.ts）、
// 路由（router-instance.tsx）均只从这里 import。

export const SETTINGS_TABS = [
  'general',
  'accounts',
  'ai',
  'connectors',
  'matters',
  'notifications',
  'integrations',
  'realtime',
  'labs'
] as const

export type SettingsTab = (typeof SETTINGS_TABS)[number]

export type LegacySettingsTab = 'sync' | 'mcp' | 'remote' | 'island'

export const LEGACY_SETTINGS_TAB_MAP: Readonly<Record<LegacySettingsTab, SettingsTab>> = {
  sync: 'accounts',
  mcp: 'connectors',
  remote: 'realtime',
  island: 'notifications'
}

export const LEGACY_SETTINGS_ANCHOR_MAP: Readonly<Record<LegacySettingsTab, string>> = {
  sync: 'settings-accounts-sync',
  mcp: 'settings-connectors-mcp',
  remote: 'settings-realtime-remote',
  island: 'settings-notifications-island'
}

/** 非法/缺失值归 'general'，旧版独立 tab 自动重定向到合并后的目标分节。 */
export function clampSettingsTab(value: unknown): SettingsTab {
  if (typeof value !== 'string') return 'general'
  if ((SETTINGS_TABS as readonly string[]).includes(value)) {
    return value as SettingsTab
  }
  if (value in LEGACY_SETTINGS_TAB_MAP) {
    return LEGACY_SETTINGS_TAB_MAP[value as LegacySettingsTab]
  }
  return 'general'
}

export function legacyAnchorForTab(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value in LEGACY_SETTINGS_ANCHOR_MAP) {
    return LEGACY_SETTINGS_ANCHOR_MAP[value as LegacySettingsTab]
  }
  return undefined
}
