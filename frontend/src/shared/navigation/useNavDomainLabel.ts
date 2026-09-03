// task 09-02 misc10a — 域标签求值（hook 版）。
//
// registry.ts 是零 hooks 依赖的叶子模块，它的 `navDomainLabel()` 拿不到 assistant
// identity，`NavLabel` 的 `assistantIdentity` 形态在那里只能回落 i18n。这个 hook 补上
// identity 读取：三处域标签渲染点（IconRail 格 / DomainPanel 头 / TabStrip 主标签面包屑）
// 统一走它，不各写一份「取名字，取不到就 t(fallback)」。

import { useTranslation } from 'react-i18next'

import { useAssistantIdentity } from '@shared/assistant/assistantIdentity'

import { NAV_DOMAINS, type NavDomain } from './registry'

export function useNavDomainLabel(domain: NavDomain): string {
  const { t } = useTranslation()
  const identity = useAssistantIdentity()
  const label = NAV_DOMAINS[domain].label
  if ('assistantIdentity' in label) {
    const name = identity.name?.trim()
    return name !== undefined && name !== '' ? name : t(label.fallbackI18nKey)
  }
  return 'i18nKey' in label ? t(label.i18nKey) : label.literal
}
