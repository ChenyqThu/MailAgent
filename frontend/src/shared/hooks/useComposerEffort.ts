// WP-16b（task 08-05 P1）—— composer effort 档位的**面板侧状态**：当前模型该给哪几档、现在
// 生效哪一档、请求体该发什么。16a 内核（`@shared/modelCatalog/effort` + `effortTiers`）是纯
// 查询与词表，本 hook 只把它接到两个 panel 的 model state 与 localStorage pref 上。
//
// 🔴 **16a 硬契约（effort.ts `EffortModelOptions.applicable` 的字段注释）**：applicable === false
// ⇒ 请求体**不得携带 `effort` 键**（连 'none' 也不塞，走旧路径）。所以 `bodyTier` 在这一档
// 恒 `undefined`，而不是 `'none'` —— 判据只认这个布尔，绝不在调用方重新比对 options 数组。
//
// 🔴 **S2 拍板（prd「S2 已拍板」①）**：pref 为空 ⇒ **主动下发家族 defaultTier**（applicable 时）。
// 这是一次有意的行为反转：Claude 从「默认不思考」变成「默认 medium thinking」。旧 Brain 布尔
// （`body.thinking`）自本批起不再由任何 UI 发出，但 gateway 的 legacy 分支保留（island resume
// 回放冻结的 originalBody 仍可能带它）。
//
// 持久化沿用 16a 的 `readEffortPref` / `writeEffortPref`（全局 localStorage 一个键，镜像旧
// Brain 布尔的 THINKING_PREF 纪律），不是 per-session —— 与模型偏好（per-session）刻意不同：
// 「我想让 AI 多想一点」是使用习惯，不是某个会话的属性。

import { useCallback, useMemo, useState } from 'react'

import { stripProviderPrefix } from '@shared/hooks/useLlmProviders'
import { effortOptionsForModel, readEffortPref, writeEffortPref } from '@shared/modelCatalog/effort'
import { effortTierIndex, type EffortTier } from '@shared/modelCatalog/effortTiers'

import type { ComposerModelOption } from './useComposerModels'

/** composer effort 菜单要的一切（渲染 + 选档）。放进 `ChatComposerControls.effort`。 */
export interface ComposerEffortControl {
  /** 当前模型可选的档位（升序）。applicable=false 时无意义（菜单不该开）。 */
  options: EffortTier[]
  /** false = 这个模型没有 reasoning 能力 ⇒ 控件不适用（灰掉）+ 请求体不带 effort 键。 */
  applicable: boolean
  /** true = 不敢担保档位真的生效（目录未命中 / 方言与协议错配的中转）→ UI 给一句 hedge。 */
  passthroughUnknown: boolean
  /** 家族默认档（菜单里标「默认」）。 */
  defaultTier: EffortTier
  /** 当前生效档（= pref 收进 options 后的结果；pref 为空 → defaultTier）。 */
  selected: EffortTier
  /** 用户选档：写全局 pref（下一轮请求即用新档）。 */
  onSelect: (tier: EffortTier) => void
}

export interface ComposerEffort {
  control: ComposerEffortControl
  /** 请求体 `effort` 字段的值；`undefined` = **不带这个键**（applicable=false，见文件头硬契约）。 */
  bodyTier: EffortTier | undefined
}

/** 把一个（可能来自别的模型的）全局 pref 收进当前模型的可选档。
 *
 *  pref 恰好可选 → 原样；否则**向下取最近的可选档**（`max` 落到 Gemini 的 `high`，而不是跳回
 *  家族默认 `low`）—— 用户设过「多想一点」的意图应当尽量保住；比所有可选档都低（如在只有
 *  low..max 的 adaptive Claude 上带着 `none`）→ 取最低的一档。pref 为空 = 用户从没选过 →
 *  家族默认档（S2 拍板：这一档要主动下发，不是「不发」）。 */
export function resolveEffortTier(
  pref: EffortTier | null,
  options: readonly EffortTier[],
  defaultTier: EffortTier
): EffortTier {
  if (options.length === 0) return defaultTier
  if (pref === null) return defaultTier
  if (options.includes(pref)) return pref
  const wanted = effortTierIndex(pref)
  let best: EffortTier | null = null
  // options 恒升序（16a 按 canonical 序过滤家族阶梯而来）。
  for (const tier of options) {
    if (effortTierIndex(tier) <= wanted) best = tier
  }
  return best ?? options[0]
}

/** 两个 panel（AiChatPanel / AgentConversation）共用的 effort state。
 *
 *  `model` 是完整 providerRef（`providerId:modelId`），`availableModels` 提供 protocol 与
 *  capabilities（**行权威、目录兜底**已经在 useComposerModels 里合并过，这里直接读合并结果）。 */
export function useComposerEffort({
  model,
  availableModels
}: {
  model: string | null
  availableModels: readonly ComposerModelOption[]
}): ComposerEffort {
  const [pref, setPref] = useState<EffortTier | null>(() => readEffortPref())

  const option = model === null ? null : (availableModels.find((o) => o.ref === model) ?? null)
  const modelId = option?.modelId ?? (model === null ? '' : stripProviderPrefix(model))
  const protocol = option?.protocol ?? null
  // 三态照搬 16a 的口径：capabilities 对象在 = 显式标注过（`reasoning !== true` 就是不支持）；
  // 对象为 null = 上游与目录都没标 → null 交给 16a 落回目录查表（**unknown ≠ false**）。
  const rowReasoning = option?.capabilities == null ? null : option.capabilities.reasoning === true

  const meta = useMemo(
    () => effortOptionsForModel(modelId, protocol, { reasoningCapable: rowReasoning }),
    [modelId, protocol, rowReasoning]
  )

  const onSelect = useCallback((tier: EffortTier): void => {
    setPref(tier)
    writeEffortPref(tier)
  }, [])

  // 🔴 `model === null` = 只读的 legacy 会话 / 还没有模型可谈（gateway 用它自己的默认模型）——
  // 既然连模型 id 都没有，就谈不上「这个模型该给哪几档」，更不该把一个猜出来的档位发给一个
  // 我们不知道是谁的上游。按「不适用」处理（控件灰掉 + 请求体不带 effort 键）。
  const applicable = model !== null && meta.applicable
  const selected = resolveEffortTier(pref, meta.options, meta.defaultTier)

  const control = useMemo<ComposerEffortControl>(
    () => ({
      options: meta.options,
      applicable,
      passthroughUnknown: meta.passthroughUnknown,
      defaultTier: meta.defaultTier,
      selected,
      onSelect
    }),
    [meta, applicable, selected, onSelect]
  )

  return { control, bodyTier: applicable ? selected : undefined }
}
