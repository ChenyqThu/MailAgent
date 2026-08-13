import type { MatterAgentOverrides } from '@shared/api/types/matter'
import { useComposerModels, type ComposerModelOption } from '@shared/hooks/useComposerModels'
import { stripProviderPrefix } from '@shared/hooks/useLlmProviders'
import { effortOptionsForModel, type EffortModelOptions } from '@shared/modelCatalog/effort'

/**
 * 「模型 / 思考强度 / 备用模型」三件套的**共用判定**（0813 dogfood 轮 3 · B10）。
 *
 * 两处在用：事项级的「跟进规则 → 高级」（覆盖）与全局配置弹窗（默认）。控件在同目录的
 * `MatterModelFields.tsx`；判定单独成文件不只是为了 fast-refresh 那条 lint —— 它本身就是
 * 这个模块里唯一**安全相关**的部分：档位阶梯按模型家族给（`effortOptionsForModel`），而对
 * 没有 reasoning 能力的模型下发 effort，openai / deepseek 协议会往 wire 上塞一个多余参数
 * （16b 契约）。两个面各写一遍，早晚会有一边漏掉「不适用时不写这个键」，而症状是整轮 run
 * 400，不是界面上看得见的错。
 *
 * 🔴 跨层还有一条同源纪律在 Python 侧（`src/matters/run_spec.py`）：全局那一档只在最终跑的
 * 模型就是全局默认模型时才下发 —— 否则「事项换了模型 + 全局配过档位」会绕过这里的门。
 */

/** 三项共用的「跟随 / 不设」哨兵（= 块里不写该键）。 */
export const MATTER_MODEL_FOLLOW = '__follow__'
/** 备用模型专属：**显式不设兜底**（= 块里写 `fallback_models: []`）。与「跟随」不是一回事
 *  —— 前者会压过下一层的兜底链，后者跟着它走。 */
export const MATTER_MODEL_NO_FALLBACK = '__no_fallback__'

export interface MatterModelDraft {
  model: string
  effort: string
  fallback: string
}

/** 存储块 → 三个 select 的草稿值（哨兵化）。 */
export function matterModelDraftFrom(
  block: MatterAgentOverrides | null | undefined
): MatterModelDraft {
  const saved = block ?? {}
  return {
    model: saved.model ?? MATTER_MODEL_FOLLOW,
    effort: saved.effort ?? MATTER_MODEL_FOLLOW,
    fallback:
      saved.fallback_models === undefined
        ? MATTER_MODEL_FOLLOW
        : saved.fallback_models.length === 0
          ? MATTER_MODEL_NO_FALLBACK
          : saved.fallback_models[0]
  }
}

export interface MatterModelFieldsState {
  /** 选中的模型（`null` = 跟随）。 */
  modelOverride: string | null
  /** 「思考强度」这个控件此刻是否适用（未选模型 / 该模型无 reasoning 能力 → false）。 */
  effortApplicable: boolean
  /** 当前草稿归一化后的存储块。全是「跟随」⇒ `{}`（调用方据此不写这个键）。 */
  block: MatterAgentOverrides
  /** 这三项里实际配了几项（事项级用来显示「N 项覆盖」）。 */
  configuredCount: number
  /** 任意草稿 → 存储块。给「改一下就存一次」的面用（它要的是**下一个**草稿的块，而 hook
   *  不能按需再调一次）。 */
  blockFor(next: MatterModelDraft): MatterAgentOverrides
}

/** 选中模型的 effort 档位信息（`null` = 没选模型）。 */
export function effortInfoFor(
  modelRef: string | null,
  models: readonly ComposerModelOption[]
): EffortModelOptions | null {
  if (!modelRef) return null
  const selected = models.find((option) => option.ref === modelRef) ?? null
  // 「行权威、目录兜底」与 composer 同一叠加方向：provider 行标注过就用行的，没标注传 null
  // 交给目录三态（🔴 unknown ≠ false，不许把没标注的模型当不支持灰死）。
  return effortOptionsForModel(
    // 存的是完整 providerRef；孤儿值（模型被从启用列表里去掉了）在 composerModels 里查
    // 不到，所以退回同一个 canonical 去前缀函数，而不是就地再写一遍切分。
    selected?.modelId ?? stripProviderPrefix(modelRef),
    selected?.protocol ?? null,
    {
      reasoningCapable:
        selected?.capabilities == null ? null : selected.capabilities.reasoning === true
    }
  )
}

/** 草稿 → 派生状态。🔴 `MatterModelFields` 与两个调用面**共用这一份判定**，别另写一遍。 */
export function useMatterModelFields(draft: MatterModelDraft): MatterModelFieldsState {
  const composerModels = useComposerModels()

  const blockFor = (next: MatterModelDraft): MatterAgentOverrides => {
    const modelRef = next.model === MATTER_MODEL_FOLLOW ? null : next.model
    const applicable = effortInfoFor(modelRef, composerModels)?.applicable === true
    const block: MatterAgentOverrides = {}
    if (modelRef) block.model = modelRef
    // 🔴 只在真能生效时才写：不适用的模型上存一个档位 = 保存了但不生效（还可能让 run 400）。
    if (applicable && next.effort !== MATTER_MODEL_FOLLOW) block.effort = next.effort
    if (next.fallback === MATTER_MODEL_NO_FALLBACK) block.fallback_models = []
    else if (next.fallback !== MATTER_MODEL_FOLLOW) block.fallback_models = [next.fallback]
    return block
  }

  const modelOverride = draft.model === MATTER_MODEL_FOLLOW ? null : draft.model
  const effortApplicable = effortInfoFor(modelOverride, composerModels)?.applicable === true
  const block = blockFor(draft)

  return {
    modelOverride,
    effortApplicable,
    block,
    configuredCount:
      (block.model ? 1 : 0) +
      (block.effort ? 1 : 0) +
      (block.fallback_models === undefined ? 0 : 1),
    blockFor
  }
}
