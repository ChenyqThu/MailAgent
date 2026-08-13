import { useTranslation } from 'react-i18next'

import { ModelSelectItems } from '@shared/components/agents/drawers/ModelSelectItems'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'
import { useComposerModels } from '@shared/hooks/useComposerModels'

import {
  effortInfoFor,
  MATTER_MODEL_FOLLOW,
  MATTER_MODEL_NO_FALLBACK,
  useMatterModelFields,
  type MatterModelDraft
} from './matterModelDraft'

/**
 * 「模型 / 思考强度 / 备用模型」三件套的**共用控件**（0813 dogfood 轮 3 · B10）。
 *
 * 两处在用：事项级的「跟进规则 → 高级」（覆盖）与全局配置弹窗（默认）。抽出来不是为了少写
 * 几行 JSX —— 是因为 effort 那条门（判定在同目录 `matterModelDraft.ts`）**安全相关**且不
 * 显眼：对没有 reasoning 能力的模型下发 effort，openai / deepseek 协议会往 wire 上塞一个多余
 * 参数（16b 契约）。两个面各写一遍，早晚会有一边漏掉「不适用时不写这个键」，而症状是整轮
 * run 400，不是界面上看得见的错。
 *
 * 差异只在文案：「跟随」那一档在事项级读作「跟随默认」，在全局面读作「不设默认」。所以
 * follow 三档的 i18n key 由调用方给，其余（为什么灰掉 / 透传存疑）共用同一份。
 */

export interface MatterModelFieldsProps {
  /** 三个 label/select 的 id 前缀（同页可能同时挂两份，id 不能撞）。 */
  idPrefix: string
  draft: MatterModelDraft
  onDraftChange(next: MatterModelDraft): void
  /** 「跟随 / 不设」三档的文案 key —— 事项级与全局面读法不同，见文件头。 */
  followKeys: { model: string; effort: string; fallback: string }
  /** 备用模型下面那行说明的 key（两个面解释的是同一个重试语义，但主语不同）。 */
  fallbackHintKey: string
  /** 模型选完之后额外补一行（全局面用来说明 effort 的同模型闸）。 */
  effortFollowHintKey?: string
  disabled?: boolean
}

export function MatterModelFields({
  idPrefix,
  draft,
  onDraftChange,
  followKeys,
  fallbackHintKey,
  effortFollowHintKey,
  disabled = false
}: MatterModelFieldsProps): React.ReactElement {
  const { t } = useTranslation()
  const composerModels = useComposerModels()
  const modelRefs = composerModels.map((option) => option.ref)
  const { modelOverride, effortApplicable } = useMatterModelFields(draft)
  const effortInfo = effortInfoFor(modelOverride, composerModels)
  // 不适用时**显示**成「跟随」而不是留着上一个模型的档位：保存时同样不写这个键，两边一致，
  // 界面上不会出现一个存不下去的选中值。
  const effortValue = effortApplicable ? draft.effort : MATTER_MODEL_FOLLOW

  return (
    <>
      <label
        className="mt-3 block text-meta font-medium text-ink-fg-1"
        htmlFor={`${idPrefix}-model`}
      >
        {t('matters.agentConfig.modelLabel')}
      </label>
      <Select
        value={draft.model}
        disabled={disabled}
        onValueChange={(value) => onDraftChange({ ...draft, model: value })}
      >
        <SelectTrigger id={`${idPrefix}-model`} className="mt-1.5 w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={MATTER_MODEL_FOLLOW}>{t(followKeys.model)}</SelectItem>
          <ModelSelectItems models={modelRefs} current={modelOverride} />
        </SelectContent>
      </Select>

      <label
        className="mt-3 block text-meta font-medium text-ink-fg-1"
        htmlFor={`${idPrefix}-effort`}
      >
        {t('chat.effort.label')}
      </label>
      <Select
        value={effortValue}
        disabled={disabled || !effortApplicable}
        onValueChange={(value) => onDraftChange({ ...draft, effort: value })}
      >
        <SelectTrigger id={`${idPrefix}-effort`} className="mt-1.5 w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={MATTER_MODEL_FOLLOW}>{t(followKeys.effort)}</SelectItem>
          {(effortInfo?.options ?? []).map((tier) => (
            <SelectItem key={tier} value={tier}>
              {t(`chat.effort.tier.${tier}`)}
              {tier === effortInfo?.defaultTier ? (
                <span className="ml-1.5 text-ink-fg-3">{t('chat.effort.default')}</span>
              ) : null}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* 🔴 灰掉必须把「为什么」说出来 —— 一个点不动又不解释的控件正是 owner 这批反馈的
          病根。两种成因文案不同：还没选模型 / 这个模型不支持。 */}
      {!effortApplicable ? (
        <p className="mt-1.5 text-meta leading-5 text-ink-fg-3">
          {modelOverride
            ? t('chat.effort.unsupported')
            : t('matters.agentConfig.effortNeedsModel')}
        </p>
      ) : (
        <>
          {effortInfo?.passthroughUnknown ? (
            <p className="mt-1.5 text-meta leading-5 text-ink-fg-3">{t('chat.effort.hedge')}</p>
          ) : null}
          {effortFollowHintKey ? (
            <p className="mt-1.5 text-meta leading-5 text-ink-fg-3">{t(effortFollowHintKey)}</p>
          ) : null}
        </>
      )}

      <label
        className="mt-3 block text-meta font-medium text-ink-fg-1"
        htmlFor={`${idPrefix}-fallback`}
      >
        {t('matters.agentConfig.fallbackLabel')}
      </label>
      <Select
        value={draft.fallback}
        disabled={disabled}
        onValueChange={(value) => onDraftChange({ ...draft, fallback: value })}
      >
        <SelectTrigger id={`${idPrefix}-fallback`} className="mt-1.5 w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={MATTER_MODEL_FOLLOW}>{t(followKeys.fallback)}</SelectItem>
          <SelectItem value={MATTER_MODEL_NO_FALLBACK}>
            {t('matters.agentConfig.fallbackNone')}
          </SelectItem>
          <ModelSelectItems
            models={modelRefs}
            current={
              draft.fallback === MATTER_MODEL_FOLLOW ||
              draft.fallback === MATTER_MODEL_NO_FALLBACK
                ? null
                : draft.fallback
            }
          />
        </SelectContent>
      </Select>
      <p className="mt-1.5 text-meta leading-5 text-ink-fg-3">{t(fallbackHintKey)}</p>
    </>
  )
}
