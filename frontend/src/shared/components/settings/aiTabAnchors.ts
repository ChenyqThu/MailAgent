// 设置-AI 页的锚点清单（08-01 PR4 · T2 lane）—— 右侧 SectionAnchorNav 的单一事实源。
//
// 为什么单独一个模块：id 要在**两个地方**用上 —— AiTab（自己那几个 Section 的外裹
// wrapper）与 CustomAiSection（Custom AI 家族那几个），再加上组装给 SectionAnchorNav 的
// items 清单。三处手抄同一串字面量 = 改一处漏两处、导航条目静默消失（组件会把找不到
// 目标的条目过滤掉，所以漏了**不会报错**，只会安静地少一行）。故 id 落在这里，两个
// 消费方都从这里读。
//
// 🔴 `skillPacks` / `exec` 两个 id 是**存量**的（SystemCapabilitiesSection 的交叉引用
// 跳转在消费），所以从 SYSTEM_CAP_SCROLL_TARGETS **导入**而不是重打一遍字面量 —— 那两
// 个字符串已经有 owner 了，这里再抄一份就是第二处手抄。它们已下沉到零依赖叶子
// ./custom-ai/scrollTargets（本模块因此不必为两个字符串把整棵组件依赖树拉进来）。
//
// items 是**静态候选**清单：受 flag 门控整体 return null 的区块（模型服务 / connectors /
// 技能包 / user.md 编译 / 身份文档 / 自动化策略）照常列在这里，由 SectionAnchorNav 在运
// 行时按「目标元素存在且 offsetHeight > 0」过滤。

import * as React from 'react'
import { useTranslation } from 'react-i18next'

import type { SectionAnchorItem } from '@shared/components/ui/section-anchor-nav'

import { SYSTEM_CAP_SCROLL_TARGETS } from './custom-ai/scrollTargets'

/** 设置-AI 各区块的锚点 id。值即 DOM id，外裹 wrapper 用它，nav 用它跳转。 */
export const AI_TAB_ANCHOR_IDS = {
  modelServices: 'settings-ai-model-services',
  gateway: 'settings-ai-gateway',
  translate: 'settings-ai-translate',
  cache: 'settings-ai-cache',
  autoTitle: 'settings-ai-auto-title',
  approval: 'settings-ai-approval',
  skills: 'settings-ai-skills',
  connectors: 'settings-ai-connectors',
  imFeishu: 'settings-ai-im-feishu',
  systemCapabilities: 'settings-ai-system-capabilities',
  skillPacks: SYSTEM_CAP_SCROLL_TARGETS.skillPacks,
  memory: 'settings-ai-memory',
  userMdCompile: 'settings-ai-user-md-compile',
  memoryCaptureModel: 'settings-ai-memory-capture-model',
  standingDocs: 'settings-ai-standing-docs',
  execPolicy: SYSTEM_CAP_SCROLL_TARGETS.exec
} as const

/** sticky RestartBanner（`sticky top-0`，py-3 + h-7 按钮 ≈ 56px）会盖住 scrollIntoView 的
 *  落点 —— SectionAnchorNav **有意不做**偏移补偿，由目标元素自己的 scroll-margin-top 负责。
 *  64px 给了一档余量。 */
export const AI_TAB_ANCHOR_SCROLL_MT = 'scroll-mt-16'

/** 单个 provider 卡的锚点 id（比「模型服务」整区更精确的落点）。
 *  🔴 两处消费：`ProviderCard` 的根元素挂它，composer 模型选择器的组标题齿轮跳它 —— 故
 *  必须是函数不是字面量，否则第二处就是手抄（provider id 由用户自定义，值域无限）。
 *  provider id 允许出现 CSS/id 里合法但选择器不友好的字符，这里只做 id 属性用（走
 *  `getElementById`，不进 querySelector），无需转义。 */
export function llmProviderAnchorId(providerId: string): string {
  return `settings-ai-llm-provider-${providerId}`
}

/** 设置页在**另一条路由**上，AiTab 要等这次导航之后才挂载 —— 所以不是「navigate 完就
 *  scrollIntoView」（那一刻目标元素还不存在，滚了个寂寞），而是有界地等它出现。
 *
 *  `fallbackId` 用于「精确落点可能不存在」的深链（如按 provider id 跳某张卡，而那个 provider
 *  刚被删掉）：主目标等满预算仍没出现就退到它。都找不到就安静放弃 —— 用户此时已经在 AI tab
 *  上，最坏是自己往下滚一屏，而不是留一个永不结束的轮询。 */
export function scrollToAnchorWhenReady(id: string, fallbackId?: string, budgetMs = 2000): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return
  const deadline = Date.now() + budgetMs
  const tick = (): void => {
    const el = document.getElementById(id)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    if (Date.now() < deadline) {
      window.requestAnimationFrame(tick)
      return
    }
    const fallback = fallbackId ? document.getElementById(fallbackId) : null
    fallback?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  window.requestAnimationFrame(tick)
}

/** 锚点条目（label 复用各区块自己的标题 key —— 导航文案与区块标题永远一致，不另起一套）。 */
export function useAiTabAnchorItems(): SectionAnchorItem[] {
  const { t } = useTranslation()
  return React.useMemo(
    () => [
      { id: AI_TAB_ANCHOR_IDS.modelServices, label: t('settings.providers.title') },
      { id: AI_TAB_ANCHOR_IDS.gateway, label: t('settings.ai.title') },
      { id: AI_TAB_ANCHOR_IDS.translate, label: t('settings.ai.translate.title') },
      { id: AI_TAB_ANCHOR_IDS.cache, label: t('settings.ai.cache.title') },
      { id: AI_TAB_ANCHOR_IDS.autoTitle, label: t('settings.ai.autoTitle.title') },
      { id: AI_TAB_ANCHOR_IDS.approval, label: t('settings.ai.approval.title') },
      { id: AI_TAB_ANCHOR_IDS.skills, label: t('settings.skills.title') },
      { id: AI_TAB_ANCHOR_IDS.connectors, label: t('settings.connectors.title') },
      { id: AI_TAB_ANCHOR_IDS.imFeishu, label: t('settings.imFeishu.title') },
      { id: AI_TAB_ANCHOR_IDS.systemCapabilities, label: t('settings.systemCapabilities.title') },
      { id: AI_TAB_ANCHOR_IDS.skillPacks, label: t('settings.skillPacks.title') },
      { id: AI_TAB_ANCHOR_IDS.memory, label: t('settings.aiMemory.title') },
      { id: AI_TAB_ANCHOR_IDS.userMdCompile, label: t('settings.userMdCompile.title') },
      { id: AI_TAB_ANCHOR_IDS.memoryCaptureModel, label: t('settings.memoryCaptureModel.title') },
      { id: AI_TAB_ANCHOR_IDS.standingDocs, label: t('settings.standingDocs.title') },
      { id: AI_TAB_ANCHOR_IDS.execPolicy, label: t('settings.execPolicy.title') }
    ],
    [t]
  )
}
